// The library: saved lists (read from YouTube, or built here), refresh, edit, combine.

import { randomBytes } from "node:crypto";
import { log } from "@bargames/gamekit/server";
import { combine, isVideoId, parseChannelLink, parseYouTubeLink, thumbUrl, type ChannelRef, type ListSummary, type SavedList, type Video } from "@ytapp/shared";
import { GoogleError, MAX_LIST_VIDEOS, type GoogleService } from "./google/google.js";
import type { Store } from "./store.js";

export const MAX_LISTS = 200;

export class LibraryError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

const newId = () => randomBytes(6).toString("base64url");

export function summarize(l: SavedList): ListSummary {
  const first = l.videos.find((v) => !v.unavailable);
  return {
    id: l.id,
    name: l.name,
    source: l.source,
    shuffle: l.shuffle,
    loop: l.loop,
    noRepeatHours: l.noRepeatHours,
    count: l.videos.length,
    playable: l.videos.filter((v) => !v.unavailable).length,
    thumb: first ? thumbUrl(first.id) : null,
    updatedAt: l.updatedAt,
    ...(l.refreshedAt ? { refreshedAt: l.refreshedAt } : {}),
    ...(l.refreshError ? { refreshError: l.refreshError } : {}),
  };
}

const cleanName = (v: unknown, fallback: string): string => {
  const s = typeof v === "string" ? v.trim().replace(/\s+/g, " ").slice(0, 80) : "";
  return s || fallback;
};

export class Library {
  constructor(
    private readonly store: Store,
    private readonly google: GoogleService,
    private readonly fetchFn: typeof fetch,
    private readonly now: () => number = Date.now,
  ) {}

  all(): SavedList[] {
    return this.store.lists;
  }

  get(id: string): SavedList {
    const l = this.store.lists.find((x) => x.id === id);
    if (!l) throw new LibraryError("That list isn't in the library any more.", 404);
    return l;
  }

  find(id: string | null): SavedList | undefined {
    return id ? this.store.lists.find((x) => x.id === id) : undefined;
  }

  private room(): void {
    if (this.store.lists.length >= MAX_LISTS) throw new LibraryError(`The library holds ${MAX_LISTS} lists. Delete one first.`, 409);
  }

  private async add(list: Omit<SavedList, "id" | "createdAt" | "updatedAt">): Promise<SavedList> {
    this.room();
    const l: SavedList = { ...list, id: newId(), createdAt: this.now(), updatedAt: this.now() };
    this.store.lists.push(l);
    await this.store.saveLists();
    return l;
  }

  /** An empty list built here. */
  createLocal(name: unknown, videos: Video[] = []): Promise<SavedList> {
    return this.add({ name: cleanName(name, "New list"), source: { kind: "local" }, videos: videos.slice(0, MAX_LIST_VIDEOS), shuffle: false, loop: true, noRepeatHours: 0 });
  }

  /** Reads a YouTube playlist into the library (or refreshes it if it's already there). */
  async importPlaylist(playlistId: string, name?: string): Promise<SavedList> {
    const existing = this.store.lists.find((l) => l.source.kind === "youtube" && l.source.playlistId === playlistId);
    if (existing) return this.refresh(existing.id);
    this.room();
    const title = name || (await this.google.playlistTitle(playlistId));
    const videos = await this.google.playlistVideos(playlistId);
    return this.add({ name: cleanName(title, "YouTube playlist"), source: { kind: "youtube", playlistId }, videos, shuffle: true, loop: true, noRepeatHours: 0, refreshedAt: this.now() });
  }

  /** A channel's newest uploads as a list (refreshed like a YouTube list). */
  async importChannel(ref: ChannelRef, opts: { limit?: unknown; skipShorts?: unknown } = {}): Promise<SavedList> {
    const limit = Number(opts.limit ?? 200);
    if (!Number.isInteger(limit) || limit < 10 || limit > 1000) throw new LibraryError("Newest videos: 10 to 1000.");
    const skipShorts = opts.skipShorts === undefined ? true : !!opts.skipShorts;
    const c = await this.google.channel(ref);
    const existing = this.store.lists.find((l) => l.source.kind === "channel" && l.source.channelId === c.id);
    if (existing && existing.source.kind === "channel") {
      existing.source.limit = limit;
      existing.source.skipShorts = skipShorts;
      return this.refresh(existing.id);
    }
    this.room();
    const videos = await this.google.channelVideos(c.uploadsId, limit, skipShorts);
    return this.add({
      name: cleanName(c.title, "YouTube channel"),
      source: { kind: "channel", channelId: c.id, uploadsId: c.uploadsId, handle: c.handle, limit, skipShorts },
      videos,
      shuffle: true,
      loop: true,
      noRepeatHours: 0,
      refreshedAt: this.now(),
    });
  }

  /** "Paste a link": a playlist imports the list, a channel its newest uploads, a video a one-video list. */
  async importLink(link: unknown): Promise<SavedList> {
    const p = typeof link === "string" ? parseYouTubeLink(link) : null;
    const ch = !p && typeof link === "string" ? parseChannelLink(link) : null;
    if (ch) return this.importChannel(ch);
    if (!p) throw new LibraryError("That isn't a YouTube playlist, channel or video link.");
    if (p.kind === "playlist" || p.listId) return this.importPlaylist(p.kind === "playlist" ? p.listId : p.listId!);
    const [video] = await this.lookupVideos([p.videoId]);
    return this.createLocal(video!.title || "New list", [video!]);
  }

  /** Re-reads a YouTube list or channel. Keeps the old videos (and notes why) when YouTube can't be read. */
  async refresh(id: string): Promise<SavedList> {
    const l = this.get(id);
    const src = l.source;
    if (src.kind === "local") return l;
    try {
      const videos = src.kind === "youtube" ? await this.google.playlistVideos(src.playlistId) : await this.google.channelVideos(src.uploadsId, src.limit, src.skipShorts);
      l.videos = videos;
      l.refreshedAt = this.now();
      delete l.refreshError;
      l.updatedAt = this.now();
    } catch (err) {
      l.refreshError = err instanceof Error ? err.message : String(err);
      await this.store.saveLists();
      throw err;
    }
    await this.store.saveLists();
    return l;
  }

  /** Nightly / "Refresh all": every YouTube list, stopping early if quota or sign-in fails. */
  async refreshAll(): Promise<{ refreshed: number; failed: number; stopped?: string }> {
    let refreshed = 0;
    let failed = 0;
    for (const l of this.store.lists.filter((x) => x.source.kind !== "local")) {
      try {
        await this.refresh(l.id);
        refreshed++;
      } catch (err) {
        failed++;
        if (err instanceof GoogleError && (err.status === 429 || err.status === 409)) {
          log.warn("library", "refresh stopped", { err: err.message });
          return { refreshed, failed, stopped: err.message };
        }
      }
    }
    return { refreshed, failed };
  }

  async update(id: string, patch: Record<string, unknown>): Promise<SavedList> {
    const l = this.get(id);
    if (patch.name !== undefined) l.name = cleanName(patch.name, l.name);
    if (patch.shuffle !== undefined) l.shuffle = !!patch.shuffle;
    if (patch.loop !== undefined) l.loop = !!patch.loop;
    if (patch.noRepeatHours !== undefined) {
      const n = Number(patch.noRepeatHours);
      if (!Number.isFinite(n) || n < 0 || n > 168) throw new LibraryError("No-repeat hours: 0 to 168.");
      l.noRepeatHours = Math.round(n);
    }
    if (l.source.kind === "channel" && (patch.limit !== undefined || patch.skipShorts !== undefined)) {
      if (patch.limit !== undefined) {
        const n = Number(patch.limit);
        if (!Number.isInteger(n) || n < 10 || n > 1000) throw new LibraryError("Newest videos: 10 to 1000.");
        l.source.limit = n;
      }
      if (patch.skipShorts !== undefined) l.source.skipShorts = !!patch.skipShorts;
      await this.store.saveLists();
      return this.refresh(l.id);
    }
    if (patch.videoIds !== undefined) {
      // Reorder / remove (local lists only; a YouTube list is edited in YouTube).
      if (l.source.kind !== "local") throw new LibraryError("This list is read from YouTube: edit it there, or make a copy to edit here.", 409);
      if (!Array.isArray(patch.videoIds) || !patch.videoIds.every((x) => typeof x === "string")) throw new LibraryError("videoIds must be a list of ids.");
      const byId = new Map(l.videos.map((v) => [v.id, v]));
      const next = (patch.videoIds as string[]).map((vid) => byId.get(vid)).filter((v): v is Video => !!v);
      l.videos = [...new Map(next.map((v) => [v.id, v])).values()];
    }
    l.updatedAt = this.now();
    await this.store.saveLists();
    return l;
  }

  async remove(id: string): Promise<void> {
    this.get(id);
    this.store.lists = this.store.lists.filter((l) => l.id !== id);
    await this.store.saveLists();
  }

  /** "Make a copy to edit here". */
  async copy(id: string, name?: unknown): Promise<SavedList> {
    const l = this.get(id);
    const c = await this.createLocal(name ?? `${l.name} (copy)`, l.videos.map((v) => ({ ...v })));
    c.shuffle = l.shuffle;
    c.loop = l.loop;
    c.noRepeatHours = l.noRepeatHours;
    await this.store.saveLists();
    return c;
  }

  /** Adds videos to a local list: by links/ids, or every video of another list ("combine"). */
  async addTo(id: string, body: { links?: unknown; videoIds?: unknown; fromListId?: unknown }): Promise<{ list: SavedList; added: number }> {
    const l = this.get(id);
    if (l.source.kind !== "local") throw new LibraryError("This list is read from YouTube: add videos there, or make a copy to edit here.", 409);
    let incoming: Video[] = [];
    if (typeof body.fromListId === "string") incoming = this.get(body.fromListId).videos;
    else {
      const ids: string[] = [];
      const playlists: string[] = [];
      const raw = [
        ...(typeof body.links === "string" ? body.links.split(/[\s,]+/) : Array.isArray(body.links) ? body.links : []),
        ...(Array.isArray(body.videoIds) ? body.videoIds : []),
      ];
      for (const item of raw) {
        if (typeof item !== "string" || !item.trim()) continue;
        const p = parseYouTubeLink(item);
        if (!p) throw new LibraryError(`Not a YouTube link: ${item.slice(0, 60)}`);
        if (p.kind === "video") ids.push(p.videoId);
        else playlists.push(p.listId);
      }
      if (!ids.length && !playlists.length) throw new LibraryError("Paste one or more YouTube links.");
      incoming = await this.lookupVideos(ids);
      for (const pl of playlists) incoming.push(...(await this.google.playlistVideos(pl)));
    }
    const before = l.videos.length;
    l.videos = combine(l.videos, incoming).slice(0, MAX_LIST_VIDEOS);
    l.updatedAt = this.now();
    await this.store.saveLists();
    return { list: l, added: l.videos.length - before };
  }

  /**
   * Titles for video ids: the Data API when we can read (1 unit per 50), else YouTube's
   * oEmbed (free, no key), else the bare id so a link still works with no Google at all.
   */
  async lookupVideos(ids: string[]): Promise<Video[]> {
    const valid = ids.filter(isVideoId);
    let found = new Map<string, Video>();
    if (this.google.canRead && valid.length) {
      try {
        found = await this.google.videoDetails(valid);
      } catch (err) {
        log.warn("library", "video lookup failed, using oEmbed", { err: String(err) });
      }
    }
    const out: Video[] = [];
    for (const id of valid) {
      const v = found.get(id) ?? (await this.oembed(id));
      out.push(v);
    }
    return out;
  }

  private async oembed(id: string): Promise<Video> {
    try {
      const url = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(`https://www.youtube.com/watch?v=${id}`)}`;
      const res = await this.fetchFn(url, { signal: AbortSignal.timeout(10_000) });
      if (res.ok) {
        const j = (await res.json()) as { title?: string; author_name?: string };
        return { id, title: j.title ?? id, channel: j.author_name ?? "" };
      }
      if (res.status === 401 || res.status === 403 || res.status === 404) return { id, title: id, channel: "", unavailable: "Private or deleted video" };
    } catch {
      /* offline: keep the id */
    }
    return { id, title: id, channel: "" };
  }

  /** Every title we know, for Now Playing (videos played that aren't in the queue). */
  titleOf(videoId: string): Video | undefined {
    for (const l of this.store.lists) {
      const v = l.videos.find((x) => x.id === videoId);
      if (v) return v;
    }
    return undefined;
  }
}
