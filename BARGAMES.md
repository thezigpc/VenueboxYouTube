# Bar Games integration: YouTube (app)

**Level 1, `kind: "app"`, SDK 0.8.0, game kit 0.5.1.** No rooms, events or commands.

## Manifest
`bargames.json`: id `youtube`, port 3006, routes `/` (guest Now Playing), `/admin`
(host and admin), **no `routes.table`** (the TVs play in their own YouTube apps),
`network.internet: true` (YouTube Lounge + Google APIs; nothing on the LAN), 256m.
`npx bargames validate .` passes with two expected warnings: not pinned by digest, and
no TV view.

## `npx bargames check` (SDK 0.8.0 mock box, server on :3106)
```
youtube@0.1.0 · level 1 · http://127.0.0.1:3106
✓ health /health → 200
✓ /__bargames/venue.json returns the box's branding ("YouTube (mock)")
✓ /__bargames/theme.css served
✓ phone page (routes.player) / → 200
all checks passed
```
Checked by hand through the mock gateway: staff link `/__bargames/staff?next=/admin`
opens the admin without a password; mock theme applied; `BackToGames` on `/`.
`server/test/tools/demo.ts` runs the app with the test fakes (a fake TV and Google) for
looking at the admin without a real TV.

## Server
- `createBarGames({ gameId: "youtube" })`, middleware before `/api` and the SPA; status
  provider `{ rooms: [] }`.
- Name: the venue's name for the app on a box, else the admin's setting, `GAME_NAME`,
  "YouTube". It's also the remote's name shown on the TVs.
- Time zone: `ctx.venue.timezone` for the nightly refresh (4:00 by default) and the
  admin; standalone the container's `TZ`.
- Staff sign-in: `adminRouter({ trusted: bg.isStaff })`, `createAdminAuth({ venuePassword:
  bg.checkVenuePassword, onBox: bg.connected })`, `staffSignIn()` on the admin page.
  Tested against a fake core in `server/test/api.test.ts`.
- Restarts: TV links, queues and a Google sign-in in progress are reloaded from DATA_DIR
  at boot and resume on their own (tested).
- "Needs attention": `GET /api/admin/state` returns `attention: [{ level, message,
  actionPath }]` (Google disconnected, quota, API off, a TV that needs a new code), ready
  for the SDK 0.9.0 hook.

## Guest page
`/api/now` gives TV names, titles, channels and thumbnails only: no ids, TV codes,
tokens or account names (tested).

## Container
- Writes only under `/data`: `admin.json`, `settings.json`, `lists.json`, `tvs.json`
  (0600: lounge tokens), `google.json` (0600: client secret, refresh token),
  `usage.json`, `history.json`. The process sets umask 077.
- Multi-stage `Dockerfile`, `USER node`, `/data` chowned. Pure Node (the Lounge client is
  a TypeScript port, no Python sidecar).
- Not yet built on the Linux Docker host.

## Fallback Google client (the operator's sign-in)
- Google project "Bar Games YouTube" (in production, unverified), client type "TVs and
  Limited Input devices", scope `youtube.readonly`. Its home page and privacy policy are
  GitHub Pages from `docs/`: https://thezigpc.github.io/VenueboxYouTube/ and
  `/privacy.html` (authorized domain `thezigpc.github.io`). Google's review is needed
  before about 100 accounts.
- On a box: box admin → Apps → YouTube → "Secret settings", names
  `GOOGLE_FALLBACK_CLIENT_ID` and `GOOGLE_FALLBACK_CLIENT_SECRET`. Core keeps them owner-only
  (`data/core/app-secrets.json`, 0600) and injects them as container env at start; saving
  one restarts the app. Value fields are write-only (the admin shows names and lengths).
  API: `GET /api/games/youtube/secrets`, `PUT/DELETE /api/games/youtube/secrets/<NAME>`.
- Standalone: the same two names in the container's `.env`. Never in the repo.
- Check: the boot log says `fallbackSignIn=true`.

## Box-side, later (agreed with the box session)
- SDK 0.9.0 "needs attention" hook.
- "Media providers": the box's TVs page and startup choice offering these lists, mapping
  box TVs to linked TVs. Roku ECP fallback. Not in v1.
