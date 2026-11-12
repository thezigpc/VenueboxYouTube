// Live check of the Lounge protocol against a real TV (dev aid, not a test):
//   npx tsx server/test/tools/live-lounge.ts <12-digit TV code>
// Pairs a separate remote ("Lounge test"), then checks what the fakes can't:
//   1. setPlaylist with several videoIds: does the TV go on to video 2 by itself?
//   2. addVideo: does an added video join the TV's queue?
//   3. pause / play / setVolume / next.
// Prints the events it saw. Stores nothing.

import { LoungeSession, pairWithCode } from "../../src/lounge/client.js";
import { playState, type LoungeEvent } from "../../src/lounge/protocol.js";

const code = (process.argv[2] ?? "").replace(/\D/g, "");
if (code.length !== 12) {
  console.error("usage: live-lounge.ts <12-digit TV code>");
  process.exit(2);
}

const t0 = Date.now();
const stamp = () => `${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let nowId = "";
let state = "";
let volume: number | null = null;
const seen: string[] = [];

function onEvent(e: LoungeEvent) {
  const a = (e.args[0] ?? {}) as Record<string, unknown>;
  if (e.name === "nowPlaying") {
    nowId = typeof a.videoId === "string" ? a.videoId : "";
    if (nowId && !seen.includes(nowId)) seen.push(nowId);
    console.log(stamp(), "nowPlaying", nowId || "(none)", a.state !== undefined ? playState(a.state) : "");
  } else if (e.name === "onStateChange") {
    state = playState(a.state);
    console.log(stamp(), "state", state, a.currentTime ? `@${Number(a.currentTime).toFixed(0)}s` : "");
  } else if (e.name === "onVolumeChanged") {
    volume = Number(a.volume);
    console.log(stamp(), "volume", a.volume, a.muted === "true" ? "(muted)" : "");
  } else if (!["noop", "loungeStatus", "onAutoplayModeChanged", "onHasPreviousNextChanged", "playlistModified", "autoplayUpNext", "onSubtitlesTrackChanged"].includes(e.name)) {
    console.log(stamp(), e.name, JSON.stringify(e.args).slice(0, 160));
  } else if (e.name === "playlistModified") {
    console.log(stamp(), "playlistModified", JSON.stringify(a).slice(0, 160));
  }
}

const until = async (cond: () => boolean, ms: number) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await sleep(200);
  return cond();
};

const screen = await pairWithCode(code);
console.log(stamp(), "paired with", JSON.stringify(screen.screenName));
const s = new LoungeSession({ screenId: screen.screenId, loungeToken: screen.loungeToken, deviceName: "Lounge test", onEvent });
await s.connect();
const abort = new AbortController();
void (async () => {
  while (!abort.signal.aborted) {
    try {
      await s.subscribe(abort.signal);
    } catch (err) {
      if (!abort.signal.aborted) console.log(stamp(), "subscribe error", String(err));
      await sleep(1000);
      if (!s.connected) await s.connect().catch(() => undefined);
    }
  }
})();
await sleep(1500);

const results: Record<string, string> = {};
// "Me at the zoo" (19 s), then two long videos.
const A = "jNQXAC9IVRw", B = "9bZkp7q19f0", C = "dQw4w9WgXcQ", D = "kJQP7kiw5Fk";

console.log(stamp(), "--- 1. setPlaylist with 3 ids, waiting for the 19 s video to end");
await s.command("setPlaylist", { videoId: A, videoIds: [A, B, C].join(","), currentIndex: 0, currentTime: 0, audioOnly: "false", listId: "" });
results.started = (await until(() => nowId === A, 20_000)) ? "yes" : `no (now ${nowId || "nothing"})`;
results.autoAdvance = (await until(() => nowId === B, 45_000)) ? "yes: went on to video 2 by itself" : `no (now ${nowId || "nothing"}, state ${state})`;

console.log(stamp(), "--- 2. addVideo, then next twice");
await s.command("addVideo", { videoId: D, videoSources: "XX" });
await sleep(1500);
await s.command("next");
results.nextToC = (await until(() => nowId === C, 15_000)) ? "yes" : `no (now ${nowId})`;
await sleep(2000);
await s.command("next");
results.addedPlays = (await until(() => nowId === D, 15_000)) ? "yes: added video joined the queue" : `no (now ${nowId})`;

console.log(stamp(), "--- 3. pause / play / volume");
await sleep(3000);
await s.command("pause");
results.pause = (await until(() => state === "paused", 8000)) ? "yes" : `no (${state})`;
await s.command("play");
results.play = (await until(() => state === "playing", 8000)) ? "yes" : `no (${state})`;
const before = volume;
await s.command("setVolume", { volume: 30 });
results.volume = (await until(() => volume === 30, 8000)) ? "yes" : `no (${volume})`;
if (before !== null && before !== 30) await s.command("setVolume", { volume: before });
await s.command("pause");

console.log("\nRESULTS", JSON.stringify(results, null, 2));
console.log("videos seen:", seen.join(", "));
abort.abort();
await s.disconnect();
process.exit(0);
