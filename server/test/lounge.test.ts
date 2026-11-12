// The Lounge wire format (protocol.ts) on its own: chunk framing, events, command bodies.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ChunkParser, commandBody, LoungeError, parseEvents, playState, screenNameFromStatus } from "../src/lounge/protocol.js";
import { pairWithCode, refreshLoungeToken } from "../src/lounge/client.js";
import { chunk } from "./fakes.js";

test("chunks parse whole, split anywhere, or several at once", () => {
  const a = chunk([[0, ["c", "SID-1", "", 8]], [1, ["S", "gs"]]]);
  const b = chunk([[2, ["nowPlaying", { videoId: "dQw4w9WgXcQ", state: "1" }]]]);
  const whole = new ChunkParser().push(a + b);
  assert.equal(whole.length, 2);
  assert.deepEqual(whole[0]![0], { id: 0, name: "c", args: ["SID-1", "", 8] });
  assert.equal(whole[1]![0]!.name, "nowPlaying");

  const p = new ChunkParser();
  const all = a + b;
  const got = [];
  for (let i = 0; i < all.length; i += 7) got.push(...p.push(all.slice(i, i + 7)));
  assert.deepEqual(got, whole);
});

test("a JSON chunk with newlines inside still parses (counted by line)", () => {
  const json = '[[5,["noop"]],\n[6,["onVolumeChanged",{"volume":"40","muted":"false"}]]]';
  const events = new ChunkParser().push(`${json.length + 1}\n${json}\n`)[0]!;
  assert.deepEqual(events.map((e) => e.name), ["noop", "onVolumeChanged"]);
});

test("a final chunk without its newline comes out at end()", () => {
  const p = new ChunkParser();
  const json = '[[1,["noop"]]]';
  assert.deepEqual(p.push(`${json.length + 1}\n${json}`), []);
  assert.equal(p.end()[0]![0]!.name, "noop");
});

test("garbage is a protocol error, not a crash", () => {
  assert.throws(() => new ChunkParser().push("hello\n"), (e: unknown) => e instanceof LoungeError && e.kind === "protocol");
  assert.throws(() => parseEvents("{nope"), (e: unknown) => e instanceof LoungeError && e.kind === "protocol");
});

test("command bodies follow pyytlounge's shape", () => {
  const b = commandBody("setPlaylist", { videoId: "a", videoIds: "a,b", currentIndex: 0 }, 3);
  assert.equal(b.get("count"), "1");
  assert.equal(b.get("ofs"), "3");
  assert.equal(b.get("req0__sc"), "setPlaylist");
  assert.equal(b.get("req0_videoIds"), "a,b");
  assert.equal(b.get("req0_currentIndex"), "0");
});

test("play states and screen names", () => {
  assert.equal(playState("1"), "playing");
  assert.equal(playState("2"), "paused");
  assert.equal(playState("0"), "ended");
  assert.equal(playState("-1"), "stopped");
  assert.equal(playState("1081"), "ad");
  assert.equal(playState("x"), "unknown");
  assert.equal(screenNameFromStatus({ devices: JSON.stringify([{ type: "REMOTE_CONTROL", name: "phone" }, { type: "LOUNGE_SCREEN", name: "Bar TV" }]) }), "Bar TV");
  assert.equal(screenNameFromStatus({ devices: "not json" }), null);
});

test("pairing and token errors have clear kinds", async () => {
  const answer = (status: number, body: unknown) => (async () => Response.json(body, { status })) as unknown as typeof fetch;
  await assert.rejects(pairWithCode("000000000000", answer(404, {})), (e: unknown) => e instanceof LoungeError && e.kind === "bad-code");
  await assert.rejects(pairWithCode("000000000000", answer(200, { nope: 1 })), (e: unknown) => e instanceof LoungeError && e.kind === "protocol");
  assert.equal((await pairWithCode("1", answer(200, { screen: { screenId: "s", loungeToken: "t", name: "TV" } }))).screenName, "TV");
  await assert.rejects(refreshLoungeToken("s", answer(200, { screens: [] })), (e: unknown) => e instanceof LoungeError && e.kind === "unlinked");
  const offline = (async () => {
    throw new TypeError("fetch failed");
  }) as unknown as typeof fetch;
  await assert.rejects(refreshLoungeToken("s", offline), (e: unknown) => e instanceof LoungeError && e.kind === "network");
});
