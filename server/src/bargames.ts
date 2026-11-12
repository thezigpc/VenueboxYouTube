// The app's single connection to a Bar Games box. Off a box (no BG_CORE_URL / BG_GAME_TOKEN)
// every call is a no-op and the app runs exactly as it does standalone (SDK rule 1).
//
// An app has no rooms, events or commands: level 1 is the venue's name, theme and time zone,
// plus an empty status for the box.

import { createBarGames, type BarGames } from "@bargames/sdk/server";
import { log } from "@bargames/gamekit/server";

export function makeBarGames(opts: { coreUrl?: string; token?: string; defaultName: string }): BarGames {
  const bg = createBarGames({ gameId: "youtube", defaultName: opts.defaultName, coreUrl: opts.coreUrl, token: opts.token });
  bg.setStatusProvider(() => ({ rooms: [] }));
  return bg;
}

export interface VenueFacts {
  name: string;
  timezone: string | null;
}

/** The venue's name and time zone on a box; null standalone or when the box can't be reached. */
export async function venueFacts(bg: BarGames): Promise<VenueFacts | null> {
  if (!bg.connected) return null;
  try {
    const ctx = await bg.venue();
    return { name: ctx.game.displayName, timezone: ctx.venue.timezone || null };
  } catch (err) {
    log.warn("bargames", "venue context unavailable", { err: String(err) });
    return null;
  }
}
