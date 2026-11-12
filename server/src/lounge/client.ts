// HTTP side of the Lounge protocol (see protocol.ts for the caveats). One LoungeSession per
// linked TV: connect (bind), then long-poll events, and send commands on the same session.

import { randomUUID } from "node:crypto";
import { ChunkParser, commandBody, LOUNGE_BASE, LoungeError, type LoungeEvent } from "./protocol.js";

export interface ScreenLink {
  screenId: string;
  loungeToken: string;
  screenName: string;
}

const json = async (res: Response): Promise<unknown> => {
  try {
    return await res.json();
  } catch {
    return null;
  }
};

async function post(fetchFn: typeof fetch, url: string, body: URLSearchParams, signal?: AbortSignal): Promise<Response> {
  try {
    return await fetchFn(url, { method: "POST", body, signal: signal ?? AbortSignal.timeout(15_000) });
  } catch (err) {
    if ((err as Error).name === "AbortError" && signal?.aborted) throw err;
    throw new LoungeError("network", "Couldn't reach YouTube.");
  }
}

/** Trades the 12-digit code from the TV's "Link with TV code" screen for a lasting link. */
export async function pairWithCode(code: string, fetchFn: typeof fetch = fetch): Promise<ScreenLink> {
  const res = await post(fetchFn, `${LOUNGE_BASE}/pairing/get_screen`, new URLSearchParams({ pairing_code: code }));
  if (res.status >= 400 && res.status < 500) throw new LoungeError("bad-code", "YouTube didn't accept that TV code. Codes expire after a few minutes: show a fresh one on the TV and try again.");
  if (!res.ok) throw new LoungeError("network", `YouTube answered ${res.status} to the TV code.`);
  const screen = ((await json(res)) as { screen?: { screenId?: string; loungeToken?: string; name?: string } } | null)?.screen;
  if (!screen?.screenId || !screen.loungeToken) throw new LoungeError("protocol", "YouTube's answer to the TV code had no screen in it.");
  return { screenId: screen.screenId, loungeToken: screen.loungeToken, screenName: screen.name ?? "" };
}

/** A fresh lounge token for a linked screen. "unlinked" when YouTube no longer knows it. */
export async function refreshLoungeToken(screenId: string, fetchFn: typeof fetch = fetch): Promise<string> {
  const res = await post(fetchFn, `${LOUNGE_BASE}/pairing/get_lounge_token_batch`, new URLSearchParams({ screen_ids: screenId }));
  if (res.status === 400 || res.status === 404 || res.status === 410) throw new LoungeError("unlinked", "YouTube no longer accepts this TV's link. Link it again with a new TV code.");
  if (!res.ok) throw new LoungeError("network", `YouTube answered ${res.status} when renewing the TV link.`);
  const screens = ((await json(res)) as { screens?: { screenId?: string; loungeToken?: string }[] } | null)?.screens;
  if (!Array.isArray(screens)) throw new LoungeError("protocol", "YouTube's answer when renewing the TV link was unexpected.");
  const s = screens.find((x) => x.screenId === screenId) ?? screens[0];
  if (!s?.loungeToken) throw new LoungeError("unlinked", "YouTube no longer accepts this TV's link. Link it again with a new TV code.");
  return s.loungeToken;
}

export interface SessionOptions {
  screenId: string;
  loungeToken: string;
  /** Shown on the TV as the connected remote ("Bar Games"). */
  deviceName: string;
  /** Stable per TV link, so the TV sees the same remote after a restart. */
  deviceId?: string;
  fetch?: typeof fetch;
  onEvent: (e: LoungeEvent) => void;
}

/** Status/reason → what went wrong with a session (pyytlounge _handle_session_result). */
function sessionFailure(status: number, text: string): LoungeError | null {
  if (status === 401) return new LoungeError("expired", "The TV link's token expired.");
  if (status === 400 && /Unknown SID/i.test(text)) return new LoungeError("session", "The TV session ended.");
  if (status === 410) return new LoungeError("session", "The TV session ended.");
  if (status === 404) return new LoungeError("session", "The TV session ended.");
  if (status >= 400) return new LoungeError(status >= 500 ? "network" : "protocol", `YouTube answered ${status}.`);
  return null;
}

export class LoungeSession {
  readonly deviceId: string;
  private sid: string | null = null;
  private gsession: string | null = null;
  private aid = 0;
  private ofs = 1;
  private readonly fetchFn: typeof fetch;

  constructor(private readonly o: SessionOptions) {
    this.deviceId = o.deviceId ?? randomUUID();
    this.fetchFn = o.fetch ?? fetch;
  }

  get connected(): boolean {
    return !!this.sid && !!this.gsession;
  }

  private handle(events: LoungeEvent[]): void {
    for (const e of events) {
      if (e.name === "c" && typeof e.args[0] === "string") this.sid = e.args[0];
      else if (e.name === "S" && typeof e.args[0] === "string") this.gsession = e.args[0];
      else this.o.onEvent(e);
      if (e.id > this.aid) this.aid = e.id;
    }
  }

  private params(extra: Record<string, string>): URLSearchParams {
    return new URLSearchParams({
      name: this.o.deviceName,
      loungeIdToken: this.o.loungeToken,
      SID: this.sid ?? "",
      AID: String(this.aid),
      gsessionid: this.gsession ?? "",
      device: "REMOTE_CONTROL",
      app: "youtube-desktop",
      VER: "8",
      v: "2",
      ...extra,
    });
  }

  /** Opens a session (bind). Throws "expired" when the lounge token needs refreshing. */
  async connect(): Promise<void> {
    this.sid = this.gsession = null;
    this.aid = 0;
    const body = new URLSearchParams({
      app: "web",
      "mdx-version": "3",
      name: this.o.deviceName,
      id: this.deviceId,
      device: "REMOTE_CONTROL",
      capabilities: "que,dsdtr,atp",
      magnaKey: "cloudPairedDevice",
      ui: "false",
      deviceContext: "user_agent=dunno&window_width_points=&window_height_points=&os_name=android&ms=",
      theme: "cl",
      loungeIdToken: this.o.loungeToken,
    });
    const res = await post(this.fetchFn, `${LOUNGE_BASE}/bc/bind?RID=1&VER=8&CVER=1&auth_failure_option=send_error`, body);
    const text = await res.text().catch(() => "");
    if (res.status === 401) throw new LoungeError("expired", "The TV link's token expired.");
    if (!res.ok) throw new LoungeError(res.status >= 500 ? "network" : "protocol", `YouTube answered ${res.status} when connecting to the TV.`);
    const parser = new ChunkParser();
    for (const events of [...parser.push(text), ...parser.end()]) this.handle(events);
    this.ofs = 1;
    if (!this.connected) throw new LoungeError("protocol", "YouTube didn't open a TV session (no SID).");
  }

  /**
   * One long poll: delivers events until YouTube closes the response (normal, every few
   * minutes) or `signal` aborts. Throws "session"/"expired" when it's time to reconnect.
   */
  async subscribe(signal: AbortSignal): Promise<void> {
    if (!this.connected) throw new LoungeError("session", "Not connected.");
    const url = `${LOUNGE_BASE}/bc/bind?${this.params({ RID: "rpc", CI: "0", TYPE: "xmlhttp" })}`;
    let res: Response;
    try {
      res = await this.fetchFn(url, { signal });
    } catch (err) {
      if (signal.aborted) return;
      throw new LoungeError("network", `Couldn't reach YouTube (${(err as Error).message}).`);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const fail = sessionFailure(res.status, `${res.statusText} ${text}`);
      if (fail?.kind === "session" || fail?.kind === "expired") this.sid = this.gsession = null;
      throw fail ?? new LoungeError("protocol", `YouTube answered ${res.status}.`);
    }
    if (!res.body) return;
    const parser = new ChunkParser();
    const decoder = new TextDecoder();
    const reader = res.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const events of parser.push(decoder.decode(value, { stream: true }))) this.handle(events);
        if (!this.connected) break;
      }
      for (const events of parser.end()) this.handle(events);
    } catch (err) {
      if (signal.aborted) return;
      if (err instanceof LoungeError) throw err;
      throw new LoungeError("network", "The connection to YouTube dropped.");
    } finally {
      reader.releaseLock();
    }
  }

  /** Sends one command ("setPlaylist", "pause", "next", "setVolume"…). */
  async command(name: string, params?: Record<string, string | number>): Promise<void> {
    if (!this.connected) throw new LoungeError("session", "Not connected to the TV.");
    const body = commandBody(name, params, this.ofs);
    this.ofs += 1;
    const res = await post(this.fetchFn, `${LOUNGE_BASE}/bc/bind?${this.params({ RID: String(this.ofs) })}`, body);
    if (res.ok) return void (await res.arrayBuffer().catch(() => undefined));
    const text = await res.text().catch(() => "");
    const fail = sessionFailure(res.status, `${res.statusText} ${text}`);
    if (fail?.kind === "session" || fail?.kind === "expired") this.sid = this.gsession = null;
    throw fail ?? new LoungeError("protocol", `YouTube answered ${res.status}.`);
  }

  /** Tells the TV this remote is leaving (best effort). */
  async disconnect(): Promise<void> {
    if (!this.connected) return;
    const body = new URLSearchParams({ ui: "", TYPE: "terminate", clientDisconnectReason: "MDX_SESSION_DISCONNECT_REASON_DISCONNECTED_BY_USER" });
    await post(this.fetchFn, `${LOUNGE_BASE}/bc/bind?${this.params({ RID: String(this.ofs), CVER: "1", auth_failure_option: "send_error" })}`, body).catch(() => undefined);
    this.sid = this.gsession = null;
  }
}
