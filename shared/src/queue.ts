// Turning a saved list into the order a TV plays it.

import type { ListRules, Video } from "./types.js";

/** Fisher-Yates with an injectable random source (tests). */
export function shuffled<T>(items: readonly T[], random: () => number = Math.random): T[] {
  const a = items.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

export interface QueueOptions {
  /** videoId → when it last played (ms), for "no repeat within N hours". */
  lastPlayed?: Record<string, number>;
  now?: number;
  random?: () => number;
}

/**
 * The play order: unplayable videos dropped, duplicates dropped, shuffled if the list says
 * so. With shuffle and noRepeatHours, videos played recently go to the end instead of being
 * dropped, so a short list never runs dry.
 */
export function buildQueue(videos: readonly Video[], rules: ListRules, o: QueueOptions = {}): Video[] {
  const seen = new Set<string>();
  const playable = videos.filter((v) => !v.unavailable && !seen.has(v.id) && (seen.add(v.id), true));
  if (!rules.shuffle) return playable;
  const mixed = shuffled(playable, o.random);
  if (!(rules.noRepeatHours > 0) || !o.lastPlayed) return mixed;
  const cutoff = (o.now ?? Date.now()) - rules.noRepeatHours * 3600_000;
  const fresh = mixed.filter((v) => !((o.lastPlayed![v.id] ?? 0) > cutoff));
  const recent = mixed
    .filter((v) => (o.lastPlayed![v.id] ?? 0) > cutoff)
    .sort((a, b) => (o.lastPlayed![a.id] ?? 0) - (o.lastPlayed![b.id] ?? 0));
  return [...fresh, ...recent];
}

/** Videos of `add` not already in `base`, appended in order. */
export function combine(base: readonly Video[], add: readonly Video[]): Video[] {
  const ids = new Set(base.map((v) => v.id));
  return [...base, ...add.filter((v) => !ids.has(v.id) && (ids.add(v.id), true))];
}
