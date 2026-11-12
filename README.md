# VenueboxYouTube

A Bar Games ("Venuebox") app: staff pick YouTube playlists and send them to the venue's TVs.
Videos play in each TV's own YouTube app, under the venue's Premium account (no ads). This
app is the remote and the library; it never streams video.

- **TVs:** linked once with YouTube's "Link with TV code" (Settings on the TV). Then:
  play a list on one TV or several, pause/skip/volume, add a video, save the queue.
- **Lists:** built in YouTube itself and read here ("Browse my YouTube", refreshed nightly),
  or put together here from links, other lists and a capped quick search.
- **Google:** "Sign in with Google" by code (google.com/device), read-only. A wizard sets
  up the venue's own Google project, or the operator's sign-in is used when the server has it.
- **Guests** (`/`): what's playing on each TV.

## Run

```
npm install
npm run dev        # server :3006, client :5176
npm test
npm run build && npm start
```

Docker: `docker compose up -d --build` (see `docker-compose.yml`, `.env.example`).

Env: `PORT` (3006), `DATA_DIR`, `ADMIN_PASSWORD`, `GAME_NAME`, `TZ`, and optionally
`GOOGLE_FALLBACK_CLIENT_ID` / `GOOGLE_FALLBACK_CLIENT_SECRET` (the operator's OAuth client,
type "TVs and Limited Input devices"; never commit it).

See `BARGAMES.md` for the box integration and `CLAUDE.md` for the design decisions.
