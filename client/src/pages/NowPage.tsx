// "/": what's playing on the venue's TVs, for guests. Public on the games list, so it
// shows only TV names and titles (no codes, accounts or controls).

import { useEffect, useState } from "react";
import { BackToGames, basePath, useGameName, VenueAnnouncement } from "@bargames/gamekit/client";
import { DEFAULT_NAME, type PublicTv } from "@ytapp/shared";
import { api } from "../api";
import { useVenue } from "../useVenue";

export function NowPage() {
  const venue = useVenue();
  const name = useGameName(basePath(), DEFAULT_NAME);
  const [tvs, setTvs] = useState<PublicTv[] | null>(null);

  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const r = await api.now();
        if (!stop) setTvs(r.tvs);
      } catch {
        /* keep the last answer */
      }
      if (!stop) timer = setTimeout(load, document.hidden ? 60_000 : 15_000);
    };
    void load();
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, []);

  return (
    <div className="now-page">
      <VenueAnnouncement ctx={venue} />
      <header className="now-header">
        <h1>{name}</h1>
        <p className="muted">Now playing on the TVs</p>
      </header>
      <main className="now-list">
        {tvs === null && <p className="muted">Loading…</p>}
        {tvs?.length === 0 && (
          <div className="now-empty">
            <p>Nothing's playing right now.</p>
          </div>
        )}
        {tvs?.map((tv, i) => (
          <article key={`${tv.name}-${i}`} className="now-card">
            <img src={tv.thumb} alt="" loading="lazy" referrerPolicy="no-referrer" />
            <div>
              <p className="now-tv">
                {tv.name}
                {!tv.playing && <span className="pill">paused</span>}
              </p>
              <p className="now-title">{tv.title}</p>
              <p className="muted small">
                {tv.channel}
                {tv.listName && ` · ${tv.listName}`}
              </p>
            </div>
          </article>
        ))}
      </main>
      <footer className="now-footer">
        <BackToGames ctx={venue} />
      </footer>
    </div>
  );
}
