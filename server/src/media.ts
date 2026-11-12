// The box's side of YouTube (SDK 0.9.0 "media providers"). On a box:
//   - links are mapped to box TVs (staff pick, or matched by YouTube screen id over DIAL);
//   - the box's TVs page lists our lists (media_list), plays one on a TV (media_play) and
//     stops it (media_stop); plans start venue-wide from the Tonight page;
//   - status.media.targets tells the box what each mapped TV is doing;
//   - YouTube is started on a TV through the box (bg.launchApp) when it's closed there;
//   - the attention list goes to the box's Tonight page.
// Off a box none of this runs (bg calls are no-ops) and the admin works as before.

import type { BarGames } from "@bargames/sdk/server";
import { log } from "@bargames/gamekit/server";
import type { Attention, BoxTvChoice, SavedList } from "@ytapp/shared";
import type { Library } from "./library.js";
import type { Plans, PlayOnTv } from "./plans.js";
import type { Store } from "./store.js";
import type { Launcher, TvManager } from "./tvs.js";

/** media_play must answer well inside the box's 5 s command timeout. */
export const ANSWER_WITHIN_MS = 2500;

export const ECP_BLOCKED =
  "The Roku won't let the box start YouTube. On the Roku: Settings → System → Advanced system settings → Control by mobile apps → Network access → Permissive.";

export interface MediaDeps {
  bg: BarGames;
  store: Store;
  tvs: TvManager;
  library: Library;
  attention: () => Attention[];
  answerWithinMs?: number;
  refreshMs?: number;
}

export function createMedia(d: MediaDeps) {
  const { bg, store, tvs, library } = d;
  const answerWithin = d.answerWithinMs ?? ANSWER_WITHIN_MS;
  let plans: Plans | null = null;
  let boxTvs: BoxTvChoice[] = [];

  /** Re-reads the box's TVs; matches links over DIAL. Screen ids never leave this function. */
  async function refreshBoxTvs(): Promise<BoxTvChoice[]> {
    if (!bg.connected) return [];
    try {
      const list = await bg.tvs();
      boxTvs = list.map((t) => ({ id: t.id, name: t.name, ...(t.group ? { group: t.group } : {}), kind: t.kind, online: t.online, canLaunch: t.canLaunch.includes("youtube") }));
      tvs.setBoxTvs(new Map(boxTvs.map((t) => [t.id, { name: t.name, canLaunch: t.canLaunch }])));
      const screens = list.flatMap((t) => (t.youtubeScreenId ? [{ displayId: t.id, screenId: t.youtubeScreenId }] : []));
      if (screens.length) await tvs.autoMap(screens);
    } catch (err) {
      log.warn("media", "couldn't read the box's TVs", { err: String(err) });
    }
    return boxTvs;
  }

  /** Starts YouTube on a linked TV's box TV, when it's mapped to one that can. */
  function launcherFor(tvId: string): Launcher | undefined {
    const displayId = store.tvs.find((t) => t.id === tvId)?.boxDisplayId;
    if (!bg.connected || !displayId) return undefined;
    if (boxTvs.length && !boxTvs.find((t) => t.id === displayId)?.canLaunch) return undefined;
    return async () => {
      const r = await bg.launchApp(displayId, "youtube");
      if (r.ok) {
        log.info("media", "asked the box to start YouTube", { displayId });
        return { ok: true };
      }
      log.warn("media", "the box couldn't start YouTube", { displayId, reason: r.reason });
      return { ok: false, message: r.reason === "ecp-blocked" ? ECP_BLOCKED : r.reason === "offline" ? "The box can't reach that TV right now." : r.message || "The box couldn't start YouTube there." };
    };
  }

  /** Plays a list on a linked TV, starting YouTube there first when the box can. */
  const playOnTv: PlayOnTv = (tvId, list, loop) => tvs.playWhenReady(tvId, list, { loop, launch: launcherFor(tvId) });

  /** Waits a little for work that may take long; then answers "pending" and lets it finish. */
  async function answerSoon<T>(work: Promise<T>): Promise<{ done: true; value: T } | { done: false }> {
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<{ done: false }>((r) => (timer = setTimeout(() => r({ done: false }), answerWithin)));
    const r = await Promise.race([work.then((value) => ({ done: true as const, value })), late]).finally(() => clearTimeout(timer));
    // We answered "pending": an error now can only go to the log (status shows the TV's state).
    if (!r.done) work.catch((err) => log.warn("media", "media_play finished with an error", { err: String(err) }));
    return r;
  }

  function register(p: Plans): void {
    plans = p;

    bg.onMediaList(() => [
      ...library.all().map((l: SavedList) => {
        const first = l.videos.find((v) => !v.unavailable);
        return {
          id: l.id,
          name: l.name,
          kind: "list" as const,
          count: l.videos.filter((v) => !v.unavailable).length,
          ...(first ? { thumbnailUrl: `https://i.ytimg.com/vi/${first.id}/mqdefault.jpg` } : {}),
        };
      }),
      ...p.all().map((pl) => ({ id: pl.id, name: pl.name, kind: "plan" as const, count: pl.items.length })),
    ]);

    bg.onMediaPlay(async ({ displayId, itemId }) => {
      try {
        const plan = p.all().find((x) => x.id === itemId);
        if (plan) {
          const r = await answerSoon(p.start(plan.id));
          if (!r.done) return { ok: true, pending: true };
          const { started, pending, failed } = r.value;
          if (!started && !pending) return { ok: false, message: failed.join(" ") || "Nothing in that plan could start." };
          return { ok: true, pending: pending > 0, ...(failed.length ? { message: `Some TVs didn't start: ${failed.join(" ")}` } : {}) };
        }
        const list = library.find(itemId);
        if (!list) return { ok: false, message: "That YouTube list isn't in the library any more." };
        if (!displayId) return { ok: false, message: "Pick a TV for that list." };
        const tvId = tvs.byDisplay(displayId);
        if (!tvId) return { ok: false, message: "That TV has no YouTube link yet. Link it in the YouTube app's admin (TVs)." };
        const r = await answerSoon(playOnTv(tvId, list));
        if (!r.done) return { ok: true, pending: true };
        return { ok: true, launched: r.value.launched, pending: r.value.pending };
      } catch (err) {
        return { ok: false, message: (err as Error).message };
      }
    });

    bg.onMediaStop(async ({ displayId }) => {
      const tvId = tvs.byDisplay(displayId);
      if (!tvId) return { ok: false, message: "That TV has no YouTube link." };
      try {
        await tvs.control(tvId, "stop");
        return { ok: true };
      } catch (err) {
        return { ok: false, message: (err as Error).message };
      }
    });

    bg.setStatusProvider(() => ({
      rooms: [],
      media: {
        targets: store.tvs
          .filter((t) => t.boxDisplayId)
          .map((t) => {
            const info = tvs.list().find((x) => x.id === t.id);
            const state = tvs.mediaState(t.id);
            const np = info?.nowPlaying;
            const q = info?.queue;
            return {
              displayId: t.boxDisplayId!,
              label: t.name,
              state,
              ...(np?.title ? { nowPlaying: { title: np.title, ...(q && !q.detached ? { listName: q.listName } : {}) } } : {}),
              ...(q?.listId && !q.detached ? { itemId: q.listId } : {}),
            };
          }),
      },
    }));
  }

  // Attention: send the full list when it changes (and once a minute, in case the box restarted).
  let lastAttention = "";
  let attentionSentAt = 0;
  async function pushAttention(): Promise<void> {
    if (!bg.connected) return;
    const items = d.attention().map((a) => ({ level: a.level, message: a.message, actionPath: a.actionPath }));
    const json = JSON.stringify(items);
    if (json === lastAttention && Date.now() - attentionSentAt < 10 * 60_000) return;
    lastAttention = json;
    attentionSentAt = Date.now();
    await bg.setAttention(items).catch(() => undefined);
  }

  let timer: NodeJS.Timeout | null = null;
  function start(): void {
    if (!bg.connected) return;
    const tick = () => void refreshBoxTvs().then(pushAttention);
    setTimeout(tick, 1000).unref();
    timer = setInterval(tick, d.refreshMs ?? 60_000);
    timer.unref();
  }

  return {
    playOnTv,
    launcherFor,
    refreshBoxTvs,
    pushAttention,
    register,
    start,
    get plans() {
      return plans;
    },
    close() {
      if (timer) clearInterval(timer);
    },
  };
}

export type Media = ReturnType<typeof createMedia>;
