// Lists: the library. Lists are built in YouTube and read here ("Browse my YouTube",
// Refresh); lists built here can be arranged, combined and added to.

import { useEffect, useState, type FormEvent } from "react";
import type { ListSummary, SavedList, SearchHit, YtPlaylist } from "@ytapp/shared";
import { api } from "../api";
import type { PanelProps } from "../pages/AdminPage";

const ago = (t?: number) => {
  if (!t) return "never";
  const m = Math.round((Date.now() - t) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
};

function BrowseYouTube({ act, onClose, account }: Pick<PanelProps, "act"> & { onClose: () => void; account: string }) {
  const [items, setItems] = useState<YtPlaylist[] | null>(null);
  const [error, setError] = useState("");
  const load = () =>
    api
      .myPlaylists()
      .then(setItems)
      .catch((e: Error) => setError(e.message));
  useEffect(() => void load(), []);
  return (
    <section className="card">
      <header className="row between">
        <h2>Playlists on {account ? `"${account}"` : "this YouTube channel"}</h2>
        <button className="link" onClick={onClose}>
          Close
        </button>
      </header>
      {error && <p className="error">{error}</p>}
      {!items && !error && <p className="muted">Loading…</p>}
      {items?.length === 0 && (
        <div className="stack-sm muted">
          <p>
            YouTube has no playlists on the channel {account ? <b>"{account}"</b> : "signed in"}. (Watch Later and Liked videos can't be read by apps.)
          </p>
          <p className="small">
            Made one already? It's probably on another channel or Google account: check the name at the top right of YouTube when you open the playlist. To switch, go to the Google page,
            Sign out, then Sign in with Google and pick that channel when Google asks.
          </p>
        </div>
      )}
      <ul className="yt-list">
        {items?.map((p) => (
          <li key={p.id}>
            {p.thumb ? <img src={p.thumb} alt="" referrerPolicy="no-referrer" /> : <span className="thumb-empty" />}
            <span className="grow">
              {p.title}
              <span className="muted small">
                {" "}
                · {p.count} videos{p.privacy === "private" ? " · private" : ""}
              </span>
            </span>
            {p.savedAs ? (
              <span className="muted small">In the library</span>
            ) : (
              <button onClick={() => void act(() => api.createList({ playlistId: p.id }), `Added "${p.title}".`).then(() => load())}>Add</button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function SearchBox({ onPick, state }: { onPick: (id: string) => void } & Pick<PanelProps, "state">) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [error, setError] = useState("");
  const left = state.google.quota.searchCap - state.google.quota.searchesToday;
  const run = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    try {
      setHits(await api.search(q));
    } catch (err) {
      setError((err as Error).message);
    }
  };
  if (state.google.quota.searchCap <= 0) return null;
  return (
    <div className="stack-sm">
      <form className="row" onSubmit={run}>
        <input placeholder="Quick search YouTube" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" />
        <button disabled={q.trim().length < 2 || left <= 0}>Search</button>
      </form>
      <p className="muted small">{left > 0 ? `${left} searches left today.` : "No searches left today."}</p>
      {error && <p className="error small">{error}</p>}
      {hits && (
        <ul className="yt-list">
          {hits.map((h) => (
            <li key={h.id}>
              <img src={`https://i.ytimg.com/vi/${h.id}/default.jpg`} alt="" referrerPolicy="no-referrer" />
              <span className="grow">
                {h.title}
                <span className="muted small"> · {h.channel}</span>
              </span>
              <button onClick={() => onPick(h.id)}>Add</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ListEditor({ id, state, act, onClose }: Pick<PanelProps, "state" | "act"> & { id: string; onClose: () => void }) {
  const [list, setList] = useState<SavedList | null>(null);
  const [error, setError] = useState("");
  const [links, setLinks] = useState("");
  const [from, setFrom] = useState("");
  const [drag, setDrag] = useState<number | null>(null);
  const summary = state.lists.find((l) => l.id === id);
  const load = () =>
    api
      .list(id)
      .then(setList)
      .catch((e: Error) => setError(e.message));
  useEffect(() => void load(), [id, summary?.updatedAt]);

  if (error) return <p className="error card">{error}</p>;
  if (!list) return <p className="muted card">Loading…</p>;
  const local = list.source.kind === "local";
  const save = (patch: Record<string, unknown>, ok?: string) => act(() => api.updateList(list.id, patch).then(setList), ok);
  const order = (ids: string[]) => save({ videoIds: ids });
  const ids = list.videos.map((v) => v.id);
  const move = (from: number, to: number) => {
    if (to < 0 || to >= ids.length || from === to) return;
    const next = ids.slice();
    const [x] = next.splice(from, 1);
    next.splice(to, 0, x!);
    void order(next);
  };
  const add = (body: Record<string, unknown>) =>
    act(async () => {
      const r = await api.addToList(list.id, body);
      setList(r.value);
      if (!r.added) throw new Error("Those videos are already in the list.");
    }, "Added.");

  return (
    <section className="card stack">
      <header className="row between wrap">
        <form
          className="row grow"
          onSubmit={(e) => {
            e.preventDefault();
            const name = new FormData(e.currentTarget).get("name");
            void save({ name }, "Renamed.");
          }}
        >
          <input name="name" defaultValue={list.name} key={list.name} maxLength={80} aria-label="List name" className="grow" />
          <button>Rename</button>
        </form>
        <button className="link" onClick={onClose}>
          Close
        </button>
      </header>

      <p className="muted small">
        {local ? (
          "Built here."
        ) : (
          <>
            Read from YouTube, refreshed {ago(list.refreshedAt)}. Change it in YouTube, then Refresh.{" "}
            <a href={`https://www.youtube.com/playlist?list=${list.source.kind === "youtube" ? list.source.playlistId : ""}`} target="_blank" rel="noreferrer">
              Open in YouTube
            </a>
          </>
        )}
        {list.refreshError && <span className="error"> Last refresh failed: {list.refreshError}</span>}
      </p>

      <div className="row wrap">
        <label className="check">
          <input type="checkbox" checked={list.shuffle} onChange={(e) => void save({ shuffle: e.target.checked })} /> Shuffle
        </label>
        <label className="check">
          <input type="checkbox" checked={list.loop} onChange={(e) => void save({ loop: e.target.checked })} /> Loop
        </label>
        <label className="check">
          No repeat within
          <input
            type="number"
            min={0}
            max={168}
            className="num"
            defaultValue={list.noRepeatHours}
            key={`nr${list.noRepeatHours}`}
            onBlur={(e) => Number(e.target.value) !== list.noRepeatHours && void save({ noRepeatHours: Number(e.target.value) })}
          />
          hours {!list.shuffle && list.noRepeatHours > 0 && <span className="muted small">(with shuffle)</span>}
        </label>
      </div>

      <div className="row wrap">
        {!local && <button onClick={() => void act(() => api.refreshList(list.id).then(load), "Refreshed from YouTube.")}>Refresh from YouTube</button>}
        <button onClick={() => void act(() => api.copyList(list.id), "Copied. Edit the copy in Lists.")}>{local ? "Duplicate" : "Make a copy to edit here"}</button>
        <button className="link danger" onClick={() => confirm(`Delete "${list.name}" from the library? (Nothing changes in YouTube.)`) && void act(() => api.deleteList(list.id), "Deleted.").then(onClose)}>
          Delete
        </button>
      </div>

      {local && (
        <div className="stack-sm">
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              void add({ links }).then((ok) => ok && setLinks(""));
            }}
          >
            <input placeholder="Paste YouTube links (videos or playlists)" value={links} onChange={(e) => setLinks(e.target.value)} aria-label="Links to add" className="grow" />
            <button disabled={!links.trim()}>Add</button>
          </form>
          <div className="row">
            <select value={from} onChange={(e) => setFrom(e.target.value)} aria-label="Combine with">
              <option value="">Add every video from another list…</option>
              {state.lists
                .filter((l) => l.id !== list.id)
                .map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name} ({l.count})
                  </option>
                ))}
            </select>
            <button disabled={!from} onClick={() => void add({ fromListId: from }).then(() => setFrom(""))}>
              Combine
            </button>
          </div>
          {state.google.state === "connected" && <SearchBox state={state} onPick={(vid) => void add({ videoIds: [vid] })} />}
        </div>
      )}

      <ol className="videos">
        {list.videos.map((v, i) => (
          <li
            key={v.id}
            className={`${v.unavailable ? "is-off" : ""}${drag === i ? " is-drag" : ""}`}
            draggable={local}
            onDragStart={() => setDrag(i)}
            onDragOver={(e) => local && e.preventDefault()}
            onDrop={() => (drag !== null && move(drag, i), setDrag(null))}
            onDragEnd={() => setDrag(null)}
          >
            <img src={`https://i.ytimg.com/vi/${v.id}/default.jpg`} alt="" loading="lazy" referrerPolicy="no-referrer" />
            <span className="grow">
              {v.title || v.id}
              <span className="muted small">
                {v.channel && ` · ${v.channel}`}
                {v.durationSec ? ` · ${Math.floor(v.durationSec / 60)}:${String(v.durationSec % 60).padStart(2, "0")}` : ""}
                {v.unavailable && ` · ${v.unavailable} (skipped)`}
              </span>
            </span>
            {local && (
              <span className="row-tools">
                <button className="link" onClick={() => move(i, i - 1)} aria-label="Move up" disabled={i === 0}>
                  ↑
                </button>
                <button className="link" onClick={() => move(i, i + 1)} aria-label="Move down" disabled={i === ids.length - 1}>
                  ↓
                </button>
                <button className="link danger" onClick={() => void order(ids.filter((x) => x !== v.id))} aria-label="Remove">
                  ✕
                </button>
              </span>
            )}
          </li>
        ))}
      </ol>
      {list.videos.length === 0 && <p className="muted">Empty. Add videos above.</p>}
    </section>
  );
}

function ListCard({ l, onOpen }: { l: ListSummary; onOpen: () => void }) {
  return (
    <button className="list-card" onClick={onOpen}>
      {l.thumb ? <img src={l.thumb} alt="" referrerPolicy="no-referrer" /> : <span className="thumb-empty" />}
      <span className="list-name">{l.name}</span>
      <span className="muted small">
        {l.playable} video{l.playable === 1 ? "" : "s"}
        {l.count > l.playable && ` (+${l.count - l.playable} unavailable)`} · {l.source.kind === "youtube" ? "YouTube" : "built here"}
        {l.shuffle && " · shuffle"}
        {l.loop && " · loop"}
      </span>
      {l.refreshError && <span className="error small">Refresh failed</span>}
    </button>
  );
}

export function ListsPanel({ state, act, go }: PanelProps) {
  const [open, setOpen] = useState<string | null>(null);
  const [browse, setBrowse] = useState(false);
  const [link, setLink] = useState("");
  const g = state.google;
  const signedIn = g.state === "connected";

  if (open && state.lists.some((l) => l.id === open)) return <ListEditor id={open} state={state} act={act} onClose={() => setOpen(null)} />;

  return (
    <div className="stack">
      <section className="card stack-sm">
        <h2>Add lists</h2>
        <p className="muted small">
          Build and edit playlists in YouTube itself (app or website), signed in to the venue's account, then add them here. Lists refresh every night at{" "}
          {state.settings.refreshHour}:00, or press Refresh.
        </p>
        <div className="row wrap">
          {signedIn ? (
            <button className="primary" onClick={() => setBrowse(true)}>
              Browse my YouTube
            </button>
          ) : (
            <button className="primary" onClick={() => go("google")}>
              Sign in with Google to browse your playlists
            </button>
          )}
          <button onClick={() => void act(() => api.createList({ name: "New list" }), "Created. Open it to add videos.")}>New empty list</button>
          {state.lists.some((l) => l.source.kind === "youtube") && (
            <button
              onClick={() =>
                void act(async () => {
                  const r = await api.refreshAll();
                  if (r.stopped) throw new Error(r.stopped);
                  if (r.failed) throw new Error(`${r.failed} list(s) couldn't be read.`);
                }, "All lists refreshed.")
              }
            >
              Refresh all
            </button>
          )}
        </div>
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            void act(() => api.createList({ link }), "Added.").then((ok) => ok && setLink(""));
          }}
        >
          <input placeholder="…or paste a YouTube playlist or video link" value={link} onChange={(e) => setLink(e.target.value)} aria-label="Link" className="grow" />
          <button disabled={!link.trim()}>Add</button>
        </form>
      </section>

      {browse && <BrowseYouTube act={act} onClose={() => setBrowse(false)} account={g.account} />}

      <div className="list-grid">
        {state.lists.map((l) => (
          <ListCard key={l.id} l={l} onOpen={() => setOpen(l.id)} />
        ))}
      </div>
      {state.lists.length === 0 && <p className="muted">The library is empty.</p>}
    </div>
  );
}
