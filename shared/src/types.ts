// Types shared by the server and the client.

export const DEFAULT_NAME = "YouTube";

/** One video in a list. Titles and thumbnails come from YouTube when the list is read. */
export interface Video {
  id: string;
  title: string;
  channel: string;
  durationSec?: number;
  /** Why the TV can't play it (private, deleted…): left out of queues. */
  unavailable?: string;
}

export type ListSource =
  /** Read from a YouTube playlist; Refresh replaces the videos with YouTube's. */
  | { kind: "youtube"; playlistId: string }
  /** Built in this app (copied, combined, pasted links, saved from a TV). */
  | { kind: "local" };

export interface ListRules {
  shuffle: boolean;
  loop: boolean;
  /** Don't replay a video played within this many hours (0 = off). Shuffle only. */
  noRepeatHours: number;
}

export interface SavedList extends ListRules {
  id: string;
  name: string;
  source: ListSource;
  videos: Video[];
  createdAt: number;
  updatedAt: number;
  /** Last successful read from YouTube (youtube lists). */
  refreshedAt?: number;
  /** The last refresh's problem, cleared by the next good one. */
  refreshError?: string;
}

/** A list without its videos (the library page). */
export interface ListSummary extends ListRules {
  id: string;
  name: string;
  source: ListSource;
  count: number;
  playable: number;
  thumb: string | null;
  updatedAt: number;
  refreshedAt?: number;
  refreshError?: string;
}

/** YouTube playback states as the TV reports them. */
export type PlayState = "playing" | "paused" | "buffering" | "stopped" | "ended" | "ad" | "unknown";

export type TvLink =
  /** Linked and the session is up. */
  | "connected"
  /** Linked, trying to reach YouTube or the TV. */
  | "connecting"
  /** YouTube no longer accepts this TV's link: staff re-enter a TV code. */
  | "relink";

export interface NowPlaying {
  videoId: string;
  title: string;
  channel: string;
  state: PlayState;
  positionSec: number;
  durationSec: number;
  updatedAt: number;
}

export interface TvQueueInfo {
  listId: string | null;
  listName: string;
  /** Position in the queue (0-based) and its length. */
  index: number;
  length: number;
  loop: boolean;
  /** Next few titles. */
  upNext: { id: string; title: string }[];
  /** The TV is playing something we didn't queue (someone used the TV's remote). */
  detached: boolean;
}

/** A linked TV as staff see it. */
export interface TvInfo {
  id: string;
  name: string;
  /** The name the TV's YouTube app reports. */
  screenName: string;
  link: TvLink;
  message: string;
  nowPlaying: NowPlaying | null;
  queue: TvQueueInfo | null;
  volume: number | null;
  muted: boolean;
  linkedAt: number;
}

/** What guests see on "/": no ids, codes or tokens. */
export interface PublicTv {
  name: string;
  title: string;
  channel: string;
  thumb: string;
  playing: boolean;
  listName: string;
}

export type GoogleMode = "own" | "fallback";

export type GoogleState =
  /** No OAuth client yet (own project) and no fallback. */
  | "setup"
  /** Client known, not signed in. */
  | "signed-out"
  /** Waiting for staff to enter the code at google.com/device. */
  | "pending"
  | "connected"
  /** The sign-in stopped working (revoked, expired…): Reconnect. */
  | "disconnected";

export type GoogleProblem =
  | { kind: "quota"; resetsAt: number }
  | { kind: "api-disabled"; wizardStep: number }
  | { kind: "client-invalid"; wizardStep: number }
  | { kind: "other"; message: string };

export interface GoogleStatus {
  state: GoogleState;
  mode: GoogleMode;
  /** The operator's sign-in is offered (GOOGLE_FALLBACK_CLIENT_ID is set). */
  fallbackAvailable: boolean;
  /** Own-project client id (the secret is never sent back). */
  clientId: string;
  hasClientSecret: boolean;
  hasApiKey: boolean;
  /** The YouTube channel signed in. */
  account: string;
  /** Its @handle and id, to match against the channel the playlists are on. */
  channelHandle: string;
  channelId: string;
  pending: { userCode: string; verificationUrl: string; expiresAt: number } | null;
  problem: GoogleProblem | null;
  lastCheckedAt: number | null;
  quota: { usedToday: number; dailyLimit: number; resetsAt: number; searchesToday: number; searchCap: number };
}

/** For the box's "needs attention" (SDK 0.9.0, later). */
export interface Attention {
  level: "warn" | "error";
  message: string;
  actionPath: string;
}

export interface Settings {
  /** Standalone display name (on a box the venue's name for the app wins). */
  name: string;
  /** In-app searches per day (100 units each); 0 turns search off. */
  searchCap: number;
  /** Local hour for the nightly list refresh. */
  refreshHour: number;
}

export interface AdminState {
  tvs: TvInfo[];
  lists: ListSummary[];
  google: GoogleStatus;
  settings: Settings;
  attention: Attention[];
  timezone: string;
  lastNightlyRefresh: number | null;
}

/** One of the signed-in account's playlists ("Browse my YouTube"). */
export interface YtPlaylist {
  id: string;
  title: string;
  count: number;
  thumb: string | null;
  privacy: string;
  /** Already in the library as this list id. */
  savedAs: string | null;
}

export interface SearchHit {
  id: string;
  title: string;
  channel: string;
}
