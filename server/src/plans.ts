// Saved TV plans: "these lists on these TVs", started with one press.

import { randomBytes } from "node:crypto";
import { log } from "@bargames/gamekit/server";
import type { Plan, PlanItem } from "@ytapp/shared";
import type { Library } from "./library.js";
import type { Store } from "./store.js";
import { TvError, type TvManager } from "./tvs.js";

export const MAX_PLANS = 50;

export class Plans {
  constructor(
    private readonly store: Store,
    private readonly library: Library,
    private readonly tvs: TvManager,
    private readonly now: () => number = Date.now,
  ) {}

  all(): Plan[] {
    return this.store.plans;
  }

  private get(id: string): Plan {
    const p = this.store.plans.find((x) => x.id === id);
    if (!p) throw new TvError("That plan doesn't exist any more.", 404);
    return p;
  }

  private name(v: unknown, fallback: string): string {
    const s = typeof v === "string" ? v.trim().replace(/\s+/g, " ").slice(0, 60) : "";
    return s || fallback;
  }

  /** One entry per TV; TVs and lists must exist. */
  private items(v: unknown): PlanItem[] {
    if (!Array.isArray(v)) throw new TvError("A plan needs a list of TVs.");
    const tvIds = new Set(this.store.tvs.map((t) => t.id));
    const out = new Map<string, PlanItem>();
    for (const raw of v) {
      const it = raw as Partial<PlanItem> | null;
      if (!it || typeof it.tvId !== "string" || typeof it.listId !== "string") continue;
      if (!tvIds.has(it.tvId)) throw new TvError("One of those TVs isn't linked any more.");
      this.library.get(it.listId);
      out.set(it.tvId, { tvId: it.tvId, listId: it.listId, ...(typeof it.loop === "boolean" ? { loop: it.loop } : {}) });
    }
    if (!out.size) throw new TvError("Choose a list for at least one TV.");
    return [...out.values()];
  }

  async create(body: { name?: unknown; items?: unknown; fromTvs?: unknown }): Promise<Plan> {
    if (this.store.plans.length >= MAX_PLANS) throw new TvError(`Up to ${MAX_PLANS} plans.`, 409);
    let items: PlanItem[];
    if (body.fromTvs) {
      // "Save what's on now": every TV playing one of our lists.
      items = this.tvs
        .list()
        .filter((t) => t.queue?.listId && !t.local && this.library.find(t.queue.listId))
        .map((t) => ({ tvId: t.id, listId: t.queue!.listId!, loop: t.queue!.loop }));
      if (!items.length) throw new TvError("No TV is playing a saved list right now.");
    } else items = this.items(body.items);
    const p: Plan = { id: randomBytes(5).toString("base64url"), name: this.name(body.name, "New plan"), items, createdAt: this.now(), updatedAt: this.now() };
    this.store.plans.push(p);
    await this.store.savePlans();
    return p;
  }

  async update(id: string, body: { name?: unknown; items?: unknown }): Promise<Plan> {
    const p = this.get(id);
    if (body.name !== undefined) p.name = this.name(body.name, p.name);
    if (body.items !== undefined) p.items = this.items(body.items);
    p.updatedAt = this.now();
    await this.store.savePlans();
    return p;
  }

  async remove(id: string): Promise<void> {
    this.get(id);
    this.store.plans = this.store.plans.filter((p) => p.id !== id);
    await this.store.savePlans();
  }

  /**
   * Starts every TV in the plan. Staff pressed Start, so this takes TVs back from local
   * control too. TVs left out of the plan are left alone. Returns what didn't start.
   */
  async start(id: string): Promise<{ started: number; failed: string[] }> {
    const p = this.get(id);
    const failed: string[] = [];
    let started = 0;
    await Promise.all(
      p.items.map(async (it) => {
        const tvName = this.tvs.list().find((t) => t.id === it.tvId)?.name;
        const list = this.library.find(it.listId);
        if (!tvName) return void failed.push("A TV in this plan isn't linked any more.");
        if (!list) return void failed.push(`${tvName}: its list was deleted.`);
        try {
          await this.tvs.playList(it.tvId, list, undefined, it.loop);
          started++;
        } catch (err) {
          failed.push(`${tvName}: ${(err as Error).message}`);
        }
      }),
    );
    p.lastStartedAt = this.now();
    await this.store.savePlans();
    log.info("plans", "started", { plan: p.name, started, failed: failed.length });
    return { started, failed };
  }

  /** Drops a TV or list from every plan when it's removed. */
  async forget(ref: { tvId?: string; listId?: string }): Promise<void> {
    let changed = false;
    for (const p of this.store.plans) {
      const before = p.items.length;
      p.items = p.items.filter((it) => it.tvId !== ref.tvId && it.listId !== ref.listId);
      changed ||= p.items.length !== before;
    }
    if (changed) await this.store.savePlans();
  }
}
