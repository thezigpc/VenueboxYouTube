// Add from a channel: look one up by link or @handle (or pick a subscription), then add its
// newest uploads as a list (refreshed nightly) or one of its playlists.

import { useEffect, useState, type FormEvent } from "react";
import type { YtChannel, YtPlaylist } from "@ytapp/shared";
import { api } from "../api";
import type { PanelProps } from "../pages/AdminPage";

function ChannelCard({ q, act, onBack }: Pick<PanelProps, "act"> & { q: string; onBack?: () => void }) {
  const [data, setData] = useState<{ channel: YtChannel; playlists: YtPlaylist[] } | null>(null);
  const [error, setError] = useState("");
  const [limit, setLimit] = useState(200);
  const [skipShorts, setSkipShorts] = useState(true);
  const load = () =>
    api
      .channel(q)
      .then(setData)
      .catch((e: Error) => setError(e.message));
  useEffect(() => {
    setData(null);
    setError("");
    void load();
  }, [q]);

  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">Looking it up…</p>;
  const c = data.channel;
  return (
    <div className="stack-sm">
      <div className="row">
        {c.thumb ? <img className="avatar" src={c.thumb} alt="" referrerPolicy="no-referrer" /> : null}
        <div className="grow">
          <b>{c.title}</b>
          <span className="muted small">
            {" "}
            {c.handle} {c.videoCount !== null && `· ${c.videoCount.toLocaleString()} videos`}
          </span>
        </div>
        {onBack && (
          <button className="link" onClick={onBack}>
            Back
          </button>
        )}
      </div>
      <div className="row wrap">
        <label className="check small">
          Newest
          <select value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
            {[25, 50, 100, 200, 500].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          videos
        </label>
        <label className="check small">
          <input type="checkbox" checked={skipShorts} onChange={(e) => setSkipShorts(e.target.checked)} /> Skip Shorts
        </label>
        <button className="primary" onClick={() => void act(() => api.createList({ channelId: c.id, limit, skipShorts }), `Added "${c.title}".`).then(() => load())}>
          {c.savedAs ? "Update the channel list" : "Add as a list"}
        </button>
      </div>
      <p className="muted small">Refreshed nightly, so new uploads show up on their own. About {Math.ceil(limit / 50) * 2 + 1} of YouTube's 10,000 daily units per refresh.</p>
      {data.playlists.length > 0 && (
        <>
          <h3 className="small">Its playlists</h3>
          <ul className="yt-list">
            {data.playlists.map((p) => (
              <li key={p.id}>
                {p.thumb ? <img src={p.thumb} alt="" referrerPolicy="no-referrer" /> : <span className="thumb-empty" />}
                <span className="grow">
                  {p.title}
                  <span className="muted small"> · {p.count} videos</span>
                </span>
                {p.savedAs ? (
                  <span className="muted small">In the library</span>
                ) : (
                  <button onClick={() => void act(() => api.createList({ playlistId: p.id }), `Added "${p.title}".`).then(() => load())}>Add</button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

export function ChannelBrowser({ act, onClose, signedIn }: Pick<PanelProps, "act"> & { onClose: () => void; signedIn: boolean }) {
  const [input, setInput] = useState("");
  const [q, setQ] = useState("");
  const [subs, setSubs] = useState<YtChannel[] | null>(null);
  const [subsError, setSubsError] = useState("");
  const [filter, setFilter] = useState("");

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setQ(input.trim());
  };
  const loadSubs = () =>
    api
      .subscriptions()
      .then(setSubs)
      .catch((e: Error) => setSubsError(e.message));

  const shown = (subs ?? []).filter((c) => c.title.toLowerCase().includes(filter.toLowerCase()));
  return (
    <section className="card stack-sm">
      <header className="row between">
        <h2>Add from a channel</h2>
        <button className="link" onClick={onClose}>
          Close
        </button>
      </header>
      {q ? (
        <ChannelCard q={q} act={act} onBack={() => setQ("")} />
      ) : (
        <>
          <form className="row" onSubmit={submit}>
            <input className="grow" placeholder="Channel link or @handle" value={input} onChange={(e) => setInput(e.target.value)} aria-label="Channel" autoFocus />
            <button disabled={input.trim().length < 3}>Look up</button>
          </form>
          {signedIn &&
            (subs === null ? (
              <button className="link" onClick={() => void loadSubs()}>
                …or pick from my subscriptions
              </button>
            ) : (
              <div className="stack-sm">
                {subs.length > 10 && <input placeholder="Filter" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter subscriptions" />}
                <ul className="yt-list">
                  {shown.map((c) => (
                    <li key={c.id}>
                      {c.thumb ? <img className="avatar" src={c.thumb} alt="" referrerPolicy="no-referrer" /> : <span className="thumb-empty" />}
                      <span className="grow">{c.title}</span>
                      <button onClick={() => setQ(`https://www.youtube.com/channel/${c.id}`)}>Open</button>
                    </li>
                  ))}
                </ul>
                {subs.length === 0 && <p className="muted small">This channel isn't subscribed to any channels.</p>}
              </div>
            ))}
          {subsError && <p className="error small">{subsError}</p>}
        </>
      )}
    </section>
  );
}
