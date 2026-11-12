// Everything this app keeps, as JSON files in DATA_DIR (the kit's atomic JSON store).
//   settings.json   name, search cap, refresh hour, last nightly refresh
//   lists.json      the library
//   tvs.json        linked TVs: screen ids and lounge tokens (0600) and each TV's queue
//   google.json     OAuth client, refresh token, sign-in in progress (0600)
//   usage.json      today's API units and searches (Pacific day)
//   history.json    when each video last played (no-repeat rule)

import { chmod } from "node:fs/promises";
import { createJsonStore, log, type JsonStore } from "@bargames/gamekit/server";
import type { GoogleMode, GoogleProblem, SavedList, Settings, Video } from "@ytapp/shared";

export const DEFAULT_SETTINGS: Settings = { name: "", searchCap: 20, refreshHour: 4 };

export interface StoredQueue {
  listId: string | null;
  listName: string;
  videos: Video[];
  index: number;
  /** Queue index of the first video in the TV's current setPlaylist. */
  base: number;
  /** Queue index after the last video the TV has been sent. */
  sentEnd: number;
  loop: boolean;
}

export interface StoredTv {
  id: string;
  name: string;
  screenId: string;
  loungeToken: string;
  tokenAt: number;
  /** Our remote's id on this TV (stable across restarts). */
  deviceId: string;
  screenName: string;
  linkedAt: number;
  /** YouTube stopped accepting the link: needs a new TV code. */
  relink?: boolean;
  queue?: StoredQueue | null;
}

export interface StoredGoogle {
  mode: GoogleMode;
  clientId: string;
  clientSecret: string;
  apiKey: string;
  refreshToken: string;
  /** Which client the refresh token belongs to ("own" / "fallback"). */
  tokenMode: GoogleMode | null;
  account: string;
  disconnected: boolean;
  problem: GoogleProblem | null;
  lastCheckedAt: number | null;
  pending: { deviceCode: string; userCode: string; verificationUrl: string; expiresAt: number; interval: number; mode: GoogleMode } | null;
}

export const DEFAULT_GOOGLE: StoredGoogle = {
  mode: "own",
  clientId: "",
  clientSecret: "",
  apiKey: "",
  refreshToken: "",
  tokenMode: null,
  account: "",
  disconnected: false,
  problem: null,
  lastCheckedAt: null,
  pending: null,
};

export interface Usage {
  day: string;
  units: number;
  searches: number;
}

interface SettingsFile extends Settings {
  lastNightlyRefresh: number | null;
  lastNightlyDate: string;
}

const SECRET_FILES = new Set(["tvs.json", "google.json"]);
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
/** Shape check for the JSON files: an object (fields are merged over defaults). */
const obj = <T>() => isObj as unknown as (v: unknown) => v is T;

export class Store {
  readonly json: JsonStore;
  settings: SettingsFile = { ...DEFAULT_SETTINGS, lastNightlyRefresh: null, lastNightlyDate: "" };
  lists: SavedList[] = [];
  tvs: StoredTv[] = [];
  google: StoredGoogle = { ...DEFAULT_GOOGLE };
  usage: Usage = { day: "", units: 0, searches: 0 };
  lastPlayed: Record<string, number> = {};
  private timers = new Map<string, NodeJS.Timeout>();

  constructor(readonly dir: string) {
    this.json = createJsonStore(dir);
  }

  async init(): Promise<void> {
    const s = await this.json.read<SettingsFile>("settings.json", obj<SettingsFile>());
    if (s) this.settings = { ...this.settings, ...s };
    const l = await this.json.read<{ lists: SavedList[] }>("lists.json", obj<{ lists: SavedList[] }>());
    if (Array.isArray(l?.lists)) this.lists = l.lists;
    const t = await this.json.read<{ tvs: StoredTv[] }>("tvs.json", obj<{ tvs: StoredTv[] }>());
    if (Array.isArray(t?.tvs)) this.tvs = t.tvs;
    const g = await this.json.read<StoredGoogle>("google.json", obj<StoredGoogle>());
    if (g) this.google = { ...DEFAULT_GOOGLE, ...g };
    const u = await this.json.read<Usage>("usage.json", obj<Usage>());
    if (u) this.usage = { ...this.usage, ...u };
    const h = await this.json.read<{ lastPlayed: Record<string, number> }>("history.json", obj<{ lastPlayed: Record<string, number> }>());
    if (isObj(h?.lastPlayed)) this.lastPlayed = h.lastPlayed as Record<string, number>;
  }

  private async write(name: string, value: unknown): Promise<void> {
    await this.json.write(name, value);
    if (SECRET_FILES.has(name)) await chmod(this.json.file(name), 0o600).catch(() => undefined);
  }

  saveSettings = () => this.write("settings.json", this.settings);
  saveLists = () => this.write("lists.json", { lists: this.lists });
  saveTvs = () => this.write("tvs.json", { tvs: this.tvs });
  saveGoogle = () => this.write("google.json", this.google);
  saveUsage = () => this.write("usage.json", this.usage);

  /** Coalesces frequent writes (queue position, history) into one per `ms`. */
  later(name: "tvs" | "history" | "usage", ms = 5000): void {
    if (this.timers.has(name)) return;
    const t = setTimeout(() => {
      this.timers.delete(name);
      const run = name === "tvs" ? this.saveTvs() : name === "usage" ? this.saveUsage() : this.saveHistory();
      run.catch((err) => log.warn("store", `saving ${name} failed`, { err: String(err) }));
    }, ms);
    t.unref();
    this.timers.set(name, t);
  }

  saveHistory(): Promise<void> {
    // Keep the newest 5000 entries.
    const entries = Object.entries(this.lastPlayed);
    if (entries.length > 5000) this.lastPlayed = Object.fromEntries(entries.sort((a, b) => b[1] - a[1]).slice(0, 5000));
    return this.write("history.json", { lastPlayed: this.lastPlayed });
  }

  /** Writes anything still waiting (shutdown). */
  async flush(): Promise<void> {
    const names = [...this.timers.keys()];
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    for (const n of names) await (n === "tvs" ? this.saveTvs() : n === "usage" ? this.saveUsage() : this.saveHistory()).catch(() => undefined);
  }
}
