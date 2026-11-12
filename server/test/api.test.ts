// The public page's feed, admin protection, and Bar Games (standalone vs. a fake box).
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { TvInfo } from "@ytapp/shared";
import { startApp, until, type TestApp } from "./fakes.js";

describe("standalone", () => {
  let t: TestApp;
  before(async () => (t = await startApp({ gameName: "Bar Tube" })));
  after(() => t.stop());

  test("health and config", async () => {
    assert.equal((await t.get("/health")).status, 200);
    assert.deepEqual(await (await t.get("/api/config")).json(), { gameName: "Bar Tube" });
    const v = (await (await t.get("/__bargames/venue.json")).json()) as { standalone: boolean };
    assert.equal(v.standalone, true);
  });

  test("the admin API needs a session", async () => {
    assert.equal((await t.get("/api/admin/state")).status, 401);
    assert.equal((await t.send("POST", "/api/admin/tvs", { code: "111122223333" })).status, 401);
    assert.equal((await t.get("/api/admin/state", t.token)).status, 200);
  });

  test("the guest feed shows what's on, and nothing private", async () => {
    const tv = await t.call<TvInfo>("POST", "/tvs", { code: "111122223333", name: "Bar left" });
    await until(() => t.yt.tvs.list()[0]?.link === "connected" && t.lounge.openStreams > 0, "connected");
    await t.call("POST", "/play", { tvIds: [tv.id], link: "https://youtu.be/dQw4w9WgXcQ" });
    t.lounge.push("nowPlaying", { videoId: "dQw4w9WgXcQ", state: "1" });
    await until(() => t.yt.tvs.list()[0]?.nowPlaying?.state === "playing", "playing");
    const body = (await (await t.get("/api/now")).json()) as { tvs: { name: string; title: string; playing: boolean }[] };
    assert.deepEqual(body.tvs.map((x) => [x.name, x.title, x.playing]), [["Bar left", "Never Gonna Give You Up", true]]);
    const raw = JSON.stringify(body);
    for (const secret of ["screen-abc", "token-", tv.id, "111122223333"]) assert.ok(!raw.includes(secret), secret);
  });

  test("settings validate", async () => {
    await assert.rejects(t.call("PUT", "/settings", { searchCap: 500 }), /0 to 90/);
    await t.call("PUT", "/settings", { name: "The Root" });
    assert.deepEqual(await (await t.get("/api/config")).json(), { gameName: "The Root" });
  });

  test("gateway staff headers are ignored standalone", async () => {
    const staff = { "x-bargames-via": "1", "x-bargames-staff": "1" };
    assert.equal((await fetch(t.url + "/api/admin/trusted", { method: "POST", headers: staff })).status, 403);
  });
});

/** A fake box core with a venue name and time zone. */
async function fakeCore(): Promise<{ url: string; close: () => Promise<void> }> {
  const srv = http.createServer((req, res) => {
    if (req.headers.authorization !== "Bearer core-token") return void res.writeHead(401).end();
    const theme = { colors: { background: "#000000", surface: "#111111", text: "#ffffff", primary: "#ff0000", accent: "#00ff00" } };
    if (req.url === "/internal/venue") {
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(
        JSON.stringify({
          protocol: 1,
          venue: { name: "The Root Bar", theme, playUrl: "https://play.rootbar.example", timezone: "America/Chicago" },
          game: { id: "youtube", displayName: "Bar TV", theme },
          standalone: false,
          generatedAt: new Date().toISOString(),
        }),
      );
    }
    if (req.url === "/internal/events") return void res.writeHead(204).end();
    if (req.url === "/internal/venue-password") {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: JSON.parse(raw || "{}").password === "box-password" }));
      });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, close: () => new Promise((r) => srv.close(() => r())) };
}

describe("on a box", () => {
  let t: TestApp;
  let core: Awaited<ReturnType<typeof fakeCore>>;
  before(async () => {
    core = await fakeCore();
    t = await startApp({ coreUrl: core.url, coreToken: "core-token", noLogin: true });
  });
  after(async () => {
    await t.stop();
    await core.close();
  });

  test("the venue's name for the app is used", async () => {
    assert.deepEqual(await (await t.get("/api/config")).json(), { gameName: "Bar TV" });
  });

  test("the box's password signs in; setup is refused for guests", async () => {
    const s = (await (await t.get("/api/admin/status")).json()) as { venueLogin: boolean };
    assert.equal(s.venueLogin, true);
    assert.equal((await t.send("POST", "/api/admin/setup", { password: "guest password 1" })).status, 403);
    const r = await t.send("POST", "/api/admin/login", { password: "box-password" });
    assert.equal(r.status, 200);
    assert.ok(((await r.json()) as { token?: string }).token);
  });

  test("staff from the box admin get in without a password", async () => {
    const r = await fetch(t.url + "/api/admin/trusted", { method: "POST", headers: { "x-bargames-via": "1", "x-bargames-staff": "1" } });
    const body = (await r.json()) as { token?: string };
    assert.ok(body.token);
    const st = (await (await t.get("/api/admin/state", body.token)).json()) as { timezone: string };
    assert.equal(st.timezone, "America/Chicago");
  });
});
