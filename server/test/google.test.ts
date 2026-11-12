// Google sign-in (device flow), the library read from YouTube, and connection health.
import { afterEach, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import type { AdminState, GoogleStatus, ListSummary, SavedList, SearchHit, YtPlaylist } from "@ytapp/shared";
import { startApp, until, type TestApp } from "./fakes.js";

let t: TestApp;
beforeEach(async () => (t = await startApp()));
afterEach(() => t.stop());

const status = () => t.call<AdminState>("GET", "/state").then((s) => s.google);

async function signIn(): Promise<void> {
  await t.call("PUT", "/google/config", { clientId: t.google.clientId, clientSecret: "secret-1" });
  const p = await t.call<{ userCode: string; verificationUrl: string }>("POST", "/google/signin");
  assert.equal(p.userCode, "ABCD-EFGH");
  await until(() => t.yt.google.status().state === "connected" && t.yt.google.status().account !== "", "signed in", 5000);
}

describe("setup and sign-in", () => {
  test("starts in setup; a bad client id is refused before Google sees it", async () => {
    assert.equal((await status()).state, "setup");
    await assert.rejects(t.call("PUT", "/google/config", { clientId: "nope" }), /apps\.googleusercontent\.com/);
  });

  test("a client Google doesn't know points at the wizard's client step", async () => {
    await t.call("PUT", "/google/config", { clientId: "999-x.apps.googleusercontent.com", clientSecret: "s" });
    await assert.rejects(t.call("POST", "/google/signin"), /doesn't recognize that OAuth client/);
    const s = await status();
    assert.deepEqual(s.problem, { kind: "client-invalid", wizardStep: 4 });
  });

  test("device flow: shows the code, polls, then connected with the channel name", async () => {
    await t.call("PUT", "/google/config", { clientId: t.google.clientId, clientSecret: "secret-1" });
    await t.call("POST", "/google/signin");
    const pending = await status();
    assert.equal(pending.state, "pending");
    assert.equal(pending.pending?.userCode, "ABCD-EFGH");
    await until(() => t.yt.google.status().state === "connected" && !!t.yt.google.status().account, "connected", 5000);
    const s = await status();
    assert.equal(s.account, "The Root Bar");
    assert.equal(s.channelHandle, "@therootbar");
    assert.equal(s.channelId, "UCrootbar0000000000000");
    assert.equal(s.hasClientSecret, true);
    // The secret and tokens never go back to the browser.
    const raw = JSON.stringify(await t.call("GET", "/state"));
    assert.ok(!raw.includes("secret-1") && !raw.includes("refresh-1") && !raw.includes("access-"));
  });

  test("a sign-in in progress resumes after a restart", async () => {
    await t.call("PUT", "/google/config", { clientId: t.google.clientId, clientSecret: "secret-1" });
    t.google.pendingPolls = 1_000_000;
    await t.call("POST", "/google/signin");
    await t.restart();
    assert.equal((await status()).state, "pending");
    t.google.pendingPolls = 0;
    await until(() => t.yt.google.status().state === "connected", "connected after restart", 5000);
  });

  test("the fallback sign-in is only offered when the server has it", async () => {
    assert.equal((await status()).fallbackAvailable, false);
    await assert.rejects(t.call("PUT", "/google/config", { mode: "fallback" }), /isn't available/);
    const f = await startApp({ googleFallback: { clientId: "123-abc.apps.googleusercontent.com", clientSecret: "op" } });
    try {
      // Nothing set up yet: Bar Games' sign-in is the default, ready to sign in.
      const first = (await f.call<AdminState>("GET", "/state")).google;
      assert.deepEqual([first.mode, first.state], ["fallback", "signed-out"]);
      await f.call("POST", "/google/signin");
      await until(() => f.yt.google.status().state === "connected", "fallback connected", 5000);
      assert.equal(f.yt.google.status().mode, "fallback");
      // Choosing our own project sticks.
      await f.call("PUT", "/google/config", { mode: "own" });
      assert.equal(f.yt.google.status().mode, "own");
    } finally {
      await f.stop();
    }
  });
});

describe("library from YouTube", () => {
  test("browse my YouTube, import, and the list's videos", async () => {
    await signIn();
    const mine = await t.call<YtPlaylist[]>("GET", "/youtube/playlists");
    assert.deepEqual(mine.map((p) => p.title), ["Bar queue", "Chill"]);
    const l = await t.call<ListSummary>("POST", "/lists", { playlistId: "PLbarqueue0001" });
    assert.equal(l.count, 120);
    assert.equal(l.source.kind, "youtube");
    const again = await t.call<YtPlaylist[]>("GET", "/youtube/playlists");
    assert.equal(again[0]!.savedAs, l.id);
    const full = await t.call<SavedList>("GET", `/lists/${l.id}`);
    assert.equal(full.videos[0]!.durationSec, 210);
  });

  test("deleted or private videos stay listed but aren't played", async () => {
    await signIn();
    const l = await t.call<ListSummary>("POST", "/lists", { link: "https://www.youtube.com/playlist?list=PLchill000002" });
    assert.equal(l.count, 4);
    assert.equal(l.playable, 3);
  });

  test("refresh picks up changes made in YouTube; nightly refreshes everything", async () => {
    await signIn();
    const l = await t.call<ListSummary>("POST", "/lists", { playlistId: "PLchill000002" });
    t.google.playlists.get("PLchill000002")!.videos.push({ id: "chNEW000000", title: "New one" });
    const r = await t.call<ListSummary>("POST", `/lists/${l.id}/refresh`);
    assert.equal(r.count, 5);
    t.google.playlists.get("PLchill000002")!.videos.push({ id: "chNEW000001", title: "Newer" });
    await t.yt.nightly();
    assert.equal(t.yt.library.get(l.id).videos.length, 6);
    assert.ok((await t.call<AdminState>("GET", "/state")).lastNightlyRefresh);
  });

  test("YouTube lists are edited in YouTube; a copy can be edited here", async () => {
    await signIn();
    const l = await t.call<ListSummary>("POST", "/lists", { playlistId: "PLchill000002" });
    await assert.rejects(t.call("PATCH", `/lists/${l.id}`, { videoIds: [] }), /edit it there/);
    const c = await t.call<ListSummary>("POST", `/lists/${l.id}/copy`);
    assert.equal(c.source.kind, "local");
    const full = await t.call<SavedList>("GET", `/lists/${c.id}`);
    const reversed = full.videos.map((v) => v.id).reverse().slice(1);
    const edited = await t.call<SavedList>("PATCH", `/lists/${c.id}`, { videoIds: reversed, shuffle: true, noRepeatHours: 3 });
    assert.deepEqual(edited.videos.map((v) => v.id), reversed);
    assert.equal(edited.noRepeatHours, 3);
  });

  test("combine lists without duplicates", async () => {
    await signIn();
    const a = await t.call<ListSummary>("POST", "/lists", { playlistId: "PLchill000002" });
    const b = await t.call<ListSummary>("POST", "/lists", { name: "Mix" });
    await t.call("POST", `/lists/${b.id}/add`, { fromListId: a.id });
    const r = await t.send("POST", `/api/admin/lists/${b.id}/add`, { fromListId: a.id }, t.token);
    assert.equal(((await r.json()) as { added: number }).added, 0);
    assert.equal(t.yt.library.get(b.id).videos.length, 4);
  });

  test("search is capped per day", async () => {
    await signIn();
    await t.call("PUT", "/settings", { searchCap: 1 });
    const hits = await t.call<SearchHit[]>("GET", "/youtube/search?q=rick");
    assert.equal(hits[0]!.title, "Rick & Roll");
    await assert.rejects(t.call("GET", "/youtube/search?q=rick"), /today's 1 searches/);
    assert.equal((await status()).quota.searchesToday, 1);
    assert.ok((await status()).quota.usedToday >= 100);
  });

  test("links work with no Google at all (titles from oEmbed)", async () => {
    const l = await t.call<ListSummary>("POST", "/lists", { link: "https://youtu.be/dQw4w9WgXcQ" });
    assert.equal(l.name, "Never Gonna Give You Up");
    await assert.rejects(t.call("POST", "/lists", { playlistId: "PLchill000002" }), /Sign in with Google first/);
  });
});

describe("connection health", () => {
  test("a revoked sign-in shows Google disconnected; reconnecting fixes it", async () => {
    await signIn();
    t.google.refreshGrantValid = false;
    const s = await t.call<GoogleStatus>("POST", "/google/check");
    assert.equal(s.state, "disconnected");
    const st = await t.call<AdminState>("GET", "/state");
    assert.match(st.attention[0]!.message, /Google disconnected/);
    await assert.rejects(t.call("GET", "/youtube/playlists"), /Reconnect/);
    t.google.refreshGrantValid = true;
    t.google.pendingPolls = 0;
    await t.call("POST", "/google/signin");
    await until(() => t.yt.google.status().state === "connected", "reconnected", 5000);
  });

  test("quota exceeded: refreshes stop, lists stay, the reset time is shown", async () => {
    await signIn();
    const l = await t.call<ListSummary>("POST", "/lists", { playlistId: "PLchill000002" });
    t.google.quotaExceeded = true;
    await assert.rejects(t.call("POST", `/lists/${l.id}/refresh`), /daily limit/);
    const s = await status();
    assert.equal(s.problem?.kind, "quota");
    assert.ok(s.quota.resetsAt > t.clock.now);
    assert.equal(t.yt.library.get(l.id).videos.length, 4);
    assert.match(t.yt.library.get(l.id).refreshError ?? "", /daily limit/);
  });

  test("API turned off points at the wizard's API step", async () => {
    await signIn();
    t.google.apiDisabled = true;
    await assert.rejects(t.call("GET", "/youtube/playlists"), /turned off/);
    assert.deepEqual((await status()).problem, { kind: "api-disabled", wizardStep: 2 });
  });

  test("sign out forgets the account", async () => {
    await signIn();
    await t.call("POST", "/google/signout");
    const s = await status();
    assert.equal(s.state, "signed-out");
    assert.equal(s.account, "");
  });
});
