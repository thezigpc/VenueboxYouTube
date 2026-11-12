// Saved TV plans and the per-TV loop switch.
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import type { AdminState, ListSummary, Plan, TvInfo } from "@ytapp/shared";
import { startApp, until, type TestApp } from "./fakes.js";

let t: TestApp;
beforeEach(async () => (t = await startApp()));
afterEach(() => t.stop());

async function setup() {
  const tv = await t.call<TvInfo>("POST", "/tvs", { code: "111122223333", name: "Bar left" });
  await until(() => t.yt.tvs.list()[0]?.link === "connected" && t.lounge.openStreams > 0, "connected");
  const l = await t.call<ListSummary>("POST", "/lists", { name: "Cartoons" });
  await t.call("POST", `/lists/${l.id}/add`, { videoIds: ["vid00000000", "vid00000001", "vid00000002"] });
  return { tv, l };
}

test("a plan plays its lists on its TVs with one press", async () => {
  const { tv, l } = await setup();
  const p = await t.call<Plan>("POST", "/plans", { name: "Saturday morning cartoons", items: [{ tvId: tv.id, listId: l.id, loop: false }] });
  assert.equal(p.items.length, 1);
  const r = await t.call<{ started: number; pending: number; failed: string[] }>("POST", `/plans/${p.id}/start`);
  assert.deepEqual(r, { started: 1, pending: 0, failed: [] });
  const info = t.yt.tvs.list()[0]!;
  assert.equal(info.queue?.listName, "Cartoons");
  assert.equal(info.queue?.loop, false);
  const st = await t.call<AdminState>("GET", "/state");
  assert.ok(st.plans[0]!.lastStartedAt);
});

test("save what's on now as a plan; bad TVs and lists are refused", async () => {
  const { tv, l } = await setup();
  await assert.rejects(t.call("POST", "/plans", { fromTvs: true }), /No TV is playing/);
  await t.call("POST", "/play", { tvIds: [tv.id], listId: l.id });
  const p = await t.call<Plan>("POST", "/plans", { name: "Now", fromTvs: true });
  assert.deepEqual(p.items.map((i) => [i.tvId, i.listId]), [[tv.id, l.id]]);
  await assert.rejects(t.call("POST", "/plans", { items: [{ tvId: "nope", listId: l.id }] }), /isn't linked/);
  await assert.rejects(t.call("POST", "/plans", { items: [] }), /at least one TV/);
});

test("deleting a list or unlinking a TV drops it from plans", async () => {
  const { tv, l } = await setup();
  await t.call<Plan>("POST", "/plans", { name: "P", items: [{ tvId: tv.id, listId: l.id }] });
  await t.call("DELETE", `/lists/${l.id}`);
  assert.equal((await t.call<AdminState>("GET", "/state")).plans[0]!.items.length, 0);
});

test("the loop switch changes the list that's playing", async () => {
  const { tv, l } = await setup();
  await t.call("PATCH", `/lists/${l.id}`, { loop: false });
  await t.call("POST", "/play", { tvIds: [tv.id], listId: l.id, loop: true });
  assert.equal(t.yt.tvs.list()[0]!.queue?.loop, true);
  await t.call("POST", `/tvs/${tv.id}/control`, { action: "loop", value: false });
  assert.equal(t.yt.tvs.list()[0]!.queue?.loop, false);
});
