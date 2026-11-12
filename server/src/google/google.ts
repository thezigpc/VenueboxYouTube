// Google sign-in (OAuth device flow, "TVs and Limited Input devices" client) and the
// YouTube Data API reads the library needs. Read-only scope; we never write to YouTube.
//
// Two clients: the venue's own Google project (mode "own", pasted in the admin), or the
// operator's (mode "fallback", from GOOGLE_FALLBACK_CLIENT_ID/SECRET env; optional).
// Playback never depends on any of this: TVs are driven by their TV link, lists are cached.

import { log } from "@bargames/gamekit/server";
import { parseIsoDuration, type GoogleMode, type GoogleStatus, type SearchHit, type Video, type YtPlaylist } from "@ytapp/shared";
import type { Store } from "../store.js";
import { nextMidnight, PACIFIC, zonedParts } from "../time.js";

export const SCOPE = "https://www.googleapis.com/auth/youtube.readonly";
const DEVICE_URL = "https://oauth2.googleapis.com/device/code";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API = "https://www.googleapis.com/youtube/v3";
export const DAILY_UNITS = 10_000;
export const SEARCH_COST = 100;
export const MAX_LIST_VIDEOS = 5000;

/** Steps of the setup wizard (the admin page shows the same numbers). */
export const WIZARD = { project: 1, api: 2, consent: 3, client: 4, paste: 5, signIn: 6 } as const;

export class GoogleError extends Error {
  constructor(
    message: string,
    readonly status = 502,
  ) {
    super(message);
  }
}

export interface FallbackClient {
  clientId: string;
  clientSecret: string;
}

interface OAuthReply {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  error?: string;
  error_description?: string;
  device_code?: string;
  user_code?: string;
  verification_url?: string;
  verification_uri?: string;
  interval?: number;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });

export class GoogleService {
  private access: { token: string; expiresAt: number; mode: GoogleMode } | null = null;
  private pollAbort: AbortController | null = null;
  private pollDone: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: Store,
    private readonly fetchFn: typeof fetch,
    private readonly fallback: FallbackClient | null,
    private readonly now: () => number = Date.now,
  ) {}

  private get g() {
    return this.store.google;
  }

  /** The client for a mode, or null when it isn't set up. */
  private client(mode: GoogleMode): FallbackClient | null {
    if (mode === "fallback") return this.fallback;
    return this.g.clientId && this.g.clientSecret ? { clientId: this.g.clientId, clientSecret: this.g.clientSecret } : null;
  }

  /** The sign-in in use: staff's choice, else Bar Games' when available (nothing to set up). */
  get mode(): GoogleMode {
    const chosen = this.g.mode === "fallback" && !this.fallback ? "own" : this.g.mode;
    return chosen ?? (this.fallback ? "fallback" : "own");
  }

  get signedIn(): boolean {
    return !!this.g.refreshToken && !this.g.disconnected;
  }

  /** Reads work: signed in, or a public read with an API key. */
  get canRead(): boolean {
    return this.signedIn || !!this.g.apiKey;
  }

  // ---------------------------------------------------------------- quota (Pacific day)
  private rollDay(): void {
    const day = zonedParts(PACIFIC, this.now()).date;
    if (this.store.usage.day !== day) this.store.usage = { day, units: 0, searches: 0 };
  }

  private spend(units: number, search = false): void {
    this.rollDay();
    this.store.usage.units += units;
    if (search) this.store.usage.searches += 1;
    this.store.later("usage", 2000);
  }

  quotaResetsAt(): number {
    return nextMidnight(PACIFIC, this.now());
  }

  status(): GoogleStatus {
    this.rollDay();
    const g = this.g;
    const tokenClient = g.tokenMode ? this.client(g.tokenMode) : null;
    let state: GoogleStatus["state"];
    if (g.pending && g.pending.expiresAt > this.now()) state = "pending";
    else if (g.refreshToken && g.disconnected) state = "disconnected";
    else if (g.refreshToken && tokenClient) state = "connected";
    else if (this.client(this.mode)) state = "signed-out";
    else state = "setup";
    const problem = g.problem?.kind === "quota" && g.problem.resetsAt <= this.now() ? null : g.problem;
    return {
      state,
      mode: this.mode,
      fallbackAvailable: !!this.fallback,
      clientId: g.clientId,
      hasClientSecret: !!g.clientSecret,
      hasApiKey: !!g.apiKey,
      account: g.account,
      channelHandle: g.channelHandle ?? "",
      channelId: g.channelId ?? "",
      pending: state === "pending" && g.pending ? { userCode: g.pending.userCode, verificationUrl: g.pending.verificationUrl, expiresAt: g.pending.expiresAt } : null,
      problem,
      lastCheckedAt: g.lastCheckedAt,
      quota: {
        usedToday: this.store.usage.units,
        dailyLimit: DAILY_UNITS,
        resetsAt: this.quotaResetsAt(),
        searchesToday: this.store.usage.searches,
        searchCap: this.store.settings.searchCap,
      },
    };
  }

  // ---------------------------------------------------------------- configuration
  async configure(patch: { mode?: unknown; clientId?: unknown; clientSecret?: unknown; apiKey?: unknown }): Promise<void> {
    const g = this.g;
    if (patch.mode !== undefined) {
      if (patch.mode !== "own" && patch.mode !== "fallback") throw new GoogleError("Unknown sign-in choice.", 400);
      if (patch.mode === "fallback" && !this.fallback) throw new GoogleError("Bar Games' sign-in isn't available on this server.", 400);
      g.mode = patch.mode;
    }
    const str = (v: unknown, max: number, what: string): string => {
      if (typeof v !== "string") throw new GoogleError(`${what} must be text.`, 400);
      const s = v.trim();
      if (s.length > max || /\s/.test(s)) throw new GoogleError(`That doesn't look like a ${what}.`, 400);
      return s;
    };
    let clientChanged = false;
    if (patch.clientId !== undefined) {
      const id = str(patch.clientId, 200, "client id");
      if (id && !/\.apps\.googleusercontent\.com$/.test(id)) throw new GoogleError("A client id ends in .apps.googleusercontent.com. Copy it from the OAuth client's page.", 400);
      clientChanged ||= id !== g.clientId;
      g.clientId = id;
    }
    if (patch.clientSecret !== undefined) {
      const secret = str(patch.clientSecret, 200, "client secret");
      clientChanged ||= secret !== g.clientSecret;
      g.clientSecret = secret;
    }
    if (patch.apiKey !== undefined) g.apiKey = str(patch.apiKey, 100, "API key");
    if (clientChanged && g.tokenMode === "own") {
      // A token from another client won't refresh with this one.
      g.refreshToken = "";
      g.tokenMode = null;
      g.account = "";
      g.channelHandle = g.channelId = "";
      g.disconnected = false;
      this.access = null;
    }
    if (clientChanged && g.problem?.kind === "client-invalid") g.problem = null;
    await this.store.saveGoogle();
  }

  // ---------------------------------------------------------------- device flow
  /** Starts "Sign in with Google": returns the code staff enter at google.com/device. */
  async startSignIn(): Promise<{ userCode: string; verificationUrl: string; expiresAt: number }> {
    const mode = this.mode;
    const client = this.client(mode);
    if (!client) throw new GoogleError(mode === "own" ? "Paste the OAuth client id and secret first (step 5)." : "Bar Games' sign-in isn't available.", 400);
    const r = await this.oauth(DEVICE_URL, { client_id: client.clientId, scope: SCOPE });
    if (r.status !== 200 || !r.body.device_code || !r.body.user_code) {
      await this.clientProblem(r.body.error, r.body.error_description);
      throw new GoogleError(describeOAuthError(r.body.error, r.body.error_description), 400);
    }
    const b = r.body;
    this.g.pending = {
      deviceCode: b.device_code!,
      userCode: b.user_code!,
      verificationUrl: b.verification_url ?? b.verification_uri ?? "https://www.google.com/device",
      expiresAt: this.now() + (b.expires_in ?? 1800) * 1000,
      interval: Math.max(2, b.interval ?? 5),
      mode,
    };
    if (this.g.problem?.kind === "client-invalid") this.g.problem = null;
    await this.store.saveGoogle();
    this.resumePolling();
    return { userCode: this.g.pending.userCode, verificationUrl: this.g.pending.verificationUrl, expiresAt: this.g.pending.expiresAt };
  }

  async cancelSignIn(): Promise<void> {
    this.pollAbort?.abort();
    this.pollAbort = null;
    this.g.pending = null;
    await this.store.saveGoogle();
  }

  async signOut(): Promise<void> {
    await this.cancelSignIn();
    const token = this.g.refreshToken;
    this.g.refreshToken = "";
    this.g.tokenMode = null;
    this.g.account = "";
    this.g.channelHandle = this.g.channelId = "";
    this.g.disconnected = false;
    this.g.problem = null;
    this.access = null;
    await this.store.saveGoogle();
    if (token) {
      // Best effort: let Google forget the grant too.
      await this.fetchFn(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`, { method: "POST", signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
    }
  }

  /** Polls for the sign-in in the background (also after a restart). */
  resumePolling(): void {
    const p = this.g.pending;
    if (!p || this.pollAbort) return;
    if (p.expiresAt <= this.now()) {
      this.g.pending = null;
      void this.store.saveGoogle();
      return;
    }
    const abort = new AbortController();
    this.pollAbort = abort;
    this.pollDone = this.poll(abort.signal)
      .catch((err) => log.warn("google", "sign-in polling failed", { err: String(err) }))
      .finally(() => {
        if (this.pollAbort === abort) this.pollAbort = null;
      });
  }

  private async poll(signal: AbortSignal): Promise<void> {
    let interval = (this.g.pending?.interval ?? 5) * 1000;
    while (!signal.aborted) {
      await sleep(interval, signal);
      const p = this.g.pending;
      if (signal.aborted || !p) return;
      if (p.expiresAt <= this.now()) {
        this.g.pending = null;
        await this.store.saveGoogle();
        return;
      }
      const client = this.client(p.mode);
      if (!client) return;
      let r: { status: number; body: OAuthReply };
      try {
        r = await this.oauth(TOKEN_URL, {
          client_id: client.clientId,
          client_secret: client.clientSecret,
          device_code: p.deviceCode,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        });
      } catch {
        continue; // network blip: keep polling until the code expires
      }
      if (r.body.access_token && r.body.refresh_token) {
        this.g.pending = null;
        this.g.refreshToken = r.body.refresh_token;
        this.g.tokenMode = p.mode;
        this.g.disconnected = false;
        this.g.problem = null;
        this.access = { token: r.body.access_token, expiresAt: this.now() + (r.body.expires_in ?? 3600) * 1000 - 60_000, mode: p.mode };
        await this.store.saveGoogle();
        log.info("google", "signed in", { mode: p.mode });
        await this.check().catch(() => undefined);
        return;
      }
      const e = r.body.error;
      if (e === "authorization_pending") continue;
      if (e === "slow_down") {
        interval += 5000;
        continue;
      }
      // access_denied, expired_token, invalid_client…: stop; the admin shows the state.
      log.warn("google", "sign-in ended", { error: e });
      this.g.pending = null;
      if (e !== "access_denied" && e !== "expired_token") {
        await this.clientProblem(e, r.body.error_description);
        if (!this.g.problem) this.g.problem = { kind: "other", message: describeOAuthError(e, r.body.error_description) };
      }
      await this.store.saveGoogle();
      return;
    }
  }

  private async oauth(url: string, form: Record<string, string>): Promise<{ status: number; body: OAuthReply }> {
    let res: Response;
    try {
      res = await this.fetchFn(url, { method: "POST", body: new URLSearchParams(form), signal: AbortSignal.timeout(15_000) });
    } catch {
      throw new GoogleError("Can't reach Google. Check the box's internet connection.");
    }
    const body = ((await res.json().catch(() => ({}))) ?? {}) as OAuthReply;
    return { status: res.status, body };
  }

  /** invalid_client / deleted_client / unauthorized_client point at the wizard's client step. */
  private async clientProblem(error?: string, _desc?: string): Promise<void> {
    if (error === "invalid_client" || error === "deleted_client" || error === "unauthorized_client") {
      this.g.problem = { kind: "client-invalid", wizardStep: WIZARD.client };
      await this.store.saveGoogle();
    }
  }

  // ---------------------------------------------------------------- tokens
  private async accessToken(force = false): Promise<string | null> {
    const g = this.g;
    if (!g.refreshToken || g.disconnected || !g.tokenMode) return null;
    if (!force && this.access && this.access.mode === g.tokenMode && this.access.expiresAt > this.now()) return this.access.token;
    const client = this.client(g.tokenMode);
    if (!client) return null;
    const r = await this.oauth(TOKEN_URL, { client_id: client.clientId, client_secret: client.clientSecret, refresh_token: g.refreshToken, grant_type: "refresh_token" });
    if (r.body.access_token) {
      this.access = { token: r.body.access_token, expiresAt: this.now() + (r.body.expires_in ?? 3600) * 1000 - 60_000, mode: g.tokenMode };
      return this.access.token;
    }
    if (r.body.error === "invalid_grant") {
      log.warn("google", "sign-in no longer valid", { desc: r.body.error_description });
      g.disconnected = true;
      this.access = null;
      await this.store.saveGoogle();
      throw new GoogleError("Google disconnected. Reconnect on the Google page.", 409);
    }
    await this.clientProblem(r.body.error);
    throw new GoogleError(describeOAuthError(r.body.error, r.body.error_description));
  }

  /** The daily test: refresh the token and read the channel name (1 unit). */
  async check(): Promise<GoogleStatus> {
    this.g.lastCheckedAt = this.now();
    try {
      if (this.signedIn) {
        await this.accessToken(true);
        const r = (await this.api("channels", { part: "snippet", mine: "true" }, 1)) as { items?: { id?: string; snippet?: { title?: string; customUrl?: string } }[] };
        this.g.account = r.items?.[0]?.snippet?.title ?? (r.items?.length ? "" : "(no YouTube channel)");
        this.g.channelHandle = r.items?.[0]?.snippet?.customUrl ?? "";
        this.g.channelId = r.items?.[0]?.id ?? "";
        log.info("google", "sign-in checked", { channel: this.g.account, channelId: r.items?.[0]?.id ?? null, channels: r.items?.length ?? 0 });
        if (this.g.problem?.kind !== "quota") this.g.problem = null;
      }
    } catch (err) {
      log.warn("google", "check failed", { err: String(err) });
    } finally {
      await this.store.saveGoogle();
    }
    return this.status();
  }

  // ---------------------------------------------------------------- Data API
  /** One Data API GET with the signed-in token (or the API key for public reads). */
  async api(resource: string, params: Record<string, string>, cost: number, opts: { search?: boolean; needSignIn?: boolean } = {}): Promise<unknown> {
    this.rollDay();
    const p = this.g.problem;
    if (p?.kind === "quota" && p.resetsAt > this.now()) throw new GoogleError(quotaMessage(this.store.usage.units, p.resetsAt), 429);
    let token = await this.accessToken();
    if (!token && (opts.needSignIn || !this.g.apiKey)) {
      throw new GoogleError(this.g.disconnected ? "Google disconnected. Reconnect on the Google page." : "Sign in with Google first (Google page).", 409);
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      const url = new URL(`${API}/${resource}`);
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
      const headers: Record<string, string> = {};
      if (token) headers.authorization = `Bearer ${token}`;
      else url.searchParams.set("key", this.g.apiKey);
      let res: Response;
      try {
        res = await this.fetchFn(url, { headers, signal: AbortSignal.timeout(20_000) });
      } catch {
        throw new GoogleError("Can't reach YouTube. Check the box's internet connection.");
      }
      this.spend(cost, opts.search);
      const body = (await res.json().catch(() => null)) as { error?: { code?: number; message?: string; errors?: { reason?: string }[]; details?: { reason?: string }[] } } | null;
      if (res.ok) return body;
      const reason = body?.error?.errors?.[0]?.reason ?? body?.error?.details?.[0]?.reason ?? "";
      log.warn("google", "YouTube API error", { resource, status: res.status, reason, message: body?.error?.message?.slice(0, 200) });
      if (res.status === 401 && token && attempt === 0) {
        token = await this.accessToken(true);
        continue;
      }
      if (reason === "quotaExceeded" || reason === "dailyLimitExceeded") {
        this.g.problem = { kind: "quota", resetsAt: this.quotaResetsAt() };
        await this.store.saveGoogle();
        throw new GoogleError(quotaMessage(this.store.usage.units, this.quotaResetsAt()), 429);
      }
      if (reason === "accessNotConfigured" || reason === "SERVICE_DISABLED" || /has not been used|is disabled/i.test(body?.error?.message ?? "")) {
        this.g.problem = { kind: "api-disabled", wizardStep: WIZARD.api };
        await this.store.saveGoogle();
        throw new GoogleError("The YouTube Data API is turned off for this Google project. Turn it on (Google page, step 2).", 409);
      }
      if (reason === "keyInvalid" || reason === "API_KEY_INVALID") throw new GoogleError("Google didn't accept the API key.", 409);
      if (reason === "playlistNotFound" || res.status === 404) throw new GoogleError("YouTube can't find that playlist. If it's private, sign in with the account that owns it.", 404);
      if (reason === "playlistItemsNotAccessible" || reason === "forbidden") throw new GoogleError("That playlist is private to another account.", 403);
      throw new GoogleError(`YouTube answered ${res.status}${body?.error?.message ? `: ${body.error.message}` : ""}.`);
    }
    throw new GoogleError("Google disconnected. Reconnect on the Google page.", 409);
  }

  /** The signed-in account's playlists (1 unit per 50). */
  async myPlaylists(): Promise<Omit<YtPlaylist, "savedAs">[]> {
    const out: Omit<YtPlaylist, "savedAs">[] = [];
    let pageToken = "";
    for (let page = 0; page < 20; page++) {
      const r = (await this.api("playlists", { part: "snippet,contentDetails,status", mine: "true", maxResults: "50", ...(pageToken ? { pageToken } : {}) }, 1, { needSignIn: true })) as {
        items?: { id: string; snippet?: { title?: string; thumbnails?: Record<string, { url?: string }> }; contentDetails?: { itemCount?: number }; status?: { privacyStatus?: string } }[];
        nextPageToken?: string;
      };
      for (const it of r.items ?? []) {
        out.push({
          id: it.id,
          title: it.snippet?.title ?? "(untitled)",
          count: it.contentDetails?.itemCount ?? 0,
          thumb: it.snippet?.thumbnails?.medium?.url ?? it.snippet?.thumbnails?.default?.url ?? null,
          privacy: it.status?.privacyStatus ?? "",
        });
      }
      if (!r.nextPageToken) break;
      pageToken = r.nextPageToken;
    }
    log.info("google", "read the account's playlists", { channel: this.g.account, playlists: out.length });
    return out;
  }

  /** A playlist's title (1 unit). */
  async playlistTitle(playlistId: string): Promise<string> {
    const r = (await this.api("playlists", { part: "snippet", id: playlistId, maxResults: "1" }, 1)) as { items?: { snippet?: { title?: string } }[] };
    const item = r.items?.[0];
    if (!item) throw new GoogleError("YouTube can't find that playlist. If it's private, sign in with the account that owns it.", 404);
    return item.snippet?.title ?? "YouTube playlist";
  }

  /** Every video of a playlist with titles and durations (1 unit per 50 items + 1 per 50 videos). */
  async playlistVideos(playlistId: string): Promise<Video[]> {
    const items: { id: string; title: string; channel: string; privacy: string }[] = [];
    let pageToken = "";
    while (items.length < MAX_LIST_VIDEOS) {
      const r = (await this.api("playlistItems", { part: "snippet,contentDetails,status", playlistId, maxResults: "50", ...(pageToken ? { pageToken } : {}) }, 1)) as {
        items?: { snippet?: { title?: string; videoOwnerChannelTitle?: string }; contentDetails?: { videoId?: string }; status?: { privacyStatus?: string } }[];
        nextPageToken?: string;
      };
      for (const it of r.items ?? []) {
        const id = it.contentDetails?.videoId;
        if (id) items.push({ id, title: it.snippet?.title ?? "", channel: it.snippet?.videoOwnerChannelTitle ?? "", privacy: it.status?.privacyStatus ?? "" });
      }
      if (!r.nextPageToken) break;
      pageToken = r.nextPageToken;
    }
    const details = await this.videoDetails(items.map((i) => i.id));
    return items.map((i) => {
      const d = details.get(i.id);
      if (!d) return { id: i.id, title: i.title || "(unavailable video)", channel: i.channel, unavailable: i.privacy === "private" ? "Private video" : "Deleted or private video" };
      return d;
    });
  }

  /** Titles, channels and durations for video ids (1 unit per 50). Missing ids aren't visible. */
  async videoDetails(ids: string[]): Promise<Map<string, Video>> {
    const out = new Map<string, Video>();
    const unique = [...new Set(ids)];
    for (let i = 0; i < unique.length; i += 50) {
      const batch = unique.slice(i, i + 50);
      const r = (await this.api("videos", { part: "snippet,contentDetails,status", id: batch.join(","), maxResults: "50" }, 1)) as {
        items?: { id: string; snippet?: { title?: string; channelTitle?: string }; contentDetails?: { duration?: string }; status?: { uploadStatus?: string } }[];
      };
      for (const it of r.items ?? []) {
        const v: Video = { id: it.id, title: it.snippet?.title ?? "", channel: it.snippet?.channelTitle ?? "" };
        const dur = it.contentDetails?.duration ? parseIsoDuration(it.contentDetails.duration) : undefined;
        if (dur !== undefined) v.durationSec = dur;
        if (it.status?.uploadStatus && !["processed", "uploaded"].includes(it.status.uploadStatus)) v.unavailable = "Not playable";
        out.set(it.id, v);
      }
    }
    return out;
  }

  /** In-app search: 100 units, capped per day by the admin's setting. */
  async search(q: string): Promise<SearchHit[]> {
    this.rollDay();
    const cap = this.store.settings.searchCap;
    if (cap <= 0) throw new GoogleError("Search is turned off (Settings). Add videos by link, or build the list in YouTube.", 409);
    if (this.store.usage.searches >= cap) throw new GoogleError(`That's today's ${cap} searches (each costs 100 of YouTube's 10,000 daily units). Add by link, or raise the cap in Settings.`, 429);
    const r = (await this.api("search", { part: "snippet", type: "video", q, maxResults: "20", safeSearch: "moderate" }, SEARCH_COST, { search: true })) as {
      items?: { id?: { videoId?: string }; snippet?: { title?: string; channelTitle?: string } }[];
    };
    return (r.items ?? [])
      .filter((it) => it.id?.videoId)
      .map((it) => ({ id: it.id!.videoId!, title: decodeEntities(it.snippet?.title ?? ""), channel: decodeEntities(it.snippet?.channelTitle ?? "") }));
  }

  /** Stops polling and waits for anything it was still writing. */
  async close(): Promise<void> {
    this.pollAbort?.abort();
    await this.pollDone;
  }
}

/** Search snippets come HTML-escaped. */
function decodeEntities(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|#39);/g, (_, e: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" })[e] ?? _);
}

function quotaMessage(used: number, resetsAt: number): string {
  const when = new Date(resetsAt).toLocaleTimeString("en-US", { timeZone: PACIFIC, hour: "numeric", minute: "2-digit" });
  return `YouTube's daily limit is used up (${used.toLocaleString("en-US")} units today). It resets at midnight Pacific (${when} PT). Playback isn't affected.`;
}

export function describeOAuthError(error?: string, desc?: string): string {
  switch (error) {
    case "invalid_client":
    case "deleted_client":
      return "Google doesn't recognize that OAuth client (wrong id or secret, or it was deleted). Check step 4.";
    case "unauthorized_client":
      return 'This OAuth client can\'t use device sign-in. Create one of type "TVs and Limited Input devices" (step 4).';
    case "invalid_scope":
      return "Google refused the YouTube read-only permission for this client.";
    case "org_internal":
      return 'The consent screen is set to "Internal". Set it to External and publish it (step 3).';
    case "access_denied":
      return "Sign-in was declined on the phone.";
    case "expired_token":
      return "The sign-in code expired. Start again.";
    default:
      return `Google sign-in failed${error ? ` (${error}${desc ? `: ${desc}` : ""})` : ""}.`;
  }
}
