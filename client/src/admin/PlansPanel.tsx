// Plans: saved "these lists on these TVs" setups ("Saturday morning cartoons"), started
// with one press. TVs left out of a plan are left alone.

import { useState } from "react";
import type { Plan, PlanItem } from "@ytapp/shared";
import { api } from "../api";
import type { PanelProps } from "../pages/AdminPage";

type Draft = { id: string | null; name: string; items: Record<string, { listId: string; loop: boolean | null }> };

function toDraft(p: Plan | null): Draft {
  const items: Draft["items"] = {};
  for (const it of p?.items ?? []) items[it.tvId] = { listId: it.listId, loop: it.loop ?? null };
  return { id: p?.id ?? null, name: p?.name ?? "", items };
}

function PlanEditor({ draft, setDraft, state, act, onDone }: Pick<PanelProps, "state" | "act"> & { draft: Draft; setDraft: (d: Draft) => void; onDone: () => void }) {
  const setItem = (tvId: string, patch: Partial<{ listId: string; loop: boolean | null }>) => {
    const cur = draft.items[tvId] ?? { listId: "", loop: null };
    setDraft({ ...draft, items: { ...draft.items, [tvId]: { ...cur, ...patch } } });
  };
  const save = () => {
    const items: PlanItem[] = Object.entries(draft.items)
      .filter(([, v]) => v.listId)
      .map(([tvId, v]) => ({ tvId, listId: v.listId, ...(v.loop === null ? {} : { loop: v.loop }) }));
    void act(() => (draft.id ? api.updatePlan(draft.id, { name: draft.name, items }) : api.createPlan({ name: draft.name, items })), "Plan saved.").then((ok) => ok && onDone());
  };
  return (
    <section className="card stack-sm">
      <h2>{draft.id ? "Edit plan" : "New plan"}</h2>
      <label>
        Name
        <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Saturday morning cartoons" maxLength={60} autoFocus />
      </label>
      <table className="plan-table">
        <thead>
          <tr>
            <th>TV</th>
            <th>Plays</th>
            <th>Loop</th>
          </tr>
        </thead>
        <tbody>
          {state.tvs.map((tv) => {
            const it = draft.items[tv.id] ?? { listId: "", loop: null };
            const list = state.lists.find((l) => l.id === it.listId);
            return (
              <tr key={tv.id}>
                <td>{tv.name}</td>
                <td>
                  <select value={it.listId} onChange={(e) => setItem(tv.id, { listId: e.target.value, loop: null })} aria-label={`List for ${tv.name}`}>
                    <option value="">Leave alone</option>
                    {state.lists.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  {list && <input type="checkbox" aria-label="Loop" checked={it.loop ?? list.loop} onChange={(e) => setItem(tv.id, { loop: e.target.checked })} />}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="row">
        <button className="primary" disabled={!draft.name.trim() || !Object.values(draft.items).some((v) => v.listId)} onClick={save}>
          Save plan
        </button>
        <button className="link" onClick={onDone}>
          Cancel
        </button>
      </div>
    </section>
  );
}

export function PlansPanel({ state, act, go }: PanelProps) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const tvName = (id: string) => state.tvs.find((t) => t.id === id)?.name ?? "?";
  const listName = (id: string) => state.lists.find((l) => l.id === id)?.name ?? "?";

  if (draft) return <PlanEditor draft={draft} setDraft={setDraft} state={state} act={act} onDone={() => setDraft(null)} />;

  return (
    <div className="stack">
      <section className="card stack-sm">
        <h2>Plans</h2>
        <p className="muted small">
          A plan is a set of lists on TVs, started with one press: "Saturday morning cartoons" plays Cartoons on the bar TVs and Chill on the patio. TVs left out of a plan keep doing what they're
          doing. Starting a plan takes its TVs back from local control.
        </p>
        <div className="row wrap">
          <button className="primary" disabled={!state.tvs.length || !state.lists.length} onClick={() => setDraft(toDraft(null))}>
            New plan
          </button>
          <button
            disabled={!state.tvs.some((t) => t.queue?.listId && !t.local)}
            onClick={() => {
              const name = prompt("Name for this plan", "What's on now");
              if (name) void act(() => api.createPlan({ name, fromTvs: true }), "Saved as a plan.");
            }}
          >
            Save what's on now as a plan
          </button>
        </div>
        {(!state.tvs.length || !state.lists.length) && (
          <p className="muted small">
            First link a TV and add a list (
            <button className="link" onClick={() => go(state.tvs.length ? "lists" : "tvs")}>
              {state.tvs.length ? "Lists" : "TVs"}
            </button>
            ).
          </p>
        )}
      </section>

      {state.plans.map((p) => (
        <section key={p.id} className="card stack-sm">
          <header className="row between wrap">
            <h2>{p.name}</h2>
            <div className="row">
              <button
                className="primary"
                onClick={() =>
                  void act(async () => {
                    const r = await api.startPlan(p.id);
                    if (r.failed.length) throw new Error(`Started ${r.started + r.pending}. ${r.failed.join(" ")}`);
                  }, `"${p.name}" started.`)
                }
              >
                Start
              </button>
              <button onClick={() => setDraft(toDraft(p))}>Edit</button>
              <button className="link danger" onClick={() => confirm(`Delete the plan "${p.name}"?`) && void act(() => api.deletePlan(p.id), "Deleted.")}>
                Delete
              </button>
            </div>
          </header>
          <ul className="plan-items small">
            {p.items.map((it) => (
              <li key={it.tvId}>
                <b>{tvName(it.tvId)}</b>: {listName(it.listId)}
                {it.loop === true && " (loop)"}
                {it.loop === false && " (once)"}
              </li>
            ))}
            {p.items.length === 0 && <li className="muted">Its TVs or lists were removed: edit it.</li>}
          </ul>
          {p.lastStartedAt && <p className="muted small">Last started {new Date(p.lastStartedAt).toLocaleString()}</p>}
        </section>
      ))}
    </div>
  );
}
