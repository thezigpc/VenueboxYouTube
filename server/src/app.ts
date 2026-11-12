// The HTTP app: the guest Now Playing feed, the admin API, the built client. Built by a
// function so tests run it in-process with their own data dir and a fake internet.

import { existsSync } from "node:fs";
import path from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import type { BarGames } from "@bargames/sdk/server";
import { adminRouter, createAdminAuth, createJsonStore, log, serveSpa, type AdminAuth } from "@bargames/gamekit/server";
import { buildQueue, DEFAULT_NAME, parseChannelLink, parseYouTubeLink, type AdminState, type Attention, type YtChannel, type YtPlaylist } from "@ytapp/shared";
import { venueFacts } from "./bargames.js";
import { GoogleError, GoogleService, type FallbackClient } from "./google/google.js";
import { Library, LibraryError, summarize } from "./library.js";
import { Plans } from "./plans.js";
import { createMedia, type Media } from "./media.js";
import { Store } from "./store.js";
import { serverTimeZone, validZone, zonedParts } from "./time.js";
import { TvError, TvManager, type TvTiming } from "./tvs.js";

export interface AppOptions {
  dataDir: string;
  bg: BarGames;
  adminPassword?: string;
  gameName?: string;
  clientDist?: string;
  googleFallback?: FallbackClient | null;
  /** Path prefix for index.html (default: BG_BASE_PATH / BASE_PATH env). */
  basePath?: string;
  /** Outgoing HTTP (Google, YouTube); tests pass a fake. */
  fetch?: typeof fetch;
  now?: () => number;
  tvTiming?: Partial<TvTiming>;
  /** How often to re-read the box's TVs (tests: short). */
  mediaRefreshMs?: number;
  /** Run the nightly scheduler (off in tests). */
  scheduler?: boolean;
}

export interface YtApp {
  app: express.Express;
  store: Store;
  auth: AdminAuth;
  google: GoogleService;
  library: Library;
  tvs: TvManager;
  plans: Plans;
  media: Media;
  /** One scheduler pass (tests call it directly). */
  nightly(): Promise<void>;
  close(): Promise<void>;
}

/** Async route errors go to the error handler instead of becoming unhandled rejections. */
const safe =
  (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) =>
    void fn(req, res).catch(next);

export async function createApp(o: AppOptions): Promise<YtApp> {
  const fetchFn = o.fetch ?? fetch;
  const now = o.now ?? Date.now;
  const bg = o.bg;
  const store = new Store(o.dataDir);
  await store.init();

  const google = new GoogleService(store, fetchFn, o.googleFallback ?? null, now);
  const library = new Library(store, google, fetchFn, now);

  const displayName = async () => (await venueFacts(bg))?.name ?? (store.settings.name || o.gameName || DEFAULT_NAME);
  let cachedName = store.settings.name || o.gameName || DEFAULT_NAME;
  const refreshName = () => void displayName().then((n) => (cachedName = n)).catch(() => undefined);
  refreshName();

  const tvs = new TvManager({
    store,
    fetch: fetchFn,
    deviceName: () => cachedName,
    nextRound: (listId) => {
      const l = library.find(listId);
      return l ? buildQueue(l.videos, l, { lastPlayed: store.lastPlayed, now: now() }) : [];
    },
    titleOf: (id) => library.titleOf(id),
    timing: o.tvTiming,
    now,
  });
  tvs.start();
  google.resumePolling();

  const auth = createAdminAuth({
    store: createJsonStore(o.dataDir),
    envPassword: o.adminPassword ?? "",
    saltFormat: "bytes",
    // Standalone behind a tunnel a whole venue shares one public IP: no per-IP lockout
    // (the kit's global cap and delay still slow guessing). On a box each device has its own.
    failsAllowed: bg.connected ? undefined : Number.POSITIVE_INFINITY,
    // SDK 0.8.0: the box's admin password opens this admin too; kit 0.5.1 onBox: it takes over.
    venuePassword: (pw, ip) => bg.checkVenuePassword(pw, ip),
    onBox: bg.connected,
  });
  await auth.init();

  const timezone = async () => validZone((await venueFacts(bg))?.timezone, serverTimeZone());

  function attention(): Attention[] {
    const out: Attention[] = [];
    const g = google.status();
    if (g.state === "disconnected") out.push({ level: "error", message: "Google disconnected: lists can't refresh. Reconnect.", actionPath: "/admin#google" });
    if (g.problem?.kind === "quota") out.push({ level: "warn", message: "YouTube's daily limit is used up; lists refresh after midnight Pacific.", actionPath: "/admin#google" });
    if (g.problem?.kind === "api-disabled") out.push({ level: "error", message: "The YouTube Data API is turned off for the Google project.", actionPath: "/admin#google" });
    if (g.problem?.kind === "client-invalid") out.push({ level: "error", message: "Google doesn't accept the OAuth client any more.", actionPath: "/admin#google" });
    for (const t of tvs.list()) if (t.link === "relink") out.push({ level: "error", message: `${t.name}: the TV link stopped working. Re-link it with a new TV code.`, actionPath: "/admin#tvs" });
    return out;
  }

  // On a box: the box's TVs page, Tonight page and startup choices drive our lists (SDK 0.9.0).
  const media = createMedia({ bg, store, tvs, library, attention, refreshMs: o.mediaRefreshMs });
  const plans = new Plans(store, library, tvs, now, media.playOnTv);
  media.register(plans);
  media.start();

  // ---------------------------------------------------------------- nightly
  let nightlyRunning = false;
  async function nightly(force = false): Promise<void> {
    if (nightlyRunning) return;
    const tz = await timezone();
    const p = zonedParts(tz, now());
    if (!force && (p.hour !== store.settings.refreshHour || store.settings.lastNightlyDate === p.date)) return;
    nightlyRunning = true;
    try {
      store.settings.lastNightlyDate = p.date;
      await store.saveSettings();
      // The daily sign-in test (refresh + 1-unit read), then the lists.
      if (google.signedIn) await google.check();
      if (google.canRead) {
        const r = await library.refreshAll();
        log.info("nightly", "lists refreshed", r);
      }
      store.settings.lastNightlyRefresh = now();
      await store.saveSettings();
    } catch (err) {
      log.warn("nightly", "failed", { err: String(err) });
    } finally {
      nightlyRunning = false;
    }
  }
  let timer: NodeJS.Timeout | null = null;
  if (o.scheduler !== false) {
    timer = setInterval(() => {
      refreshName();
      void nightly();
    }, 60_000);
    timer.unref();
    // A box that was off at refresh time still tests its Google sign-in once a day.
    const g = store.google;
    if (google.signedIn && (!g.lastCheckedAt || now() - g.lastCheckedAt > 24 * 3600_000)) void google.check();
  }

  // ---------------------------------------------------------------- HTTP
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", false);
  app.use(bg.middleware());
  app.use(express.json({ limit: "512kb" }));

  app.get("/health", (_req, res) => {
    res.json({ ok: true, tvs: store.tvs.length, lists: store.lists.length });
  });

  app.get(
    "/api/config",
    safe(async (_req, res) => {
      res.set("Cache-Control", "no-cache");
      res.json({ gameName: await displayName() });
    }),
  );

  // Guests: what's on each TV. No ids, codes, tokens or account names.
  app.get("/api/now", (_req, res) => {
    res.set("Cache-Control", "no-cache");
    res.json({ tvs: tvs.publicList() });
  });

  // ---------------------------------------------------------------- admin
  const admin = adminRouter({ auth, clientIp: (req) => bg.clientIp(req), trusted: (req) => bg.isStaff(req) });

  admin.get(
    "/state",
    safe(async (_req, res) => {
      const body: AdminState = {
        tvs: tvs.list(),
        lists: library.all().map(summarize),
        plans: plans.all(),
        google: google.status(),
        settings: { name: store.settings.name, searchCap: store.settings.searchCap, refreshHour: store.settings.refreshHour },
        attention: attention(),
        timezone: await timezone(),
        lastNightlyRefresh: store.settings.lastNightlyRefresh,
      };
      res.json(body);
    }),
  );

  admin.put(
    "/settings",
    safe(async (req, res) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const s = store.settings;
      if (b.name !== undefined) s.name = typeof b.name === "string" ? b.name.trim().slice(0, 60) : s.name;
      if (b.searchCap !== undefined) {
        const n = Number(b.searchCap);
        if (!Number.isInteger(n) || n < 0 || n > 90) return void res.status(400).json({ ok: false, error: "Searches per day: 0 to 90 (each costs 100 of 10,000 daily units)." });
        s.searchCap = n;
      }
      if (b.refreshHour !== undefined) {
        const n = Number(b.refreshHour);
        if (!Number.isInteger(n) || n < 0 || n > 23) return void res.status(400).json({ ok: false, error: "Refresh hour: 0 to 23." });
        s.refreshHour = n;
      }
      await store.saveSettings();
      refreshName();
      res.json({ ok: true });
    }),
  );

  // ---- Google
  admin.put(
    "/google/config",
    safe(async (req, res) => {
      await google.configure(req.body ?? {});
      res.json({ ok: true, value: google.status() });
    }),
  );
  admin.post(
    "/google/signin",
    safe(async (_req, res) => {
      res.json({ ok: true, value: await google.startSignIn() });
    }),
  );
  admin.post(
    "/google/cancel",
    safe(async (_req, res) => {
      await google.cancelSignIn();
      res.json({ ok: true });
    }),
  );
  admin.post(
    "/google/signout",
    safe(async (_req, res) => {
      await google.signOut();
      res.json({ ok: true });
    }),
  );
  admin.post(
    "/google/check",
    safe(async (_req, res) => {
      res.json({ ok: true, value: await google.check() });
    }),
  );

  // ---- YouTube browsing
  admin.get(
    "/youtube/playlists",
    safe(async (_req, res) => {
      const mine = await google.myPlaylists();
      const saved = new Map(library.all().flatMap((l) => (l.source.kind === "youtube" ? [[l.source.playlistId, l.id] as const] : [])));
      const value: YtPlaylist[] = mine.map((p) => ({ ...p, savedAs: saved.get(p.id) ?? null }));
      res.json({ ok: true, value });
    }),
  );
  // A channel by link or @handle, with its playlists (2 units).
  admin.get(
    "/youtube/channel",
    safe(async (req, res) => {
      const raw = String(req.query.q ?? "").trim();
      const ref = parseChannelLink(raw) ?? (/^[A-Za-z0-9._-]{3,100}$/.test(raw) ? { handle: `@${raw}` } : null);
      if (!ref) return void res.status(400).json({ ok: false, error: "Paste the channel's link or its @handle (old /c/ links don't work: open the channel and copy its @handle)." });
      const c = await google.channel(ref);
      const savedLists = new Map(library.all().flatMap((l) => (l.source.kind === "youtube" ? [[l.source.playlistId, l.id] as const] : [])));
      const savedChannel = library.all().find((l) => l.source.kind === "channel" && l.source.channelId === c.id)?.id ?? null;
      const playlists = (await google.channelPlaylists(c.id)).map((p) => ({ ...p, savedAs: savedLists.get(p.id) ?? null }));
      const channel: YtChannel = { id: c.id, title: c.title, handle: c.handle, thumb: c.thumb, videoCount: c.videoCount, savedAs: savedChannel };
      res.json({ ok: true, value: { channel, playlists } });
    }),
  );
  admin.get(
    "/youtube/subscriptions",
    safe(async (_req, res) => {
      res.json({ ok: true, value: await google.mySubscriptions() });
    }),
  );
  admin.get(
    "/youtube/search",
    safe(async (req, res) => {
      const q = String(req.query.q ?? "").trim();
      if (q.length < 2 || q.length > 100) return void res.status(400).json({ ok: false, error: "Type what to search for." });
      res.json({ ok: true, value: await google.search(q) });
    }),
  );

  // ---- Library
  admin.get(
    "/lists/:id",
    safe(async (req, res) => {
      res.json({ ok: true, value: library.get(String(req.params.id)) });
    }),
  );
  admin.post(
    "/lists",
    safe(async (req, res) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      let l;
      if (typeof b.playlistId === "string") l = await library.importPlaylist(b.playlistId);
      else if (typeof b.channelId === "string") l = await library.importChannel({ channelId: b.channelId }, { limit: b.limit, skipShorts: b.skipShorts });
      else if (typeof b.link === "string") l = await library.importLink(b.link);
      else if (typeof b.fromTv === "string") {
        const q = tvs.queueVideos(b.fromTv);
        l = await library.createLocal(b.name ?? `${q.name} (saved)`, q.videos);
      } else l = await library.createLocal(b.name);
      res.json({ ok: true, value: summarize(l) });
    }),
  );
  admin.patch(
    "/lists/:id",
    safe(async (req, res) => {
      res.json({ ok: true, value: await library.update(String(req.params.id), req.body ?? {}) });
    }),
  );
  admin.delete(
    "/lists/:id",
    safe(async (req, res) => {
      await library.remove(String(req.params.id));
      await plans.forget({ listId: String(req.params.id) });
      res.json({ ok: true });
    }),
  );
  admin.post(
    "/lists/:id/refresh",
    safe(async (req, res) => {
      res.json({ ok: true, value: summarize(await library.refresh(String(req.params.id))) });
    }),
  );
  admin.post(
    "/lists/:id/copy",
    safe(async (req, res) => {
      res.json({ ok: true, value: summarize(await library.copy(String(req.params.id), (req.body as { name?: unknown })?.name)) });
    }),
  );
  admin.post(
    "/lists/:id/add",
    safe(async (req, res) => {
      const r = await library.addTo(String(req.params.id), req.body ?? {});
      res.json({ ok: true, value: r.list, added: r.added });
    }),
  );
  admin.post(
    "/refresh-all",
    safe(async (_req, res) => {
      res.json({ ok: true, value: await library.refreshAll() });
    }),
  );

  // ---- TVs
  admin.post(
    "/tvs",
    safe(async (req, res) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      res.json({ ok: true, value: await tvs.link(b.code, b.name) });
    }),
  );
  admin.patch(
    "/tvs/:id",
    safe(async (req, res) => {
      const b = (req.body ?? {}) as { name?: unknown; boxDisplayId?: unknown };
      const id = String(req.params.id);
      if (b.boxDisplayId !== undefined) {
        if (b.boxDisplayId !== null && typeof b.boxDisplayId !== "string") return void res.status(400).json({ ok: false, error: "Pick a box TV." });
        const known = b.boxDisplayId === null || (await media.refreshBoxTvs()).some((t) => t.id === b.boxDisplayId);
        if (!known) return void res.status(400).json({ ok: false, error: "The box doesn't know that TV." });
        await tvs.mapToBox(id, b.boxDisplayId as string | null);
      }
      if (b.name !== undefined) await tvs.rename(id, b.name);
      res.json({ ok: true, value: tvs.list().find((t) => t.id === id) });
    }),
  );
  /** On a box: the venue's TVs, to say which one a link is. Never includes screen ids. */
  admin.get(
    "/box-tvs",
    safe(async (_req, res) => {
      res.json({ ok: true, value: { onBox: bg.connected, tvs: await media.refreshBoxTvs() } });
    }),
  );
  /** "Open YouTube on this TV": the box starts it (Roku over ECP). */
  admin.post(
    "/tvs/:id/open",
    safe(async (req, res) => {
      const id = String(req.params.id);
      const launch = media.launcherFor(id);
      if (!launch) return void res.status(409).json({ ok: false, error: "The box can't start YouTube on this TV. Open YouTube on it yourself." });
      const r = await launch();
      if (!r.ok) return void res.status(409).json({ ok: false, error: r.message });
      res.json({ ok: true });
    }),
  );
  admin.delete(
    "/tvs/:id",
    safe(async (req, res) => {
      await tvs.unlink(String(req.params.id));
      await plans.forget({ tvId: String(req.params.id) });
      res.json({ ok: true });
    }),
  );
  admin.post(
    "/tvs/:id/relink",
    safe(async (req, res) => {
      res.json({ ok: true, value: await tvs.relink(String(req.params.id), (req.body as { code?: unknown })?.code) });
    }),
  );
  admin.post(
    "/tvs/:id/control",
    safe(async (req, res) => {
      const b = (req.body ?? {}) as { action?: unknown; value?: unknown };
      res.json({ ok: true, value: await tvs.control(String(req.params.id), String(b.action ?? ""), b.value) });
    }),
  );
  admin.post(
    "/tvs/:id/add",
    safe(async (req, res) => {
      const p = parseYouTubeLink(String((req.body as { link?: unknown })?.link ?? ""));
      if (!p || p.kind !== "video") return void res.status(400).json({ ok: false, error: "Paste a YouTube video link." });
      const [v] = await library.lookupVideos([p.videoId]);
      res.json({ ok: true, value: await tvs.addVideo(String(req.params.id), v!) });
    }),
  );
  /** Play a list (or one video link) on one or more TVs. */
  admin.post(
    "/play",
    safe(async (req, res) => {
      const b = (req.body ?? {}) as { tvIds?: unknown; listId?: unknown; link?: unknown; startVideoId?: unknown; loop?: unknown };
      const loop = typeof b.loop === "boolean" ? b.loop : undefined;
      const ids = Array.isArray(b.tvIds) ? b.tvIds.filter((x): x is string => typeof x === "string") : [];
      if (!ids.length) return void res.status(400).json({ ok: false, error: "Pick a TV." });
      let play: (id: string) => Promise<unknown>;
      if (typeof b.listId === "string") {
        const list = library.get(b.listId);
        // From the top: start YouTube on the TV first if it's closed and the box can.
        play = typeof b.startVideoId === "string" ? (id) => tvs.playList(id, list, b.startVideoId as string, loop) : (id) => media.playOnTv(id, list, loop);
      } else {
        const p = parseYouTubeLink(String(b.link ?? ""));
        if (!p) return void res.status(400).json({ ok: false, error: "Pick a list, or paste a YouTube link." });
        if (p.kind === "playlist") {
          const list = await library.importPlaylist(p.listId);
          play = (id) => media.playOnTv(id, list, loop);
        } else {
          const [v] = await library.lookupVideos([p.videoId]);
          play = (id) => tvs.playVideo(id, v!);
        }
      }
      const results = await Promise.allSettled(ids.map((id) => play(id)));
      const failed = results.flatMap((r, i) => (r.status === "rejected" ? [`${tvs.list().find((t) => t.id === ids[i])?.name ?? "TV"}: ${(r.reason as Error).message}`] : []));
      if (failed.length === ids.length) return void res.status(409).json({ ok: false, error: failed.join(" ") });
      const pending = results.filter((r) => r.status === "fulfilled" && (r.value as { pending?: boolean } | undefined)?.pending).length;
      res.json({ ok: true, failed, pending });
    }),
  );

  // ---- Plans
  admin.post(
    "/plans",
    safe(async (req, res) => {
      res.json({ ok: true, value: await plans.create(req.body ?? {}) });
    }),
  );
  admin.patch(
    "/plans/:id",
    safe(async (req, res) => {
      res.json({ ok: true, value: await plans.update(String(req.params.id), req.body ?? {}) });
    }),
  );
  admin.delete(
    "/plans/:id",
    safe(async (req, res) => {
      await plans.remove(String(req.params.id));
      res.json({ ok: true });
    }),
  );
  admin.post(
    "/plans/:id/start",
    safe(async (req, res) => {
      const r = await plans.start(String(req.params.id));
      if (!r.started && r.failed.length) return void res.status(409).json({ ok: false, error: r.failed.join(" ") });
      res.json({ ok: true, value: r });
    }),
  );

  app.use("/api/admin", admin);
  app.use("/api", (_req, res) => void res.status(404).json({ ok: false, error: "Not found." }));

  // ---------------------------------------------------------------- client
  const indexHtml = o.clientDist ? path.join(o.clientDist, "index.html") : "";
  if (indexHtml && existsSync(indexHtml)) {
    // index.html gets the path prefix (BG_BASE_PATH on a box, BASE_PATH self-hosted) injected.
    serveSpa(app, { dist: o.clientDist!, ...(o.basePath !== undefined ? { basePath: o.basePath } : {}) });
  } else {
    log.warn("boot", "client build not found; serving the API only", { path: o.clientDist });
  }

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof GoogleError || err instanceof LibraryError || err instanceof TvError) {
      return void res.status(err.status).json({ ok: false, error: err.message });
    }
    const status = (err as { status?: number }).status ?? (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) log.error("http", "request failed", { err: String(err) });
    if (!res.headersSent) res.status(status).json({ ok: false, error: status === 404 ? "Not found." : status < 500 ? "Bad request." : "Something went wrong." });
  });

  return {
    app,
    store,
    auth,
    google,
    library,
    tvs,
    plans,
    media,
    nightly: () => nightly(true),
    async close() {
      if (timer) clearInterval(timer);
      await google.close();
      auth.close();
      media.close();
      await tvs.stopAll();
      await store.flush();
    },
  };
}
