// The box side (SDK 0.9.0 media providers) against a fake box core: DIAL matching, the
// box's media_list / media_play / media_stop commands, starting YouTube through the box,
// status.media.targets and the attention feed.
import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { BoxTvChoice, ListSummary, Plan, TvInfo } from "@ytapp/shared";
import { GOOD_CODE, SCREEN_ID, startApp, until, type TestApp } from "./fakes.js";

const TOKEN = "core-token";
const ROKU = "roku:YH00AA123456";
const AIRPLAY = "airplay:AA:BB:CC:DD:EE:FF";

interface Core {
  url: string;
  launches: { displayId: string; app: string }[];
  attention: unknown[] | null;
  launchAnswer: Record<string, unknown>;
  /** Called on each accepted launch (the test opens YouTube on the fake TV). */
  onLaunch: () => void;
  dialScreenId: string | undefined;
  /** What the Roku shows (SDK 0.10.4 activeApp); undefined: the TV can't say. */
  activeApp: string | undefined;
  close(): Promise<void>;
}

async function fakeCore(): Promise<Core> {
  const theme = { colors: { background: "#000000", surface: "#111111", text: "#ffffff", primary: "#ff0000", accent: "#00ff00" } };
  const core: Core = {
    url: "",
    launches: [],
    attention: null,
    launchAnswer: { ok: true },
    onLaunch: () => undefined,
    dialScreenId: SCREEN_ID,
    activeApp: undefined,
    close: async () => undefined,
  };
  const srv = http.createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return void res.writeHead(401).end();
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      const json = (v: unknown) => (res.writeHead(200, { "content-type": "application/json" }), res.end(JSON.stringify(v)));
      if (req.url === "/internal/venue") {
        return json({ protocol: 1, venue: { name: "The Root Bar", theme, timezone: "America/New_York" }, game: { id: "youtube", displayName: "YouTube", theme }, standalone: false, generatedAt: new Date().toISOString() });
      }
      if (req.url === "/internal/tvs") {
        return json({
          tvs: [
            {
              id: ROKU,
              name: "Bar left",
              kind: "roku",
              online: true,
              canLaunch: ["youtube"],
              ...(core.dialScreenId ? { youtubeScreenId: core.dialScreenId } : {}),
              ...(core.activeApp ? { activeApp: core.activeApp } : {}),
            },
            { id: AIRPLAY, name: "Patio", kind: "airplay", online: true, canLaunch: [] },
          ],
        });
      }
      if (req.url === "/internal/launch-app") {
        core.launches.push(body);
        if (core.launchAnswer.ok) core.onLaunch();
        return json(core.launchAnswer);
      }
      if (req.url === "/internal/attention") {
        core.attention = body.items;
        return json({ ok: true });
      }
      if (req.url === "/internal/events") return void res.writeHead(204).end();
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  core.url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  core.close = () => new Promise((r) => srv.close(() => r()));
  return core;
}

let core: Core;
let t: TestApp;
beforeEach(async () => {
  core = await fakeCore();
  t = await startApp({ coreUrl: core.url, coreToken: TOKEN, noLogin: true });
  const r = await fetch(t.url + "/api/admin/trusted", { method: "POST", headers: { "x-bargames-via": "1", "x-bargames-staff": "1" } });
  t.token = ((await r.json()) as { token: string }).token;
});
afterEach(async () => {
  await t.stop();
  await core.close();
});

/** A box command, the way the box sends it. */
async function command<T = Record<string, unknown>>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const r = await fetch(t.url + "/__bargames/command", {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ command: name, args }),
  });
  return (await r.json()) as T;
}

async function targets() {
  const r = await fetch(t.url + "/__bargames/status", { headers: { authorization: `Bearer ${TOKEN}` } });
  return ((await r.json()) as { media?: { targets: { displayId: string; state: string; itemId?: string; nowPlaying?: { title: string } }[] } }).media?.targets ?? [];
}

async function linkedAndMapped(): Promise<TvInfo> {
  const tv = await t.call<TvInfo>("POST", "/tvs", { code: GOOD_CODE, name: "Bar left" });
  await until(() => t.yt.tvs.list()[0]?.link === "connected" && t.lounge.openStreams > 0, "connected");
  await t.yt.media.refreshBoxTvs();
  return tv;
}

async function list(n = 3): Promise<ListSummary> {
  const l = await t.call<ListSummary>("POST", "/lists", { name: "Friday mix" });
  await t.call("POST", `/lists/${l.id}/add`, { videoIds: Array.from({ length: n }, (_, i) => `vid${String(i).padStart(8, "0")}`) });
  return l;
}

const setPlaylists = () => t.lounge.commands.filter((c) => c.name === "setPlaylist").length;

describe("mapping links to box TVs", () => {
  test("a link is matched to its box TV by the screen id the box read over DIAL", async () => {
    await linkedAndMapped();
    const info = t.yt.tvs.list()[0]!;
    assert.deepEqual(info.box, { displayId: ROKU, name: "Bar left", auto: true, canLaunch: true });
  });

  test("the admin's box TV list never carries screen ids", async () => {
    const r = await t.call<{ onBox: boolean; tvs: BoxTvChoice[] }>("GET", "/box-tvs");
    assert.equal(r.onBox, true);
    assert.deepEqual(r.tvs.map((x) => [x.id, x.canLaunch]), [[ROKU, true], [AIRPLAY, false]]);
    assert.ok(!JSON.stringify(r).includes(SCREEN_ID));
  });

  test("a staff pick sticks; DIAL doesn't move it", async () => {
    core.dialScreenId = undefined;
    const tv = await linkedAndMapped();
    await t.call("PATCH", `/tvs/${tv.id}`, { boxDisplayId: AIRPLAY });
    core.dialScreenId = SCREEN_ID;
    await t.yt.media.refreshBoxTvs();
    assert.equal(t.yt.tvs.list()[0]!.box?.displayId, AIRPLAY);
    assert.equal(t.yt.tvs.list()[0]!.box?.auto, false);
    await assert.rejects(t.call("PATCH", `/tvs/${tv.id}`, { boxDisplayId: "roku:nope" }), /doesn't know that TV/);
    await t.call("PATCH", `/tvs/${tv.id}`, { boxDisplayId: null });
    assert.equal(t.yt.tvs.list()[0]!.box, null);
  });
});

describe("the box's commands", () => {
  test("media_list: lists and plans", async () => {
    const tv = await linkedAndMapped();
    const l = await list();
    await t.call<Plan>("POST", "/plans", { name: "Saturday cartoons", items: [{ tvId: tv.id, listId: l.id }] });
    const r = await command<{ ok: boolean; data: { items: { name: string; kind: string; count?: number }[] } }>("media_list");
    assert.equal(r.ok, true);
    assert.deepEqual(r.data.items.map((i) => [i.name, i.kind, i.count]), [["Friday mix", "list", 3], ["Saturday cartoons", "plan", 1]]);
  });

  test("media_play on a TV with YouTube open plays at once; status says playing", async () => {
    await linkedAndMapped();
    const l = await list();
    const r = await command<{ ok: boolean; data: { pending: boolean; launched: boolean } }>("media_play", { displayId: ROKU, itemId: l.id, takeBack: true });
    assert.equal(r.ok, true);
    assert.deepEqual([r.data.pending, r.data.launched], [false, false]);
    assert.equal(setPlaylists(), 1);
    assert.equal(core.launches.length, 0);
    t.lounge.push("nowPlaying", { videoId: "vid00000000", state: "1" });
    await until(() => t.yt.tvs.list()[0]!.nowPlaying?.state === "playing", "playing");
    const [target] = await targets();
    assert.equal(target!.state, "playing");
    assert.equal(target!.itemId, l.id);
  });

  test("media_play with YouTube closed: the box starts it, we answer pending, then play", async () => {
    await linkedAndMapped();
    const l = await list();
    t.lounge.appOpen = false;
    let opened = false;
    core.onLaunch = () => void setTimeout(() => ((t.lounge.appOpen = true), (opened = true)), 150);
    const r = await command<{ ok: boolean; data: { pending: boolean; launched: boolean } }>("media_play", { displayId: ROKU, itemId: l.id });
    assert.equal(r.ok, true);
    assert.deepEqual([r.data.pending, r.data.launched], [true, true]);
    assert.deepEqual(core.launches, [{ displayId: ROKU, app: "youtube" }]);
    assert.equal((await targets())[0]!.state, "starting");
    await until(() => setPlaylists() === 1, "played after launch");
    assert.ok(opened);
    await until(() => !t.yt.tvs.list()[0]!.starting, "not starting");
  });

  test("the Roku is on Home although the link says open: the TV's answer wins (start, wait, play)", async () => {
    await linkedAndMapped();
    const l = await list();
    // The bench Roku: Lounge says online and connected, the TV shows its home screen.
    t.lounge.appOpen = true;
    core.activeApp = "home";
    core.onLaunch = () => void setTimeout(() => (core.activeApp = "youtube"), 100);
    const r = await command<{ ok: boolean; data: { pending: boolean; launched: boolean } }>("media_play", { displayId: ROKU, itemId: l.id });
    assert.deepEqual([r.ok, r.data.launched, r.data.pending], [true, true, true]);
    assert.equal(core.launches.length, 1);
    assert.equal(setPlaylists(), 0);
    await until(() => setPlaylists() === 1, "played once the TV shows YouTube");
  });

  test("the Roku shows YouTube and the link is up: play at once, no launch", async () => {
    await linkedAndMapped();
    const l = await list();
    core.activeApp = "youtube";
    t.lounge.appOpen = false; // the link's own check is ignored when the TV can say
    const r = await command<{ ok: boolean; data: { pending: boolean; launched: boolean } }>("media_play", { displayId: ROKU, itemId: l.id });
    assert.deepEqual([r.ok, r.data.launched, r.data.pending], [true, false, false]);
    assert.equal(core.launches.length, 0);
    assert.equal(setPlaylists(), 1);
  });

  test("YouTube doesn't say whether it's open: start it anyway, then play", async () => {
    await linkedAndMapped();
    const l = await list();
    t.lounge.availabilityBroken = true;
    const r = await command<{ ok: boolean; data: { pending: boolean; launched: boolean } }>("media_play", { displayId: ROKU, itemId: l.id });
    assert.deepEqual([r.ok, r.data.launched, r.data.pending], [true, true, true]);
    assert.equal(core.launches.length, 1);
    await until(() => setPlaylists() === 1, "played after the unknown wait");
  });

  test("the TV link is down when Play is pressed: start YouTube, reconnect, then play", async () => {
    await linkedAndMapped();
    const l = await list();
    t.lounge.appOpen = false;
    t.lounge.down = true;
    t.lounge.closeStreams();
    await until(() => t.yt.tvs.list()[0]!.link === "connecting", "link down");
    core.onLaunch = () => void setTimeout(() => ((t.lounge.down = false), (t.lounge.appOpen = true)), 100);
    const r = await command<{ ok: boolean; data: { launched: boolean } }>("media_play", { displayId: ROKU, itemId: l.id });
    assert.deepEqual([r.ok, r.data.launched], [true, true]);
    await until(() => setPlaylists() === 1, "played after reconnect", 5000);
  });

  test("a Roku that blocks the box: a clear 'Permissive' message", async () => {
    await linkedAndMapped();
    const l = await list();
    t.lounge.appOpen = false;
    core.launchAnswer = { ok: false, reason: "ecp-blocked", message: "403" };
    const r = await command<{ ok: boolean; message: string }>("media_play", { displayId: ROKU, itemId: l.id });
    assert.equal(r.ok, false);
    assert.match(r.message, /Permissive/);
  });

  test("a TV without a link, or a list that's gone, is refused with a message", async () => {
    await linkedAndMapped();
    const l = await list();
    assert.match((await command<{ message: string }>("media_play", { displayId: AIRPLAY, itemId: l.id })).message, /no YouTube link/);
    assert.match((await command<{ message: string }>("media_play", { displayId: ROKU, itemId: "gone" })).message, /isn't in the library/);
  });

  test("media_play of a plan starts its TVs (no displayId)", async () => {
    const tv = await linkedAndMapped();
    const l = await list();
    const p = await t.call<Plan>("POST", "/plans", { name: "Cartoons", items: [{ tvId: tv.id, listId: l.id }] });
    const r = await command<{ ok: boolean }>("media_play", { itemId: p.id });
    assert.equal(r.ok, true);
    assert.equal(setPlaylists(), 1);
  });

  test("media_play takes a TV back from local control", async () => {
    await linkedAndMapped();
    const l = await list();
    await command("media_play", { displayId: ROKU, itemId: l.id });
    t.lounge.push("nowPlaying", { videoId: "dQw4w9WgXcQ", state: "1" });
    await until(() => !!t.yt.tvs.list()[0]!.local, "local");
    assert.equal((await targets())[0]!.state, "local");
    await command("media_play", { displayId: ROKU, itemId: l.id, takeBack: true });
    assert.equal(t.yt.tvs.list()[0]!.local, null);
  });

  test("media_stop clears the queue; the TV is just linked again", async () => {
    await linkedAndMapped();
    const l = await list();
    await command("media_play", { displayId: ROKU, itemId: l.id });
    const r = await command<{ ok: boolean }>("media_stop", { displayId: ROKU });
    assert.equal(r.ok, true);
    assert.equal(t.yt.tvs.list()[0]!.queue, null);
    assert.equal((await targets())[0]!.state, "linked");
  });

  test("the admin's Play starts YouTube through the box too", async () => {
    const tv = await linkedAndMapped();
    const l = await list();
    t.lounge.appOpen = false;
    core.onLaunch = () => void setTimeout(() => (t.lounge.appOpen = true), 100);
    const r = await t.send("POST", "/api/admin/play", { tvIds: [tv.id], listId: l.id }, t.token);
    assert.equal(((await r.json()) as { pending: number }).pending, 1);
    await until(() => setPlaylists() === 1, "played");
    await t.call("POST", `/tvs/${tv.id}/open`);
    assert.equal(core.launches.length, 2);
  });
});

test("attention goes to the box's Tonight page", async () => {
  const tv = await linkedAndMapped();
  t.yt.store.tvs.find((x) => x.id === tv.id)!.relink = true;
  await t.yt.store.saveTvs();
  await t.restart();
  await until(() => t.yt.tvs.list()[0]?.link === "relink", "relink");
  await t.yt.media.pushAttention();
  assert.match(JSON.stringify(core.attention), /Re-link it with a new TV code/);
});
