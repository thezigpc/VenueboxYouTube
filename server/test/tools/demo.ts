// Dev aid: the app with the test fakes (fake TV + fake Google) on PORT, for looking at the
// admin UI without a real TV or Google account. Run behind `npx bargames mock-box`:
//   BG_CORE_URL=http://127.0.0.1:7199 BG_GAME_TOKEN=dev-token PORT=3106 npx tsx server/test/tools/demo.ts
import path from "node:path";
import { startApp } from "../fakes.js";

const t = await startApp({ coreUrl: process.env.BG_CORE_URL, coreToken: process.env.BG_GAME_TOKEN, clientDist: path.resolve("client/dist"), tvTiming: {}, noLogin: true });
// On a box setup is refused: sign in the way box staff do.
const trusted = await fetch(t.url + "/api/admin/trusted", { method: "POST", headers: { "x-bargames-via": "1", "x-bargames-staff": "1" } });
t.token = ((await trusted.json()) as { token: string }).token;
await t.call("PUT", "/google/config", { clientId: t.google.clientId, clientSecret: "demo" });
await t.call("POST", "/google/signin");
while (t.yt.google.status().state !== "connected") await new Promise((r) => setTimeout(r, 200));
await t.call("POST", "/lists", { playlistId: "PLbarqueue0001" });
const chill = await t.call<{ id: string }>("POST", "/lists", { playlistId: "PLchill000002" });
const tv = await t.call<{ id: string }>("POST", "/tvs", { code: "111122223333", name: "Bar left" });
await new Promise((r) => setTimeout(r, 500));
await t.call("POST", "/tvs", { code: "111122223333", name: "Patio" }).catch(() => undefined);
const lists = t.yt.library.all();
await t.call("POST", "/play", { tvIds: [tv.id], listId: lists[0]!.id });
const v = t.yt.tvs.list()[0]!.queue!;
t.lounge.push("nowPlaying", { videoId: lists[0]!.videos.find((x) => x.title)!.id, currentTime: "84", duration: "210", state: "1" });
t.lounge.push("onVolumeChanged", { volume: "40", muted: "false" });
void chill;
void v;
// Serve it on PORT behind the mock gateway.
const { createServer } = await import("node:http");
createServer(t.yt.app).listen(Number(process.env.PORT ?? 3106), () => console.log("demo ready", t.url));
