// Pasted YouTube links and TV codes.

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const LIST_ID = /^[A-Za-z0-9_-]{10,64}$/;

export const isVideoId = (s: string): boolean => VIDEO_ID.test(s);
export const isPlaylistId = (s: string): boolean => LIST_ID.test(s);

export type ParsedLink = { kind: "video"; videoId: string; listId?: string } | { kind: "playlist"; listId: string };

/**
 * A playlist or video from what staff paste: a watch/share/shorts/playlist link, or a bare
 * id. A watch link that also names a list counts as the video (the list is kept alongside).
 * Mixes and Watch Later ("RD…", "WL", "LL") can't be read through the API, so they're not lists.
 */
export function parseYouTubeLink(input: string): ParsedLink | null {
  const text = input.trim();
  if (!text) return null;
  if (VIDEO_ID.test(text)) return { kind: "video", videoId: text };
  if (/^(PL|UU|FL|OL)[A-Za-z0-9_-]{8,62}$/.test(text)) return { kind: "playlist", listId: text };

  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^(www|m|music)\./, "");
  const list = url.searchParams.get("list") ?? "";
  const goodList = LIST_ID.test(list) && !/^(RD|WL$|LL$)/.test(list) ? list : "";

  let videoId = "";
  if (host === "youtu.be") videoId = url.pathname.slice(1).split("/")[0] ?? "";
  else if (host === "youtube.com" || host === "youtube-nocookie.com") {
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] === "watch") videoId = url.searchParams.get("v") ?? "";
    else if (["shorts", "embed", "live", "v"].includes(parts[0] ?? "")) videoId = parts[1] ?? "";
    else if (parts[0] === "playlist") return goodList ? { kind: "playlist", listId: goodList } : null;
  } else return null;

  if (VIDEO_ID.test(videoId)) return goodList ? { kind: "video", videoId, listId: goodList } : { kind: "video", videoId };
  return goodList ? { kind: "playlist", listId: goodList } : null;
}

export type ChannelRef = { handle: string } | { channelId: string } | { username: string };

/**
 * A channel from what staff paste: "@handle", a youtube.com/@handle, /channel/UC…, or
 * /user/name link. Old /c/name links can't be looked up through the API (use the @handle).
 */
export function parseChannelLink(input: string): ChannelRef | null {
  const text = input.trim();
  if (/^@[A-Za-z0-9._-]{3,100}$/.test(text)) return { handle: text };
  if (/^UC[A-Za-z0-9_-]{22}$/.test(text)) return { channelId: text };
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^(www|m|music)\./, "");
  if (host !== "youtube.com") return null;
  const parts = url.pathname.split("/").filter(Boolean).map((p) => decodeURIComponent(p));
  const first = parts[0] ?? "";
  if (/^@[^/]{3,100}$/.test(first)) return { handle: first };
  if (first === "channel" && /^UC[A-Za-z0-9_-]{22}$/.test(parts[1] ?? "")) return { channelId: parts[1]! };
  if (first === "user" && parts[1]) return { username: parts[1] };
  return null;
}

/** "Link with TV code" codes are 12 digits; staff type them with spaces or dashes. */
export function normalizeTvCode(input: string): string | null {
  const digits = input.replace(/[\s-]/g, "");
  return /^\d{12}$/.test(digits) ? digits : null;
}

export const thumbUrl = (videoId: string): string => `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;

/** ISO 8601 durations from the Data API ("PT1H2M3S") in seconds. */
export function parseIsoDuration(iso: string): number | undefined {
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(iso);
  if (!m) return undefined;
  const [, d, h, mi, s] = m.map((x) => Number(x ?? 0));
  return (d ?? 0) * 86400 + (h ?? 0) * 3600 + (mi ?? 0) * 60 + (s ?? 0);
}
