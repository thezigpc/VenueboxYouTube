# Venuebox YouTube app: project notes

An **app** for the Bar Games box ("Venuebox"): staff build and pick YouTube playlists and
send them to the venue's TVs: one TV, a group, or at boot. Playback happens in **each TV's
own YouTube app** (Roku, Google TV, Samsung, LG, Fire TV…); this app is the remote and the
library. It never streams video itself.

## Accounts (decided)
- **Premium = the TV's account.** Staff sign in to the venue's YouTube Premium account
  once in each TV's own YouTube app. Everything we queue plays under that account (no ads).
  We never see or store the Google password.
- **"Sign in with Google" in this app** (OAuth): lists and manages the venue account's
  own playlists, private ones included, so staff pick from them instead of pasting
  links. Use the same Premium account. Scope `youtube.readonly` to browse; the write scope
  (`youtube`) only if we add "save this list to YouTube". The user already has Premium.
- **The two accounts don't have to match.** We always send the TV a *queue of video ids*
  (never "play playlist X"), so the account signed in here only reads lists, private ones
  included, and the TV plays the videos under its own (Premium) account. Limits: a video
  that is itself private only plays if the TV's account can see it (public and unlisted
  always work), and age or region restrictions follow the TV's account. When the TV can't
  play a video, skip it and go on; never stall the queue.
- The Google Cloud project, OAuth client and API key are the user's: staff paste the
  client id/secret and API key into this app's admin. Secrets live in DATA_DIR, never in
  the repo. Keep the OAuth app **in production** (Testing mode expires refresh tokens after
  7 days); unverified is fine for a handful of venue accounts (Google shows a warning
  screen and caps at 100 users). Redirect URI: the app's own public address on the box,
  e.g. `https://youtube.<venue domain>/auth/google/callback` (Google requires https).

## Direction (decided 2026-11-12, overrides details below where they differ)
- **Lists are built in YouTube itself** (the YouTube app or website, signed in to the venue
  account). Our app reads them: "Browse my YouTube" plus **Refresh** (on demand and nightly).
  Reads are cheap (1 unit per 50 playlists / items / videos, so a 200-video list costs
  about 8 units); search costs 100 units, so **in-app search is optional** (a capped "quick
  add") or left out. The box-side list editor stays for arranging/combining saved lists.
- **Read-only Google access** (`youtube.readonly`): we never write playlists back.
- **Sign in with Google's TV / limited-input device flow**: the admin shows "go to
  google.com/device and enter ABCD-EFGH"; staff do it on their phone; the box polls for the
  token. No redirect URIs at all, so the operator's fallback client works for any
  venue domain (or a LAN-only box), with no central auth service. The OAuth client type is
  **"TVs and Limited Input devices"** (its secret isn't confidential by design). Confirm
  `youtube.readonly` against Google's allowed-scopes list for device clients at build time.
- **Publish the consent screen "In production"** (both models): no 7-day token expiry. An
  unverified app shows "Google hasn't verified this app" once at sign-in and is capped
  at 100 lifetime users per project. Per-venue projects stay far below that, so no review.
  The operator fallback needs Google's review before it nears 100 accounts.
  `youtube.readonly` is a *sensitive* (not restricted) scope: brand info, privacy
  policy, verified domains and a scope demo video; no security assessment.
- **Watch Later isn't readable through the API:** tell staff to use a normal playlist
  ("Bar queue").

## Google setup: two models (decided)
1. **Per venue (default): the venue's own Google project**, set up with a guided wizard in
   the admin. Each step opens the right Google Cloud page and checks the result before
   moving on: create the project → enable YouTube Data API v3 → consent screen
   (External, then **Publish to production**) → OAuth client "Web application", with the
   redirect URI shown with a copy button → paste the client id/secret, checked at once →
   "Sign in with Google" lists their playlists as the final proof. Google has no public
   API to create OAuth clients, so the wizard guides; it doesn't automate.
2. **Fallback: the operator's own Google project** (the user's), for venues that can't do
   step 1: they just click "Sign in with Google". It's shared by all fallback venues, so
   it needs Google's verification for the YouTube scopes and a quota increase (10k
   units/day is per project). Config: the box can hand the app the operator's client id
   (the secret stays server-side; design this with the box session) or the app is built
   with it. The venue chooses "Use our own Google project" or "Use Bar Games' sign-in".
- **No API key needed when signed in:** call the Data API with the OAuth access token. An
  API key is optional, only for running without any Google sign-in.

## Connection health (decided)
- API keys don't expire; **sign-ins do**: a revoked grant, a password change, Testing-mode
  7-day expiry, 6 months unused, or too many tokens. Test the refresh daily and after any
  `invalid_grant`. On failure show "Google disconnected" with a one-click **Reconnect**
  (it re-runs the sign-in; nothing else is lost).
- `quotaExceeded`: show today's usage and the reset time (midnight Pacific). An API that was
  turned off or a client that was deleted: link straight to the wizard step that fixes it.
- **Playback never depends on Google sign-in.** TVs are driven by their TV-code link, and
  lists are cached in DATA_DIR, so a disconnect only pauses browse/search/refresh.
- Box-wide "needs attention" (on the box's Tonight page) needs a platform hook: ask the
  box session when you get there.

## How TVs are controlled
1. **"Link with TV code" (main route, every TV with a modern YouTube app).** YouTube's own
   phone-to-TV remote ("Lounge"): staff open YouTube on the TV, Settings → "Link with TV
   code", and type the code into this app's admin once per TV. Then: set a queue (a list of
   video ids, which is how YouTube's own remote sends a playlist), play/pause, skip,
   volume, add to queue, and now-playing events. The protocol is **unofficial**: isolate it
   in one module with its own tests, and fail clearly when YouTube changes it. Study the
   existing open-source Lounge clients before writing ours:
   - pyytlounge (Python; pairing by code, control, now-playing events):
     https://pyytlounge.readthedocs.io/en/stable/ (port what we need to TypeScript, or run
     it as a small sidecar in the app's container if porting is a poor trade).
   - Home Assistant "YouTube on TV" (HACS, built on pyytlounge; TV-code-only devices such
     as Shield/Onn/Mi Box): https://community.home-assistant.io/t/youtube-on-tv-see-and-control-what-the-youtube-app-on-your-tv-is-playing/1026146
   - yttv (pair + queue CLI): https://pypi.org/project/yttv/ ; iSponsorBlockTV (same
     protocol); a Rust crate youtube_lounge_rs.
   - YouTube has revoked TV codes before: detect a dead link and show "Re-link this TV".
   - Home Assistant's official YouTube integration only does channel sensors (no playback):
     not a building block. An optional Home Assistant bridge could come later; the app
     must work without it.
2. **Roku fallback** (a Roku whose YouTube app won't link): the box launches YouTube with a
   video over Roku ECP and chains the next one when it ends. ECP is on the LAN and belongs
   to the box (the broker), not this container: ask the box session for it when needed.
3. **Android/Google TV with the Venuebox app** (later): the box hands the playlist URL to
   the YouTube app on the device. Box work, not this repo.
- Apple TV: not supported (no outside control of its YouTube app).

## Features (v1 → later)
- **Library (admin):** saved lists with name, thumbnail, video count, shuffle/loop defaults.
  Add by pasting a playlist or video link (API key, no login), **"Browse my YouTube"**
  (signed in), or search. Lists refresh nightly and on demand.
- **List builder:** box-native lists (video ids + titles + thumbnails in DATA_DIR): search
  and add, paste links, import a YouTube playlist then edit, combine lists, drag to
  reorder, "save this one" from Now Playing; rules: shuffle, loop, no repeat within N hours.
  Optional later: also save to the venue's YouTube account (write scope).
- **Play:** pick a list for a linked TV → set its queue. Now Playing per TV with
  pause/skip/volume and "add to queue".
- **Later, with box support** (ask the box session; don't build box-side code here):
  "Show on this TV" / group casting / "When the box starts" offering YouTube lists, "after a
  game, go back to its playlist", time-based switching, and guest requests (a public page
  where guests suggest, staff approve).
- **API quota** (10,000 units/day free): a search costs 100 units, playlist items 1 per 50
  videos. Cache everything; remember recent searches; cap guest searches.

## Platform
- `bargames.json`: `"kind": "app"`, `sdk.level` 1, `routes.player` `/` (Now Playing / later
  requests), `routes.admin` `/admin`, **no `routes.table`** (it has no TV page of its own),
  `network.internet: true` (YouTube and Google APIs).
- Staff sign-in comes from the box: `adminRouter({ ..., trusted: (req) => bg.isStaff(req) })`,
  `createAdminAuth({ venuePassword: (pw, ip) => bg.checkVenuePassword(pw, ip), onBox: bg.connected })`,
  `staffSignIn()` on the admin page; follow `status.venueLogin` / `setupAllowed`.
- Integration guide: `C:\CodeProjects\GameBroker\integration\README.md` (SDK 0.8.0, apps,
  staff sign-in); kit README: `C:\CodeProjects\GameKit\README.md`. Model to copy from:
  `C:\CodeProjects\MenuModule` (the Menu app: same stack, an app on the box).
- Vendored in `vendor/`: `bargames-sdk-0.8.0.tgz`, `bargames-gamekit-0.5.1.tgz`.
- Standalone it must still work (its own admin password, TVs linked by code), like every
  app; off a box the SDK changes nothing.

## Conventions
- npm workspaces (`shared`, `server`, `client`), TypeScript, Express 4, React 18 + Vite 5,
  Node 22 images, `node:test` via tsx. Image `ghcr.io/thezigpc/<name>` via the
  publish-image workflow snippet (`GameBroker\integration\snippets\publish-image.yml`).
- Commit when it makes sense; push and publish when the box session asks or the user does
  (the user allows push requests from the box session). Repo: https://github.com/thezigpc/VenueboxYouTube (public; image public on GHCR).

## Talking to the box session
The platform session (ListAgents, name starts with `gamebroker`) owns the SDK, the box and
TV control. Ask it for platform hooks; tell it "<id> <version> is published, please install
/ update the box" when a release is ready.

## Code map (v0.1.0, built 2026-11-11)
- `server/src/lounge/`: the unofficial Lounge protocol, alone. `protocol.ts` (chunk framing,
  events, command bodies, state codes) and `client.ts` (pair by code, renew the lounge
  token, bind/long-poll/commands). Ported from pyytlounge 3.6.0; `LoungeError.kind` says
  what broke (`bad-code`, `unlinked` = re-link, `expired`, `session`, `network`, `protocol`).
- `server/src/tvs.ts`: one session per TV, reconnect with backoff, queue driving
  (setPlaylist with a window of 50 ids, addVideo top-up, a new round for looping lists),
  a watchdog that skips a video that won't play (at most 5 in a row), "detached" when
  someone uses the TV's own remote.
- Local control (0.1.4): when someone uses a TV directly (plays something else, stops a
  video that played, leaves the video), the TV goes `local` (persisted in tvs.json) and the
  app does nothing automatic on it until staff press Take back, play a list or start a plan.
- `server/src/plans.ts`: saved TV plans (list per TV, optional loop override), Start.
- Channel lists (source kind `channel`): a channel's newest N uploads (Shorts ≤ 60 s
  skipped by default), refreshed nightly; channel lookup by @handle/id, its playlists,
  the account's subscriptions.
- `server/src/google/google.ts`: device-flow sign-in, token refresh, Data API reads, quota
  (Pacific day), problems pointing at wizard steps. `server/src/library.ts`: lists.
- Client: `pages/NowPage.tsx` (guests), `pages/AdminPage.tsx` with `admin/TvsPanel`,
  `ListsPanel`, `GooglePanel` (wizard), `SettingsPanel`.
- Tests: `server/test/fakes.ts` fakes YouTube's Lounge and Google; `npm test`.

## Not yet verified against the real thing
- A real TV: `setPlaylist` with `videoIds` (YouTube's remote convention; pyytlounge only
  sends one `videoId`) and `addVideo` with `videoSources: "XX"`. If a TV only plays the
  first video, the top-up and watchdog still advance it, but check on a Roku and a Google TV.
- A real Google project: the device flow with `youtube.readonly`.
