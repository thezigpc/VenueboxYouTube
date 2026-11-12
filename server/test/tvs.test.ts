// Linked TVs end to end against the fake Lounge: link by code, play a list, follow the TV,
// top up, skip stalls, survive restarts, and ask for a re-link when YouTube drops the link.
import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { statSync } from "node:fs";
import path from "node:path";
import type { ListSummary, TvInfo } from "@ytapp/shared";
import { GOOD_CODE, startApp, until, type TestApp } from "./fakes.js";

let t: TestApp;
beforeEach(async () => (t = await startApp()));
afterEach(() => t.stop());

async function linkTv(): Promise<TvInfo> {
  const tv = await t.call<TvInfo>("POST", "/tvs", { code: "1111 2222 3333", name: "Bar left" });
  await until(() => t.yt.tvs.list()[0]?.link === "connected" && t.lounge.openStreams > 0, "TV connected");
  return tv;
}

/** A local list of n videos (no Google needed: titles from oEmbed / ids). */
async function localList(n: number, opts: { loop?: boolean; shuffle?: boolean } = {}): Promise<ListSummary> {
  const l = await t.call<ListSummary>("POST", "/lists", { name: "House" });
  const ids = Array.from({ length: n }, (_, i) => `vid${String(i).padStart(8, "0")}`);
  await t.call("POST", `/lists/${l.id}/add`, { videoIds: ids });
  await t.call("PATCH", `/lists/${l.id}`, { loop: opts.loop ?? false, shuffle: opts.shuffle ?? false });
  return l;
}

const lastCommand = (name: string) => [...t.lounge.commands].reverse().find((c) => c.name === name);

describe("linking", () => {
  test("a wrong code is refused with a clear message", async () => {
    await assert.rejects(t.call("POST", "/tvs", { code: "999999999999" }), /didn't accept that TV code/);
    await assert.rejects(t.call("POST", "/tvs", { code: "12" }), /12 digits/);
  });

  test("a good code links, connects, and learns the screen name", async () => {
    const tv = await linkTv();
    assert.equal(tv.name, "Bar left");
    const info = t.yt.tvs.list()[0]!;
    assert.equal(info.screenName, "Living Room TV");
    assert.equal(t.lounge.binds, 1);
  });

  test("the TV link file is private (0600)", { skip: process.platform === "win32" }, async () => {
    await linkTv();
    assert.equal(statSync(path.join(t.dataDir, "tvs.json")).mode & 0o777, 0o600);
  });

  test("linking the same TV again re-links it instead of adding a second", async () => {
    await linkTv();
    await t.call("POST", "/tvs", { code: GOOD_CODE });
    assert.equal(t.yt.tvs.list().length, 1);
  });
});

describe("playing", () => {
  test("a list is sent as a queue of video ids, in windows", async () => {
    const tv = await linkTv();
    const l = await localList(70);
    await t.call("POST", "/play", { tvIds: [tv.id], listId: l.id });
    const set = lastCommand("setPlaylist")!;
    assert.equal(set.params.videoId, "vid00000000");
    assert.equal(set.params.videoIds!.split(",").length, 50);
    assert.equal(set.params.currentIndex, "0");
  });

  test("now playing follows the TV and the queue tops up as it plays", async () => {
    const tv = await linkTv();
    const l = await localList(70);
    await t.call("POST", "/play", { tvIds: [tv.id], listId: l.id });
    t.lounge.push("nowPlaying", { videoId: "vid00000045", currentTime: "1", duration: "200", state: "1" });
    await until(() => t.lounge.commands.filter((c) => c.name === "addVideo").length >= 5, "top-up");
    const info = t.yt.tvs.list()[0]!;
    assert.equal(info.nowPlaying?.videoId, "vid00000045");
    assert.equal(info.nowPlaying?.state, "playing");
    assert.equal(info.queue?.index, 45);
    assert.equal(t.lounge.commands.find((c) => c.name === "addVideo")!.params.videoId, "vid00000050");
  });

  test("a looping list gets a new round before it runs out", async () => {
    const tv = await linkTv();
    const l = await localList(4, { loop: true });
    await t.call("POST", "/play", { tvIds: [tv.id], listId: l.id });
    t.lounge.push("nowPlaying", { videoId: "vid00000002", state: "1" });
    await until(() => (t.yt.tvs.list()[0]!.queue?.length ?? 0) >= 8, "next round");
    await until(() => t.lounge.commands.some((c) => c.name === "addVideo"), "round sent");
  });

  test("a video that won't play is skipped, and the TV isn't hammered forever", async () => {
    const tv = await linkTv();
    const l = await localList(20);
    await t.call("POST", "/play", { tvIds: [tv.id], listId: l.id });
    t.lounge.push("nowPlaying", { videoId: "vid00000000", state: "-1" });
    await until(() => t.yt.tvs.list()[0]!.nowPlaying?.state === "stopped", "stopped seen");
    t.clock.now += 1000; // past the start grace
    await until(() => t.lounge.commands.filter((c) => c.name === "setPlaylist").length >= 2, "skip");
    assert.equal(lastCommand("setPlaylist")!.params.videoId, "vid00000001");
    // Keep the TV dead: at most 5 skips, then a message.
    for (let i = 0; i < 12; i++) {
      t.clock.now += 1000;
      await new Promise((r) => setTimeout(r, 40));
    }
    assert.ok(t.lounge.commands.filter((c) => c.name === "setPlaylist").length <= 6);
    assert.match(t.yt.tvs.list()[0]!.message, /isn't playing/);
  });

  test("someone using the TV's own remote takes it over (we don't fight it)", async () => {
    const tv = await linkTv();
    const l = await localList(5);
    await t.call("POST", "/play", { tvIds: [tv.id], listId: l.id });
    t.lounge.push("nowPlaying", { videoId: "dQw4w9WgXcQ", state: "1" });
    await until(() => t.yt.tvs.list()[0]!.queue?.detached === true, "detached");
    assert.match(t.yt.tvs.list()[0]!.local!.reason, /something else/);
  });

  test("controls send the matching commands", async () => {
    const tv = await linkTv();
    for (const action of ["pause", "play", "previous"]) await t.call("POST", `/tvs/${tv.id}/control`, { action });
    await t.call("POST", `/tvs/${tv.id}/control`, { action: "volume", value: 35 });
    assert.deepEqual(t.lounge.commands.map((c) => c.name), ["pause", "play", "previous", "setVolume"]);
    assert.equal(lastCommand("setVolume")!.params.volume, "35");
    await assert.rejects(t.call("POST", `/tvs/${tv.id}/control`, { action: "volume", value: 300 }), /0 to 100/);
  });

  test("add to queue and save the queue as a list", async () => {
    const tv = await linkTv();
    const l = await localList(3);
    await t.call("POST", "/play", { tvIds: [tv.id], listId: l.id });
    await t.call("POST", `/tvs/${tv.id}/add`, { link: "https://youtu.be/dQw4w9WgXcQ" });
    assert.equal(lastCommand("addVideo")!.params.videoId, "dQw4w9WgXcQ");
    const saved = await t.call<ListSummary>("POST", "/lists", { fromTv: tv.id, name: "Tonight" });
    assert.equal(saved.count, 4);
  });

  test("playing on a TV that isn't connected fails clearly", async () => {
    const tv = await linkTv();
    const l = await localList(3);
    t.lounge.down = true;
    t.lounge.closeStreams();
    await until(() => t.yt.tvs.list()[0]!.link === "connecting", "connecting");
    await assert.rejects(t.call("POST", "/play", { tvIds: [tv.id], listId: l.id }), /isn't connected/);
    t.lounge.down = false;
    await until(() => t.yt.tvs.list()[0]!.link === "connected", "reconnected");
  });
});

describe("local control", () => {
  /** Plays a list and lets it get going on the TV. */
  async function playing(n = 10) {
    const tv = await linkTv();
    const l = await localList(n);
    await t.call("POST", "/play", { tvIds: [tv.id], listId: l.id });
    t.lounge.push("nowPlaying", { videoId: "vid00000000", state: "1" });
    await until(() => t.yt.tvs.list()[0]!.nowPlaying?.state === "playing", "playing");
    t.clock.now += 1000; // past the start grace
    return tv;
  }
  const sets = () => t.lounge.commands.filter((c) => c.name === "setPlaylist").length;
  const settle = async () => {
    for (let i = 0; i < 6; i++) {
      t.clock.now += 1000;
      await new Promise((r) => setTimeout(r, 40));
    }
  };

  test("stopping a video on the TV hands it over: no restart, no skip", async () => {
    await playing();
    const before = sets();
    t.lounge.push("onStateChange", { state: "-1" });
    await until(() => t.yt.tvs.list()[0]!.nowPlaying?.state === "stopped", "stopped");
    await settle();
    const info = t.yt.tvs.list()[0]!;
    assert.match(info.local?.reason ?? "", /stopped on the TV/);
    assert.equal(info.queue?.detached, true);
    assert.equal(sets(), before);
  });

  test("leaving the video on the TV hands it over too", async () => {
    await playing();
    const before = sets();
    t.lounge.push("nowPlaying", {});
    await until(() => t.yt.tvs.list()[0]!.nowPlaying === null, "left");
    await settle();
    assert.match(t.yt.tvs.list()[0]!.local?.reason ?? "", /left the video/);
    assert.equal(sets(), before);
  });

  test("under local control nothing automatic happens, also after a restart", async () => {
    await playing(70);
    t.lounge.push("nowPlaying", { videoId: "dQw4w9WgXcQ", state: "1" });
    await until(() => !!t.yt.tvs.list()[0]!.local, "local");
    // The TV happens to play one of our videos again: still hands off (no top-up).
    const adds = t.lounge.commands.filter((c) => c.name === "addVideo").length;
    t.lounge.push("nowPlaying", { videoId: "vid00000045", state: "1" });
    await settle();
    assert.equal(t.lounge.commands.filter((c) => c.name === "addVideo").length, adds);
    await t.restart();
    await until(() => t.yt.tvs.list()[0]?.link === "connected", "connected");
    assert.ok(t.yt.tvs.list()[0]!.local);
  });

  test("Take back resumes our list; Play list does too", async () => {
    const tv = await playing();
    t.lounge.push("nowPlaying", { videoId: "dQw4w9WgXcQ", state: "1" });
    await until(() => !!t.yt.tvs.list()[0]!.local, "local");
    await t.call("POST", `/tvs/${tv.id}/control`, { action: "takeback" });
    assert.equal(t.yt.tvs.list()[0]!.local, null);
    assert.equal([...t.lounge.commands].reverse().find((c) => c.name === "setPlaylist")!.params.videoId, "vid00000001");
    await t.call("POST", `/tvs/${tv.id}/control`, { action: "release" });
    assert.match(t.yt.tvs.list()[0]!.local!.reason, /admin/);
  });

  test("a video that ends with nothing after it on the TV moves our list along", async () => {
    await playing();
    const before = sets();
    t.lounge.push("onStateChange", { state: "0" });
    await until(() => t.yt.tvs.list()[0]!.nowPlaying?.state === "ended", "ended");
    await settle();
    const skips = t.lounge.commands.filter((c) => c.name === "setPlaylist").slice(before);
    assert.ok(skips.length >= 1);
    assert.equal(skips[0]!.params.videoId, "vid00000001");
    assert.equal(t.yt.tvs.list()[0]!.local, null);
  });

  test("the end of a list that doesn't loop isn't a takeover", async () => {
    const tv = await linkTv();
    const l = await localList(1);
    await t.call("POST", "/play", { tvIds: [tv.id], listId: l.id });
    t.lounge.push("nowPlaying", { videoId: "vid00000000", state: "1" });
    await until(() => t.yt.tvs.list()[0]!.nowPlaying?.state === "playing", "playing");
    t.lounge.push("nowPlaying", {});
    await settle();
    assert.equal(t.yt.tvs.list()[0]!.local, null);
  });
});

describe("staying linked", () => {
  test("an expired lounge token is refreshed and the TV reconnects", async () => {
    await linkTv();
    const before = t.lounge.tokenRefreshes;
    t.lounge.expireOnce = true;
    t.lounge.closeStreams();
    await until(() => t.lounge.tokenRefreshes > before && t.lounge.binds >= 2, "token refreshed and reconnected");
    await until(() => t.yt.tvs.list()[0]!.link === "connected", "connected");
  });

  test("a revoked link asks for a new TV code, and re-linking fixes it", async () => {
    const tv = await linkTv();
    t.lounge.screens.clear();
    // An old token: after the restart the TV renews it, and YouTube no longer knows the screen.
    t.yt.store.tvs[0]!.tokenAt = 0;
    await t.yt.store.saveTvs();
    await t.restart();
    await until(() => t.yt.tvs.list()[0]?.link === "relink", "relink state");
    const s = (await (await t.get("/api/admin/state", t.token)).json()) as { attention: { message: string }[] };
    assert.match(s.attention[0]!.message, /Re-link/);
    await t.call("POST", `/tvs/${tv.id}/relink`, { code: GOOD_CODE });
    await until(() => t.yt.tvs.list()[0]?.link === "connected", "connected again");
  });

  test("after a restart the TV reconnects and its queue is still there", async () => {
    const tv = await linkTv();
    const l = await localList(10);
    await t.call("POST", "/play", { tvIds: [tv.id], listId: l.id });
    t.lounge.push("nowPlaying", { videoId: "vid00000003", state: "1" });
    await until(() => t.yt.tvs.list()[0]!.queue?.index === 3, "index 3");
    await t.restart();
    await until(() => t.yt.tvs.list()[0]?.link === "connected", "connected after restart");
    const info = t.yt.tvs.list()[0]!;
    assert.equal(info.queue?.length, 10);
    assert.equal(info.queue?.index, 3);
  });

  test("unlinking removes the TV", async () => {
    const tv = await linkTv();
    await t.call("DELETE", `/tvs/${tv.id}`);
    assert.equal(t.yt.tvs.list().length, 0);
  });
});
