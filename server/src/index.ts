import { createServer } from "node:http";
import { log } from "@bargames/gamekit/server";
import { DEFAULT_NAME } from "@ytapp/shared";
import { createApp } from "./app.js";
import { makeBarGames } from "./bargames.js";
import { ADMIN_PASSWORD, CLIENT_DIST_PATH, DATA_DIR, GAME_NAME, GOOGLE_FALLBACK, PORT } from "./config.js";

// TV links and Google tokens live in DATA_DIR: nothing written here is for other users.
process.umask(0o077);

const bg = makeBarGames({ defaultName: GAME_NAME || DEFAULT_NAME });
const yt = await createApp({
  dataDir: DATA_DIR,
  bg,
  adminPassword: ADMIN_PASSWORD,
  gameName: GAME_NAME,
  clientDist: CLIENT_DIST_PATH,
  googleFallback: GOOGLE_FALLBACK,
});

const server = createServer(yt.app);
server.listen(PORT, () => log.info("boot", "listening", { port: PORT, dataDir: DATA_DIR, box: bg.connected, fallbackSignIn: !!GOOGLE_FALLBACK }));

let stopping = false;
function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  log.info("boot", "shutting down", { signal });
  setTimeout(() => process.exit(0), 3000).unref();
  void yt
    .close()
    .catch(() => undefined)
    .then(() => bg.flush())
    .finally(() => server.close(() => process.exit(0)));
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
