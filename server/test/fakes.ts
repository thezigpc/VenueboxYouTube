// A fake internet for tests: YouTube's Lounge endpoints and Google's OAuth + Data API.

import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { createApp, type AppOptions, type YtApp } from "../src/app.js";
import { makeBarGames } from "../src/bargames.js";

export const GOOD_CODE = "111122223333";
export const CARTOON_CHANNEL = "UCcartoon0000000000000000".slice(0, 24);
export const SCREEN_ID = "screen-abc";

/** Wraps events the way the bind endpoint does: "<len>\n<json>\n". */
export function chunk(events: [number, unknown[]][]): string {
  const json = JSON.stringify(events);
  return `${json.length + 1}\n${json}\n`;
}

export interface Command {
  name: string;
  params: Record<string, string>;
}

export class FakeLounge {
  /** Screens YouTube still knows (remove one to simulate a revoked link). */
  screens = new Set([SCREEN_ID]);
  commands: Command[] = [];
  binds = 0;
  tokenRefreshes = 0;
  private nextEventId = 10;
  private streams = new Set<ReadableStreamDefaultController<Uint8Array>>();
  private enc = new TextEncoder();
  /** Make every bind answer 401 once (expired token). */
  expireOnce = false;
  down = false;
  /** YouTube open on the TV (get_screen_availability). */
  appOpen = true;
  availabilityChecks = 0;

  /** Pushes events to every open long poll. */
  push(name: string, arg?: unknown): void {
    const ev: [number, unknown[]] = [this.nextEventId++, arg === undefined ? [name] : [name, arg]];
    for (const c of this.streams) {
      try {
        c.enqueue(this.enc.encode(chunk([ev])));
      } catch {
        this.streams.delete(c);
      }
    }
  }

  get openStreams(): number {
    return this.streams.size;
  }

  /** Ends the long polls (YouTube does this every few minutes). */
  closeStreams(): void {
    for (const c of this.streams) {
      try {
        c.close();
      } catch {
        /* already closed */
      }
    }
    this.streams.clear();
  }

  async handle(url: URL, init: RequestInit | undefined): Promise<Response | null> {
    if (!url.href.startsWith("https://www.youtube.com/api/lounge/")) return null;
    if (this.down) throw new TypeError("fetch failed");
    const form = new URLSearchParams(init?.body instanceof URLSearchParams ? init.body : String(init?.body ?? ""));
    const p = url.pathname.replace("/api/lounge", "");
    if (p === "/pairing/get_screen") {
      if (form.get("pairing_code") !== GOOD_CODE) return new Response("not found", { status: 404 });
      this.screens.add(SCREEN_ID);
      return Response.json({ screen: { screenId: SCREEN_ID, loungeToken: "token-1", name: "Living Room TV" } });
    }
    if (p === "/pairing/get_screen_availability") {
      this.availabilityChecks++;
      return Response.json({ screens: [{ loungeToken: form.get("lounge_token"), status: this.appOpen ? "online" : "offline" }] });
    }
    if (p === "/pairing/get_lounge_token_batch") {
      this.tokenRefreshes++;
      const id = form.get("screen_ids") ?? "";
      return Response.json({ screens: this.screens.has(id) ? [{ screenId: id, loungeToken: `token-r${this.tokenRefreshes}` }] : [] });
    }
    if (p === "/bc/bind") {
      if ((init?.method ?? "GET") === "GET") {
        // Long poll.
        if (this.expireOnce) {
          this.expireOnce = false;
          return new Response("Expired", { status: 401, statusText: "Expired" });
        }
        if (url.searchParams.get("SID") !== "sid-1") return new Response("Unknown SID", { status: 400, statusText: "Unknown SID" });
        const signal = init?.signal;
        let ctrl!: ReadableStreamDefaultController<Uint8Array>;
        const body = new ReadableStream<Uint8Array>({
          start: (c) => {
            ctrl = c;
            this.streams.add(c);
          },
          cancel: () => void this.streams.delete(ctrl),
        });
        signal?.addEventListener("abort", () => {
          this.streams.delete(ctrl);
          try {
            ctrl.error(new DOMException("aborted", "AbortError"));
          } catch {
            /* closed */
          }
        });
        return new Response(body, { status: 200 });
      }
      if (url.searchParams.get("RID") === "1") {
        // Connect.
        if (this.expireOnce) {
          this.expireOnce = false;
          return new Response("Expired", { status: 401 });
        }
        this.binds++;
        const status = { devices: JSON.stringify([{ type: "LOUNGE_SCREEN", name: "Living Room TV" }]) };
        return new Response(chunk([[0, ["c", "sid-1", "", 8]], [1, ["S", "gs-1"]], [2, ["loungeStatus", status]]]));
      }
      if (form.get("TYPE") === "terminate") return new Response("ok");
      const name = form.get("req0__sc");
      if (name) {
        const params: Record<string, string> = {};
        for (const [k, v] of form) if (k.startsWith("req0_") && k !== "req0__sc") params[k.slice(5)] = v;
        this.commands.push({ name, params });
        return new Response("ok");
      }
    }
    return new Response("?", { status: 404 });
  }
}

export interface YtVideo {
  id: string;
  title: string;
  /** Not returned by videos.list (deleted/private). */
  hidden?: boolean;
}

export class FakeGoogle {
  /** playlist id → videos. */
  playlists = new Map<string, { title: string; mine: boolean; videos: YtVideo[] }>();
  /** Device flow: polls before the user "approves". */
  pendingPolls = 1;
  deviceRequests = 0;
  refreshGrantValid = true;
  quotaExceeded = false;
  apiDisabled = false;
  calls: string[] = [];
  clientId = "123-abc.apps.googleusercontent.com";

  constructor() {
    const vids = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => ({ id: `${prefix}${String(i).padStart(11 - prefix.length, "0")}`, title: `${prefix} song ${i}` }));
    this.playlists.set("PLbarqueue0001", { title: "Bar queue", mine: true, videos: vids(120, "bq") });
    // A channel's uploads: newest first, every third one a Short (30 s), one upcoming premiere.
    this.playlists.set("UUcartoon0001", { title: "Uploads", mine: false, videos: vids(130, "ct") });
    this.playlists.set("PLchill000002", { title: "Chill", mine: true, videos: [...vids(3, "ch"), { id: "chGONE00000", title: "Deleted video", hidden: true }] });
  }

  private allVideos(): Map<string, YtVideo> {
    const m = new Map<string, YtVideo>();
    for (const p of this.playlists.values()) for (const v of p.videos) m.set(v.id, v);
    m.set("dQw4w9WgXcQ", { id: "dQw4w9WgXcQ", title: "Never Gonna Give You Up" });
    return m;
  }

  async handle(url: URL, init: RequestInit | undefined): Promise<Response | null> {
    const form = new URLSearchParams(init?.body instanceof URLSearchParams ? init.body : String(init?.body ?? ""));
    if (url.href === "https://oauth2.googleapis.com/device/code") {
      this.deviceRequests++;
      if (form.get("client_id") !== this.clientId) return Response.json({ error: "invalid_client" }, { status: 401 });
      return Response.json({ device_code: "dev-1", user_code: "ABCD-EFGH", verification_url: "https://www.google.com/device", expires_in: 1800, interval: 0 });
    }
    if (url.href === "https://oauth2.googleapis.com/token") {
      if (form.get("grant_type") === "refresh_token") {
        if (!this.refreshGrantValid) return Response.json({ error: "invalid_grant", error_description: "Token has been expired or revoked." }, { status: 400 });
        return Response.json({ access_token: "access-2", expires_in: 3600 });
      }
      if (this.pendingPolls-- > 0) return Response.json({ error: "authorization_pending" }, { status: 428 });
      return Response.json({ access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600 });
    }
    if (url.href.startsWith("https://oauth2.googleapis.com/revoke")) return new Response("");
    if (url.href.startsWith("https://www.youtube.com/oembed")) {
      const v = new URL(url.searchParams.get("url")!).searchParams.get("v")!;
      const video = this.allVideos().get(v) ?? (v.startsWith("vid") ? { id: v, title: `Video ${v}` } : undefined);
      return video ? Response.json({ title: video.title, author_name: "Someone" }) : new Response("Not Found", { status: 404 });
    }
    if (!url.href.startsWith("https://www.googleapis.com/youtube/v3/")) return null;
    this.calls.push(url.pathname.split("/").pop()!);
    const authed = (init?.headers as Record<string, string> | undefined)?.authorization?.startsWith("Bearer ");
    if (!authed && !url.searchParams.get("key")) return Response.json({ error: { code: 401, message: "Login Required" } }, { status: 401 });
    if (this.quotaExceeded) return Response.json({ error: { code: 403, errors: [{ reason: "quotaExceeded" }] } }, { status: 403 });
    if (this.apiDisabled) return Response.json({ error: { code: 403, message: "YouTube Data API v3 has not been used in project 1 before or it is disabled.", errors: [{ reason: "accessNotConfigured" }] } }, { status: 403 });
    const resource = url.pathname.split("/").pop();
    const q = url.searchParams;
    if (resource === "channels") {
      // A cartoon channel by @handle or id; otherwise the signed-in account's channel.
      if (q.get("forHandle") === "@cartoons" || q.get("id") === CARTOON_CHANNEL) {
        return Response.json({
          items: [{ id: CARTOON_CHANNEL, snippet: { title: "Cartoon Classics", customUrl: "@cartoons" }, contentDetails: { relatedPlaylists: { uploads: "UUcartoon0001" } }, statistics: { videoCount: "130" } }],
        });
      }
      if (q.get("forHandle") || q.get("id") || q.get("forUsername")) return Response.json({ items: [] });
      return Response.json({ items: [{ id: "UCrootbar0000000000000", snippet: { title: "The Root Bar", customUrl: "@therootbar" } }] });
    }
    if (resource === "subscriptions") {
      return Response.json({ items: [{ snippet: { title: "Cartoon Classics", resourceId: { channelId: CARTOON_CHANNEL }, thumbnails: {} } }] });
    }
    if (resource === "playlists") {
      if (q.get("channelId") === CARTOON_CHANNEL) {
        return Response.json({ items: [{ id: "PLcartoonfav1", snippet: { title: "Favorites", thumbnails: {} }, contentDetails: { itemCount: 3 } }] });
      }
      if (q.get("mine")) {
        return Response.json({
          items: [...this.playlists].filter(([, p]) => p.mine).map(([id, p]) => ({ id, snippet: { title: p.title, thumbnails: {} }, contentDetails: { itemCount: p.videos.length }, status: { privacyStatus: "private" } })),
        });
      }
      const p = this.playlists.get(q.get("id") ?? "");
      return Response.json({ items: p ? [{ id: q.get("id"), snippet: { title: p.title } }] : [] });
    }
    if (resource === "playlistItems") {
      const p = this.playlists.get(q.get("playlistId") ?? "");
      if (!p) return Response.json({ error: { code: 404, errors: [{ reason: "playlistNotFound" }] } }, { status: 404 });
      const start = Number(q.get("pageToken") || 0);
      const page = p.videos.slice(start, start + 50);
      return Response.json({
        items: page.map((v) => ({ snippet: { title: v.title, videoOwnerChannelTitle: "Chan" }, contentDetails: { videoId: v.id }, status: { privacyStatus: v.hidden ? "privacyStatusUnspecified" : "public" } })),
        ...(start + 50 < p.videos.length ? { nextPageToken: String(start + 50) } : {}),
      });
    }
    if (resource === "videos") {
      const all = this.allVideos();
      const ids = (q.get("id") ?? "").split(",");
      return Response.json({
        items: ids.flatMap((id) => {
          const v = all.get(id);
          if (!v || v.hidden) return [];
          const n = Number(id.slice(2));
          const short = id.startsWith("ct") && n % 3 === 2;
          const upcoming = id === "ct000000000";
          return [
            {
              id,
              snippet: { title: v.title, channelTitle: "Chan", liveBroadcastContent: upcoming ? "upcoming" : "none" },
              contentDetails: { duration: short ? "PT30S" : "PT3M30S" },
              status: { uploadStatus: "processed" },
            },
          ];
        }),
      });
    }
    if (resource === "search") return Response.json({ items: [{ id: { videoId: "dQw4w9WgXcQ" }, snippet: { title: "Rick &amp; Roll", channelTitle: "Rick" } }] });
    return Response.json({ error: { code: 404 } }, { status: 404 });
  }
}

export interface TestApp {
  url: string;
  yt: YtApp;
  lounge: FakeLounge;
  google: FakeGoogle;
  dataDir: string;
  clock: { now: number };
  get(path: string, token?: string): Promise<Response>;
  send(method: string, path: string, body?: unknown, token?: string): Promise<Response>;
  /** JSON of an admin call; throws with the error message when not ok. */
  call<T = unknown>(method: string, path: string, body?: unknown): Promise<T>;
  token: string;
  /** Restarts the app on the same data dir (an update / container restart). */
  restart(): Promise<void>;
  stop(): Promise<void>;
}

export const until = async (cond: () => boolean, what = "condition", ms = 3000) => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};

export async function startApp(opts: Partial<AppOptions> & { coreUrl?: string; coreToken?: string; dataDir?: string; noLogin?: boolean } = {}): Promise<TestApp> {
  const dataDir = opts.dataDir ?? mkdtempSync(path.join(os.tmpdir(), "yt-test-"));
  const lounge = new FakeLounge();
  const google = new FakeGoogle();
  const clock = { now: Date.UTC(2026, 10, 11, 18, 0) };
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const r = (await lounge.handle(url, init)) ?? (await google.handle(url, init));
    if (r) return r;
    throw new Error(`unexpected fetch ${url.href}`);
  }) as typeof fetch;

  let server: Server;
  let url = "";
  const t = {} as TestApp;
  async function boot() {
    const bg = makeBarGames({ defaultName: "YouTube", coreUrl: opts.coreUrl ?? "", token: opts.coreToken ?? "" });
    t.yt = await createApp({
      dataDir,
      bg,
      fetch: fetchFn,
      now: () => clock.now,
      scheduler: false,
      tvTiming: { tickMs: 20, stallMs: 50, startGraceMs: 100, backoffMinMs: 10, backoffMaxMs: 50, launchPollMs: 20, launchTimeoutMs: 3000 },
      mediaRefreshMs: 3_600_000,
      ...opts,
    });
    server = createServer(t.yt.app);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    t.url = url;
  }
  async function halt() {
    await t.yt.close();
    lounge.closeStreams();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
  const auth = (token?: string): Record<string, string> => (token ? { authorization: `Bearer ${token}` } : {});
  Object.assign(t, {
    lounge,
    google,
    dataDir,
    clock,
    token: "",
    get: (p: string, token?: string) => fetch(url + p, { headers: auth(token) }),
    send: (method: string, p: string, body?: unknown, token?: string) =>
      body === undefined
        ? fetch(url + p, { method, headers: auth(token) })
        : fetch(url + p, { method, headers: { "content-type": "application/json", ...auth(token) }, body: JSON.stringify(body) }),
    async call<T>(method: string, p: string, body?: unknown): Promise<T> {
      const r = await t.send(method, `/api/admin${p}`, body ?? (method === "GET" ? undefined : {}), t.token);
      const j = (await r.json()) as { ok?: boolean; error?: string; value?: T };
      if (!r.ok) throw new Error(`${r.status} ${j.error}`);
      return (j.value ?? j) as T;
    },
    async restart() {
      await halt();
      await boot();
      // Admin sessions live in memory: sign in again.
      if (!opts.noLogin) {
        const r = await t.send("POST", "/api/admin/login", { password: "correct horse battery" });
        t.token = ((await r.json()) as { token: string }).token;
      }
    },
    async stop() {
      await halt();
      rmSync(dataDir, { recursive: true, force: true });
    },
  });
  await boot();
  if (!opts.noLogin) {
    const r = await t.send("POST", "/api/admin/setup", { password: "correct horse battery" });
    t.token = ((await r.json()) as { token: string }).token;
  }
  return t;
}
