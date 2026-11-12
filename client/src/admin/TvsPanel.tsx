// TVs: link by TV code, Now Playing with controls, and "play this list on these TVs".

import { useState, type FormEvent } from "react";
import { thumbUrl, type TvInfo } from "@ytapp/shared";
import { api } from "../api";
import type { PanelProps } from "../pages/AdminPage";

const fmt = (s: number) => (s > 0 ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}` : "");

function LinkTvForm({ act, onDone, relinkId }: Pick<PanelProps, "act"> & { onDone?: () => void; relinkId?: string }) {
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const ok = await act(() => (relinkId ? api.relinkTv(relinkId, code) : api.linkTv(code, name)), relinkId ? "TV re-linked." : "TV linked.");
    setBusy(false);
    if (ok) {
      setCode("");
      setName("");
      onDone?.();
    }
  };
  return (
    <form className="link-form" onSubmit={submit}>
      <ol className="steps small">
        <li>On the TV, open the <b>YouTube</b> app (signed in to the venue's Premium account).</li>
        <li>
          Go to <b>Settings → Link with TV code</b>. It shows a 12-digit code.
        </li>
        <li>Type the code here within a few minutes.</li>
      </ol>
      <div className="row wrap">
        <input inputMode="numeric" placeholder="123 456 789 012" value={code} onChange={(e) => setCode(e.target.value)} aria-label="TV code" required />
        {!relinkId && <input placeholder="Name, e.g. Bar left" value={name} onChange={(e) => setName(e.target.value)} aria-label="TV name" maxLength={40} />}
        <button className="primary" disabled={busy || code.replace(/\D/g, "").length !== 12}>
          {busy ? "Linking…" : relinkId ? "Re-link" : "Link TV"}
        </button>
      </div>
    </form>
  );
}

function TvCard({ tv, state, act }: { tv: TvInfo } & Pick<PanelProps, "state" | "act">) {
  const [listId, setListId] = useState(tv.queue?.listId ?? "");
  const [link, setLink] = useState("");
  const [vol, setVol] = useState<number | null>(null);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(tv.name);
  const np = tv.nowPlaying;
  const live = tv.link === "connected";
  const ctl = (action: string, value?: number) => void act(() => api.control(tv.id, action, value));

  return (
    <section className={`card tv-card is-${tv.link}`}>
      <header className="tv-head">
        {editing ? (
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              void act(() => api.renameTv(tv.id, name)).then(() => setEditing(false));
            }}
          >
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} autoFocus aria-label="TV name" />
            <button className="primary">Save</button>
          </form>
        ) : (
          <h2>
            {tv.name}
            <button className="link small" onClick={() => setEditing(true)}>
              rename
            </button>
          </h2>
        )}
        <span className={`status status-${tv.link}`}>{tv.link === "connected" ? "Linked" : tv.link === "relink" ? "Needs a new code" : "Connecting…"}</span>
      </header>
      {tv.message && <p className={tv.link === "relink" ? "error small" : "muted small"}>{tv.message}</p>}
      {tv.link === "relink" && <LinkTvForm act={act} relinkId={tv.id} />}

      {np ? (
        <div className="np">
          <img src={thumbUrl(np.videoId)} alt="" referrerPolicy="no-referrer" />
          <div className="np-text">
            <p className="np-title">{np.title || np.videoId}</p>
            <p className="muted small">
              {np.channel}
              {np.durationSec > 0 && ` · ${fmt(np.positionSec)} / ${fmt(np.durationSec)}`} · {np.state}
            </p>
            {tv.queue && (
              <p className="muted small">
                {tv.queue.detached ? (
                  <>Playing something else (the TV's own remote). Press Play on a list to take over again.</>
                ) : (
                  <>
                    {tv.queue.listName} · {tv.queue.index + 1} of {tv.queue.length}
                    {tv.queue.loop && " · loops"}
                  </>
                )}
              </p>
            )}
          </div>
        </div>
      ) : (
        live && <p className="muted small">Nothing playing. Is YouTube open on the TV?</p>
      )}
      {tv.queue && !tv.queue.detached && tv.queue.upNext.length > 0 && (
        <details className="small">
          <summary>Up next</summary>
          <ol className="upnext">
            {tv.queue.upNext.map((v, i) => (
              <li key={`${v.id}-${i}`}>{v.title || v.id}</li>
            ))}
          </ol>
        </details>
      )}

      <div className="controls" aria-label="Controls">
        <button disabled={!live} onClick={() => ctl("previous")} aria-label="Previous">
          ⏮
        </button>
        {np?.state === "playing" ? (
          <button disabled={!live} onClick={() => ctl("pause")} aria-label="Pause">
            ⏸
          </button>
        ) : (
          <button disabled={!live} onClick={() => ctl("play")} aria-label="Play">
            ▶
          </button>
        )}
        <button disabled={!live} onClick={() => ctl("next")} aria-label="Next">
          ⏭
        </button>
        <label className="vol">
          <span className="small muted">Vol {vol ?? tv.volume ?? "–"}</span>
          <input
            type="range"
            min={0}
            max={100}
            disabled={!live}
            value={vol ?? tv.volume ?? 50}
            onChange={(e) => setVol(Number(e.target.value))}
            onPointerUp={() => vol !== null && (ctl("volume", vol), setVol(null))}
            onKeyUp={() => vol !== null && (ctl("volume", vol), setVol(null))}
          />
        </label>
        {tv.queue && (
          <button className="link small" disabled={!live} onClick={() => ctl("stop")}>
            Stop list
          </button>
        )}
      </div>

      <div className="row wrap">
        <select value={listId} onChange={(e) => setListId(e.target.value)} aria-label="List to play">
          <option value="">Choose a list…</option>
          {state.lists.map((l) => (
            <option key={l.id} value={l.id} disabled={!l.playable}>
              {l.name} ({l.playable})
            </option>
          ))}
        </select>
        <button className="primary" disabled={!live || !listId} onClick={() => void act(() => api.play({ tvIds: [tv.id], listId }), "Sent to the TV.")}>
          Play list
        </button>
      </div>
      <form
        className="row wrap"
        onSubmit={(e) => {
          e.preventDefault();
          void act(() => api.addToTv(tv.id, link), "Added to the queue.").then((ok) => ok && setLink(""));
        }}
      >
        <input placeholder="YouTube video link" value={link} onChange={(e) => setLink(e.target.value)} aria-label="Video link to add" />
        <button disabled={!live || !link.trim()}>Add to queue</button>
        <button type="button" className="link small" disabled={!live || !link.trim()} onClick={() => void act(() => api.play({ tvIds: [tv.id], link }), "Playing now.").then((ok) => ok && setLink(""))}>
          Play now
        </button>
      </form>
      <footer className="row wrap small">
        {tv.queue && tv.queue.length > 0 && (
          <button className="link" onClick={() => void act(() => api.createList({ fromTv: tv.id, name: `${tv.queue!.listName} (saved)` }), "Saved to Lists.")}>
            Save this queue as a list
          </button>
        )}
        <button className="link danger" onClick={() => confirm(`Unlink ${tv.name}? You'll need a new TV code to link it again.`) && void act(() => api.unlinkTv(tv.id), "Unlinked.")}>
          Unlink
        </button>
      </footer>
    </section>
  );
}

export function TvsPanel({ state, act, go }: PanelProps) {
  const [adding, setAdding] = useState(state.tvs.length === 0);
  const [groupList, setGroupList] = useState("");
  const [groupTvs, setGroupTvs] = useState<string[]>([]);
  const live = state.tvs.filter((t) => t.link === "connected");

  return (
    <div className="stack">
      {state.lists.length === 0 && (
        <p className="card muted">
          No lists yet. Build playlists in YouTube (signed in to the venue's account), then add them on the{" "}
          <button className="link" onClick={() => go("lists")}>
            Lists
          </button>{" "}
          page.
        </p>
      )}

      {live.length > 1 && state.lists.length > 0 && (
        <section className="card">
          <h2>Play on several TVs</h2>
          <div className="row wrap">
            {live.map((t) => (
              <label key={t.id} className="check">
                <input type="checkbox" checked={groupTvs.includes(t.id)} onChange={(e) => setGroupTvs((g) => (e.target.checked ? [...g, t.id] : g.filter((x) => x !== t.id)))} />
                {t.name}
              </label>
            ))}
          </div>
          <div className="row wrap">
            <select value={groupList} onChange={(e) => setGroupList(e.target.value)} aria-label="List">
              <option value="">Choose a list…</option>
              {state.lists.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
            <button
              className="primary"
              disabled={!groupList || !groupTvs.length}
              onClick={() =>
                void act(async () => {
                  const r = await api.play({ tvIds: groupTvs, listId: groupList });
                  if (r.failed.length) throw new Error(`Some TVs didn't start: ${r.failed.join(" ")}`);
                }, "Sent to the TVs.")
              }
            >
              Play on {groupTvs.length || "the chosen"} TV{groupTvs.length === 1 ? "" : "s"}
            </button>
          </div>
        </section>
      )}

      <div className="tv-grid">
        {state.tvs.map((tv) => (
          <TvCard key={tv.id} tv={tv} state={state} act={act} />
        ))}
      </div>

      <section className="card">
        <h2>Link a TV</h2>
        {adding ? (
          <LinkTvForm act={act} onDone={() => setAdding(false)} />
        ) : (
          <button onClick={() => setAdding(true)}>Link another TV</button>
        )}
        <p className="muted small">
          Works with the YouTube app on Roku, Google TV, Fire TV, Samsung, LG and most smart TVs. Not Apple TV. Videos play under the account signed in on the TV, so sign every TV in to the
          venue's YouTube Premium account once (no ads).
        </p>
      </section>
    </div>
  );
}
