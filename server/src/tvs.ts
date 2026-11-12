// Linked TVs: one Lounge session each, kept up in the background (also after a restart),
// and the queue we drive on it. We always send the TV video ids (never "play playlist X"),
// so whatever account the TV's YouTube app is signed in to plays them (Premium: no ads).
//
// Queue driving: the TV gets a window of the queue (setPlaylist with up to WINDOW ids) and
// we top it up with addVideo as it plays. A video the TV can't play must never stall the
// queue: if it never starts, or the TV stops at a video's end, we skip ahead ourselves.
//
// Local control wins: when someone uses the TV directly (plays something else, stops
// playback, leaves the video), the TV goes "local" and we stop every automatic action
// (no skips, top-ups or restarts), also across restarts, until staff take it back.

import { randomBytes, randomUUID } from "node:crypto";
import { log } from "@bargames/gamekit/server";
import { buildQueue, normalizeTvCode, thumbUrl, type NowPlaying, type PublicTv, type SavedList, type TvInfo, type TvLink, type Video } from "@ytapp/shared";
import { LoungeSession, pairWithCode, refreshLoungeToken } from "./lounge/client.js";
import { LoungeError, playState, screenNameFromStatus, type LoungeEvent } from "./lounge/protocol.js";
import type { StoredQueue, StoredTv, Store } from "./store.js";

export const MAX_TVS = 24;
/** Videos sent in one setPlaylist, and how few left before we top up. */
export const WINDOW = 50;
export const LOW_WATER = 10;
/** Lounge tokens last about two weeks; renew well before. */
const TOKEN_MAX_AGE = 24 * 3600_000;

export class TvError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export interface TvTiming {
  /** A TV stopped or ended this long (with more queued) gets skipped ahead. */
  stallMs: number;
  /** After we start a video, how long it may take to start playing. */
  startGraceMs: number;
  /** How often the watchdog looks. */
  tickMs: number;
  /** Reconnect backoff bounds. */
  backoffMinMs: number;
  backoffMaxMs: number;
}

export const DEFAULT_TIMING: TvTiming = { stallMs: 20_000, startGraceMs: 45_000, tickMs: 5_000, backoffMinMs: 2_000, backoffMaxMs: 60_000 };

export interface TvDeps {
  store: Store;
  fetch: typeof fetch;
  /** Shown on the TV as the connected remote. */
  deviceName: () => string;
  /** The next round of a looping list (re-shuffled), or [] if the list is gone. */
  nextRound: (listId: string) => Video[];
  /** A title for a video the TV plays that we didn't queue. */
  titleOf: (videoId: string) => Video | undefined;
  timing?: Partial<TvTiming>;
  now?: () => number;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });

class TvSession {
  link: TvLink = "connecting";
  message = "Connecting…";
  nowPlaying: NowPlaying | null = null;
  volume: number | null = null;
  muted = false;
  private session: LoungeSession | null = null;
  private abort = new AbortController();
  private forceRefresh = false;
  /** When the current video was started by us (grace period) and the state last changed. */
  private startedAt = 0;
  private stateSince = 0;
  private skipsWithoutPlay = 0;
  private sawPlaying = false;
  private ticker: NodeJS.Timeout | null = null;

  constructor(
    readonly tv: StoredTv,
    private readonly d: Required<Omit<TvDeps, "timing">> & { timing: TvTiming },
  ) {
    if (tv.relink) {
      this.link = "relink";
      this.message = "YouTube no longer accepts this TV's link. Enter a new TV code.";
    }
  }

  start(): void {
    if (this.tv.relink) return;
    this.abort = new AbortController();
    void this.run(this.abort.signal);
    this.ticker = setInterval(() => void this.tick(), this.d.timing.tickMs);
    this.ticker.unref();
  }

  async stop(): Promise<void> {
    this.abort.abort();
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
    const s = this.session;
    this.session = null;
    await s?.disconnect().catch(() => undefined);
  }

  private persist(): void {
    this.d.store.later("tvs", 3000);
  }

  private async run(signal: AbortSignal): Promise<void> {
    let backoff = this.d.timing.backoffMinMs;
    while (!signal.aborted) {
      try {
        if (this.forceRefresh || !this.tv.loungeToken || this.d.now() - this.tv.tokenAt > TOKEN_MAX_AGE) {
          this.tv.loungeToken = await refreshLoungeToken(this.tv.screenId, this.d.fetch);
          this.tv.tokenAt = this.d.now();
          this.forceRefresh = false;
          await this.d.store.saveTvs();
        }
        const session = new LoungeSession({
          screenId: this.tv.screenId,
          loungeToken: this.tv.loungeToken,
          deviceName: this.d.deviceName(),
          deviceId: this.tv.deviceId,
          fetch: this.d.fetch,
          onEvent: (e) => this.onEvent(e),
        });
        await session.connect();
        if (signal.aborted) return void (await session.disconnect());
        this.session = session;
        this.link = "connected";
        this.message = "";
        backoff = this.d.timing.backoffMinMs;
        while (!signal.aborted && session.connected) {
          const started = this.d.now();
          await session.subscribe(signal);
          // An answer that ends at once, over and over, mustn't spin.
          if (this.d.now() - started < 1000) await sleep(1000, signal);
        }
      } catch (err) {
        if (signal.aborted) return;
        const e = err instanceof LoungeError ? err : new LoungeError("network", String(err));
        this.session = null;
        if (e.kind === "unlinked") {
          log.warn("tv", "link revoked", { tv: this.tv.name });
          this.tv.relink = true;
          this.link = "relink";
          this.message = "YouTube no longer accepts this TV's link. Enter a new TV code.";
          await this.d.store.saveTvs();
          return;
        }
        if (e.kind === "expired") {
          this.forceRefresh = true;
          continue;
        }
        if (e.kind === "session") continue;
        this.link = "connecting";
        this.message = e.kind === "protocol" ? `YouTube's TV link answered unexpectedly (${e.message}). Retrying.` : `${e.message} Retrying.`;
        log.warn("tv", "connection problem", { tv: this.tv.name, kind: e.kind, err: e.message });
        await sleep(backoff, signal);
        backoff = Math.min(backoff * 2, this.d.timing.backoffMaxMs);
      }
    }
  }

  // ------------------------------------------------------------------ events
  onEvent(e: LoungeEvent): void {
    const a = (e.args[0] ?? {}) as Record<string, unknown>;
    switch (e.name) {
      case "loungeStatus": {
        const name = screenNameFromStatus(a);
        if (name && name !== this.tv.screenName) {
          this.tv.screenName = name;
          this.persist();
        }
        break;
      }
      case "nowPlaying": {
        const videoId = typeof a.videoId === "string" ? a.videoId : "";
        if (!videoId) {
          // The TV left the video (or between videos): the watchdog decides after a while.
          if (this.nowPlaying) this.stateSince = this.d.now();
          this.nowPlaying = null;
          break;
        }
        this.setVideo(videoId, a);
        break;
      }
      case "onStateChange": {
        if (!this.nowPlaying) break;
        this.updateState(a);
        break;
      }
      case "onVolumeChanged":
        this.volume = Number.isFinite(Number(a.volume)) ? Number(a.volume) : this.volume;
        this.muted = a.muted === "true" || a.muted === true;
        break;
      case "loungeScreenDisconnected":
        this.link = "connecting";
        this.message = "The TV's YouTube app closed the link. Reconnecting…";
        break;
      default:
        break;
    }
  }

  private updateState(a: Record<string, unknown>): void {
    if (!this.nowPlaying) return;
    const state = a.state !== undefined ? playState(a.state) : this.nowPlaying.state;
    if (state !== this.nowPlaying.state) this.stateSince = this.d.now();
    this.nowPlaying.state = state;
    if (a.currentTime !== undefined) this.nowPlaying.positionSec = Number(a.currentTime) || 0;
    if (a.duration !== undefined) this.nowPlaying.durationSec = Number(a.duration) || 0;
    this.nowPlaying.updatedAt = this.d.now();
    if (state === "playing") {
      this.skipsWithoutPlay = 0;
      if (!this.sawPlaying) {
        this.sawPlaying = true;
        this.d.store.lastPlayed[this.nowPlaying.videoId] = this.d.now();
        this.d.store.later("history", 10_000);
      }
    }
  }

  private setVideo(videoId: string, a: Record<string, unknown>): void {
    const changed = this.nowPlaying?.videoId !== videoId;
    const q = this.tv.queue;
    let known: Video | undefined;
    if (q) {
      // Prefer the next occurrence at or after the current position (lists can repeat ids when looping).
      let i = q.videos.findIndex((v, k) => k >= q.index && v.id === videoId);
      if (i < 0) i = q.videos.findIndex((v) => v.id === videoId);
      if (i >= 0) {
        known = q.videos[i];
        if (!this.tv.local) {
          if (i !== q.index) {
            q.index = i;
            this.persist();
          }
          void this.topUp();
        }
      } else if (changed) {
        this.goLocal("Someone played something else on the TV.");
      }
    }
    known ??= this.d.titleOf(videoId);
    if (changed) {
      this.stateSince = this.d.now();
      this.sawPlaying = false;
      this.nowPlaying = { videoId, title: known?.title ?? "", channel: known?.channel ?? "", state: "unknown", positionSec: 0, durationSec: 0, updatedAt: this.d.now() };
    }
    this.updateState(a);
  }

  // ------------------------------------------------------------------ queue
  private async command(name: string, params?: Record<string, string | number>): Promise<void> {
    const s = this.session;
    if (!s?.connected || this.link !== "connected") {
      throw new TvError(this.link === "relink" ? "This TV needs a new TV code." : "The TV isn't connected right now. Is it on, with YouTube open?", 409);
    }
    try {
      await s.command(name, params);
    } catch (err) {
      const e = err instanceof LoungeError ? err : new LoungeError("network", String(err));
      if (e.kind === "session" || e.kind === "expired") {
        // The run loop reconnects; tell staff to try again in a moment.
        throw new TvError("The TV connection was refreshing. Try again in a few seconds.", 503);
      }
      throw new TvError(e.message, 502);
    }
  }

  /** Sends the queue to the TV starting at `index`. */
  async playFrom(index: number): Promise<void> {
    const q = this.tv.queue;
    if (!q || !q.videos.length) throw new TvError("The queue is empty.");
    const i = Math.max(0, Math.min(index, q.videos.length - 1));
    const window = q.videos.slice(i, i + WINDOW);
    await this.command("setPlaylist", {
      videoId: window[0]!.id,
      videoIds: window.map((v) => v.id).join(","),
      currentIndex: 0,
      currentTime: 0,
      audioOnly: "false",
      listId: "",
    });
    q.index = i;
    q.base = i;
    q.sentEnd = i + window.length;
    this.tv.local = null;
    this.message = "";
    this.startedAt = this.d.now();
    this.stateSince = this.d.now();
    this.sawPlaying = false;
    this.persist();
  }

  async setQueue(q: StoredQueue): Promise<void> {
    const old = this.tv.queue;
    this.tv.queue = q;
    try {
      await this.playFrom(0);
      this.skipsWithoutPlay = 0;
    } catch (err) {
      this.tv.queue = old;
      throw err;
    }
    await this.d.store.saveTvs();
  }

  /** Keeps LOW_WATER videos ahead on the TV; extends a looping queue with a new round. */
  private topping = false;
  private async topUp(): Promise<void> {
    const q = this.tv.queue;
    if (!q || this.topping || this.tv.local) return;
    this.topping = true;
    try {
      if (q.loop && q.listId && q.videos.length - q.index <= LOW_WATER) {
        const round = this.d.nextRound(q.listId);
        if (round.length) {
          // Trim what's long played so a queue that loops for days stays small.
          const drop = Math.max(0, Math.min(q.base, q.index) - 200);
          q.videos = [...q.videos.slice(drop), ...round];
          q.index -= drop;
          q.base -= drop;
          q.sentEnd -= drop;
          this.persist();
        }
      }
      while (q.sentEnd < q.videos.length && q.sentEnd - q.index < LOW_WATER && this.link === "connected") {
        const v = q.videos[q.sentEnd]!;
        await this.command("addVideo", { videoId: v.id, videoSources: "XX" });
        q.sentEnd += 1;
        this.persist();
      }
    } catch (err) {
      log.warn("tv", "couldn't top up the queue", { tv: this.tv.name, err: String(err) });
    } finally {
      this.topping = false;
    }
  }

  /** Hands off: someone is using the TV directly. Only staff clear it (Take back / Play). */
  private goLocal(reason: string): void {
    if (this.tv.local) return;
    this.tv.local = { since: this.d.now(), reason };
    log.info("tv", "local control: hands off", { tv: this.tv.name, reason });
    void this.d.store.saveTvs().catch(() => undefined);
  }

  /**
   * The watchdog. It only ever moves our own queue along when the TV is clearly stuck on
   * it: a video that never started (unplayable), or a video that ended with nothing after
   * it. A video that played and was then stopped, or the TV leaving the video, is someone
   * using the TV: hands off.
   */
  private async tick(): Promise<void> {
    const q = this.tv.queue;
    const np = this.nowPlaying;
    if (!q || this.tv.local || this.link !== "connected") return;
    const now = this.d.now();
    if (now - this.startedAt < this.d.timing.startGraceMs) return;
    const quiet = now - this.stateSince > this.d.timing.stallMs;
    // The list played to its end (no loop): nothing to do, and nobody took anything over.
    if (q.index >= q.videos.length - 1 && (!np || np.state === "ended" || np.state === "stopped")) return;
    if (quiet && this.sawPlaying && (!np || np.state === "stopped")) {
      this.goLocal(np ? "Playback was stopped on the TV." : "Someone left the video on the TV.");
      return;
    }
    const stuck =
      (np && np.state === "ended" && quiet) ||
      // Never started (TV error screen on an unplayable video).
      (np && !this.sawPlaying && np.state === "stopped" && quiet) ||
      (np && !this.sawPlaying && (np.state === "unknown" || np.state === "buffering") && now - this.stateSince > this.d.timing.startGraceMs);
    if (!stuck) return;
    const next = q.index + 1;
    if (next >= q.videos.length) return; // finished (a looping queue was extended before this)
    if (this.skipsWithoutPlay >= 5) {
      this.message = "The TV isn't playing. Is it on, with YouTube open? Press Play to try again.";
      return;
    }
    this.skipsWithoutPlay += 1;
    log.info("tv", "skipping a video that didn't play", { tv: this.tv.name, videoId: np?.videoId });
    await this.playFrom(next).catch((err) => log.warn("tv", "skip failed", { err: String(err) }));
  }

  // ------------------------------------------------------------------ controls
  async control(action: string, value?: unknown): Promise<void> {
    switch (action) {
      case "takeback": {
        // Staff take the TV back from local control: our list again, where it was.
        const q = this.tv.queue;
        if (!q || !q.videos.length) throw new TvError("There's no list to go back to. Play a list instead.");
        this.skipsWithoutPlay = 0;
        await this.playFrom(this.nowPlaying && q.videos[q.index]?.id === this.nowPlaying.videoId ? q.index : q.index + 1 < q.videos.length ? q.index + 1 : 0);
        await this.d.store.saveTvs();
        return;
      }
      case "loop": {
        // Loop the list that's playing now (or stop looping it), without restarting anything.
        const q = this.tv.queue;
        if (!q) throw new TvError("Nothing is queued on this TV.");
        if (!q.listId && value) throw new TvError("Only a list can loop. Save this queue as a list, then play it with Loop on.");
        q.loop = !!value;
        await this.d.store.saveTvs();
        if (q.loop) void this.topUp();
        return;
      }
      case "release":
        // Staff hand the TV to local control on purpose.
        this.goLocal("Handed to the TV's own remote from the admin.");
        return;
      case "play":
        // After the watchdog gave up, Play restarts the queue where it was.
        if (this.skipsWithoutPlay >= 5 && this.tv.queue && !this.tv.local) {
          this.skipsWithoutPlay = 0;
          this.message = "";
          return this.playFrom(this.tv.queue.index);
        }
        return this.command("play");
      case "pause":
        return this.command("pause");
      case "next": {
        const q = this.tv.queue;
        // Our own skip when the TV has nothing after this one in its window.
        if (q && !this.tv.local && q.sentEnd <= q.index + 1 && q.index + 1 < q.videos.length) return this.playFrom(q.index + 1);
        return this.command("next");
      }
      case "previous":
        return this.command("previous");
      case "volume": {
        const v = Math.round(Number(value));
        if (!Number.isFinite(v) || v < 0 || v > 100) throw new TvError("Volume is 0 to 100.");
        await this.command("setVolume", { volume: v });
        this.volume = v;
        return;
      }
      case "stop":
        await this.command("pause").catch(() => undefined);
        this.tv.queue = null;
        this.tv.local = null;
        await this.d.store.saveTvs();
        return;
      default:
        throw new TvError("Unknown control.");
    }
  }

  /** "Add to queue": after what the TV already has. */
  async addVideo(v: Video): Promise<void> {
    const q = this.tv.queue;
    await this.command("addVideo", { videoId: v.id, videoSources: "XX" });
    if (q && !this.tv.local) {
      q.videos.splice(q.sentEnd, 0, v);
      q.sentEnd += 1;
      this.persist();
    }
  }

  info(): TvInfo {
    const q = this.tv.queue;
    return {
      id: this.tv.id,
      name: this.tv.name,
      screenName: this.tv.screenName,
      link: this.link,
      message: this.message,
      nowPlaying: this.nowPlaying,
      queue: q
        ? {
            listId: q.listId,
            listName: q.listName,
            index: q.index,
            length: q.videos.length,
            loop: q.loop,
            upNext: q.videos.slice(q.index + 1, q.index + 6).map((v) => ({ id: v.id, title: v.title })),
            detached: !!this.tv.local,
          }
        : null,
      volume: this.volume,
      muted: this.muted,
      linkedAt: this.tv.linkedAt,
      local: this.tv.local ?? null,
    };
  }
}

export class TvManager {
  private sessions = new Map<string, TvSession>();
  private readonly d: Required<Omit<TvDeps, "timing">> & { timing: TvTiming };

  constructor(deps: TvDeps) {
    this.d = { ...deps, now: deps.now ?? Date.now, timing: { ...DEFAULT_TIMING, ...deps.timing } };
  }

  /** Reconnects every linked TV (boot). */
  start(): void {
    for (const tv of this.d.store.tvs) this.open(tv);
  }

  private open(tv: StoredTv): TvSession {
    const s = new TvSession(tv, this.d);
    this.sessions.set(tv.id, s);
    s.start();
    return s;
  }

  private get(id: string): TvSession {
    const s = this.sessions.get(id);
    if (!s) throw new TvError("That TV isn't linked any more.", 404);
    return s;
  }

  list(): TvInfo[] {
    return this.d.store.tvs.map((tv) => this.sessions.get(tv.id)?.info()).filter((x): x is TvInfo => !!x);
  }

  publicList(): PublicTv[] {
    return this.list()
      .filter((t) => t.link === "connected" && t.nowPlaying && t.nowPlaying.title)
      .map((t) => ({
        name: t.name,
        title: t.nowPlaying!.title,
        channel: t.nowPlaying!.channel,
        thumb: thumbUrl(t.nowPlaying!.videoId),
        playing: t.nowPlaying!.state === "playing",
        listName: t.queue && !t.queue.detached ? t.queue.listName : "",
      }));
  }

  private cleanName(v: unknown, fallback: string): string {
    const s = typeof v === "string" ? v.trim().replace(/\s+/g, " ").slice(0, 40) : "";
    return s || fallback;
  }

  /** "Link with TV code": pairs, saves, connects. */
  async link(code: unknown, name: unknown): Promise<TvInfo> {
    const c = typeof code === "string" ? normalizeTvCode(code) : null;
    if (!c) throw new TvError("A TV code is 12 digits (YouTube on the TV: Settings → Link with TV code).");
    if (this.d.store.tvs.length >= MAX_TVS) throw new TvError(`Up to ${MAX_TVS} TVs.`, 409);
    const screen = await this.pair(c);
    const dup = this.d.store.tvs.find((t) => t.screenId === screen.screenId);
    if (dup) return this.relinkWith(dup.id, screen);
    const tv: StoredTv = {
      id: randomBytes(5).toString("base64url"),
      name: this.cleanName(name, screen.screenName || `TV ${this.d.store.tvs.length + 1}`),
      screenId: screen.screenId,
      loungeToken: screen.loungeToken,
      tokenAt: this.d.now(),
      deviceId: randomUUID(),
      screenName: screen.screenName,
      linkedAt: this.d.now(),
      queue: null,
    };
    this.d.store.tvs.push(tv);
    await this.d.store.saveTvs();
    log.info("tv", "linked", { tv: tv.name });
    return this.open(tv).info();
  }

  private async pair(code: string) {
    try {
      return await pairWithCode(code, this.d.fetch);
    } catch (err) {
      if (err instanceof LoungeError) throw new TvError(err.message, err.kind === "bad-code" ? 400 : 502);
      throw err;
    }
  }

  /** "Re-link this TV" with a fresh code; keeps its name and queue. */
  async relink(id: string, code: unknown): Promise<TvInfo> {
    this.get(id);
    const c = typeof code === "string" ? normalizeTvCode(code) : null;
    if (!c) throw new TvError("A TV code is 12 digits (YouTube on the TV: Settings → Link with TV code).");
    return this.relinkWith(id, await this.pair(c));
  }

  private async relinkWith(id: string, screen: { screenId: string; loungeToken: string; screenName: string }): Promise<TvInfo> {
    await this.get(id).stop();
    const tv = this.d.store.tvs.find((t) => t.id === id)!;
    tv.screenId = screen.screenId;
    tv.loungeToken = screen.loungeToken;
    tv.tokenAt = this.d.now();
    tv.screenName = screen.screenName || tv.screenName;
    tv.relink = false;
    tv.linkedAt = this.d.now();
    await this.d.store.saveTvs();
    return this.open(tv).info();
  }

  async rename(id: string, name: unknown): Promise<TvInfo> {
    const s = this.get(id);
    s.tv.name = this.cleanName(name, s.tv.name);
    await this.d.store.saveTvs();
    return s.info();
  }

  async unlink(id: string): Promise<void> {
    await this.get(id).stop();
    this.sessions.delete(id);
    this.d.store.tvs = this.d.store.tvs.filter((t) => t.id !== id);
    await this.d.store.saveTvs();
  }

  /** Plays a list on one TV (its own shuffle when the list shuffles). */
  async playList(id: string, list: SavedList, startVideoId?: string, loop?: boolean): Promise<TvInfo> {
    const s = this.get(id);
    let videos = buildQueue(list.videos, list, { lastPlayed: this.d.store.lastPlayed, now: this.d.now() });
    if (!videos.length) throw new TvError("That list has no playable videos.");
    if (startVideoId) {
      const i = videos.findIndex((v) => v.id === startVideoId);
      if (i > 0) videos = [...videos.slice(i), ...videos.slice(0, i)];
    }
    await s.setQueue({ listId: list.id, listName: list.name, videos, index: 0, base: 0, sentEnd: 0, loop: loop ?? list.loop });
    return s.info();
  }

  /** Plays one video now (a one-off, no list). */
  async playVideo(id: string, v: Video): Promise<TvInfo> {
    const s = this.get(id);
    await s.setQueue({ listId: null, listName: v.title, videos: [v], index: 0, base: 0, sentEnd: 0, loop: false });
    return s.info();
  }

  async control(id: string, action: string, value?: unknown): Promise<TvInfo> {
    const s = this.get(id);
    await s.control(action, value);
    return s.info();
  }

  async addVideo(id: string, v: Video): Promise<TvInfo> {
    const s = this.get(id);
    await s.addVideo(v);
    return s.info();
  }

  /** The TV's queue from now on, for "save this one". */
  queueVideos(id: string): { name: string; videos: Video[] } {
    const q = this.get(id).tv.queue;
    if (!q || !q.videos.length) throw new TvError("Nothing is queued on this TV.");
    const seen = new Set<string>();
    return { name: q.listName, videos: q.videos.filter((v) => !seen.has(v.id) && (seen.add(v.id), true)) };
  }

  /** Lists removed from the library keep playing; their name just stays. */
  async stopAll(): Promise<void> {
    await Promise.all([...this.sessions.values()].map((s) => s.stop()));
  }

  /** For tests: deliver an event as if the TV sent it. */
  inject(id: string, e: LoungeEvent): void {
    this.get(id).onEvent(e);
  }
}
