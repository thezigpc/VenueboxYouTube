import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const num = (name: string, fallback: number) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

export const PORT = num("PORT", 3006);
/** Built client, served by this process (one origin). */
export const CLIENT_DIST_PATH = process.env.CLIENT_DIST_PATH ?? path.resolve(here, "../../client/dist");
/** Everything written at runtime (see store.ts). */
export const DATA_DIR = path.resolve(process.env.DATA_DIR ?? path.resolve(here, "../../data"));
/** Overrides the password chosen on the /admin setup screen. */
export const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD ?? "";
/** Standalone name ("YouTube" by default; the admin's name setting wins, the venue's rename on a box). */
export const GAME_NAME = process.env.GAME_NAME ?? "";
/**
 * The operator's Google OAuth client ("Use Bar Games' sign-in"). Optional: without it the
 * button isn't offered. Container env only: never in the repo or bargames.json.
 */
export const GOOGLE_FALLBACK =
  process.env.GOOGLE_FALLBACK_CLIENT_ID && process.env.GOOGLE_FALLBACK_CLIENT_SECRET
    ? { clientId: process.env.GOOGLE_FALLBACK_CLIENT_ID, clientSecret: process.env.GOOGLE_FALLBACK_CLIENT_SECRET }
    : null;
