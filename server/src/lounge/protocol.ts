// YouTube "Lounge": the protocol YouTube's own phone remote uses to drive the YouTube app
// on a TV linked with "Link with TV code". It is UNOFFICIAL and undocumented: everything
// that knows its shape lives in this folder (protocol.ts: wire format, client.ts: HTTP).
// Ported from pyytlounge 3.6.0 (wrapper.py) plus the queue commands YouTube's remote sends.
// When YouTube changes it, the failures surface as LoungeError with a clear kind.

export const LOUNGE_BASE = "https://www.youtube.com/api/lounge";

export type LoungeErrorKind =
  /** The TV code was wrong or expired. */
  | "bad-code"
  /** YouTube no longer knows this TV link (revoked, or the TV was unlinked): re-link. */
  | "unlinked"
  /** The lounge token expired: refresh it and connect again. */
  | "expired"
  /** The session (SID) is gone: connect again. */
  | "session"
  /** Couldn't reach YouTube. */
  | "network"
  /** YouTube answered with something we don't understand (protocol changed?). */
  | "protocol";

export class LoungeError extends Error {
  constructor(
    readonly kind: LoungeErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "LoungeError";
  }
}

export interface LoungeEvent {
  id: number;
  name: string;
  args: unknown[];
}

/**
 * The bind endpoint answers with length-prefixed chunks:
 *   "<n>\n[[0,["c","SID","",8]],[1,["S","gsession"]]]\n"
 * where n counts the characters of the JSON and its newline. Streamed responses split
 * anywhere, so this buffers until a whole chunk is in. Like pyytlounge it counts by
 * line, so a length that's slightly off (bytes vs characters) still parses.
 */
export class ChunkParser {
  private buf = "";
  private remaining = 0;
  private lines: string[] = [];

  push(text: string): LoungeEvent[][] {
    this.buf += text;
    const out: LoungeEvent[][] = [];
    let nl: number;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (this.remaining <= 0) {
        if (!line.trim()) continue;
        const n = Number(line.trim());
        if (!Number.isInteger(n) || n <= 0) throw new LoungeError("protocol", `Unexpected Lounge data: ${line.slice(0, 40)}`);
        this.remaining = n;
        this.lines = [];
        continue;
      }
      this.lines.push(line);
      this.remaining -= line.length + 1;
      if (this.remaining <= 0) {
        out.push(parseEvents(this.lines.join("")));
        this.remaining = 0;
        this.lines = [];
      }
    }
    return out;
  }

  /** Whatever is left when the response ends (a final chunk without its newline). */
  end(): LoungeEvent[][] {
    if (this.remaining > 0 && (this.lines.length || this.buf)) {
      const json = this.lines.join("") + this.buf;
      this.buf = "";
      this.remaining = 0;
      this.lines = [];
      return json.trim() ? [parseEvents(json)] : [];
    }
    return [];
  }
}

export function parseEvents(json: string): LoungeEvent[] {
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new LoungeError("protocol", "Lounge sent data that isn't JSON.");
  }
  if (!Array.isArray(data)) throw new LoungeError("protocol", "Lounge sent an unexpected shape.");
  const events: LoungeEvent[] = [];
  for (const item of data) {
    if (!Array.isArray(item) || typeof item[0] !== "number" || !Array.isArray(item[1])) continue;
    const [name, ...args] = item[1] as unknown[];
    if (typeof name === "string") events.push({ id: item[0], name, args });
  }
  return events;
}

/** The form body of one command (pyytlounge's _command): count, ofs, req0__sc, req0_<k>. */
export function commandBody(command: string, params: Record<string, string | number> | undefined, ofs: number): URLSearchParams {
  const body = new URLSearchParams({ count: "1", ofs: String(ofs), req0__sc: command });
  for (const [k, v] of Object.entries(params ?? {})) body.set(`req0_${k}`, String(v));
  return body;
}

/** The TV's playback state codes (pyytlounge models.State). */
export function playState(code: unknown): "playing" | "paused" | "buffering" | "stopped" | "ended" | "ad" | "unknown" {
  switch (Number(code)) {
    case 1:
      return "playing";
    case 2:
      return "paused";
    case 3:
    case 5:
      return "buffering";
    case 0:
      return "ended";
    case -1:
      return "stopped";
    case 1081:
      return "ad";
    default:
      return "unknown";
  }
}

/** The screen's own name from a loungeStatus event (devices is a JSON string). */
export function screenNameFromStatus(arg: unknown): string | null {
  const devicesJson = (arg as { devices?: unknown } | null)?.devices;
  if (typeof devicesJson !== "string") return null;
  try {
    const devices = JSON.parse(devicesJson) as { type?: string; name?: string }[];
    const screen = devices.find((d) => d.type === "LOUNGE_SCREEN");
    return screen?.name ?? null;
  } catch {
    return null;
  }
}
