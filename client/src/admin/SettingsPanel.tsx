import { useState } from "react";
import { api } from "../api";
import type { PanelProps } from "../pages/AdminPage";

export function SettingsPanel({ state, act }: PanelProps) {
  const s = state.settings;
  const [name, setName] = useState(s.name);
  const [cap, setCap] = useState(String(s.searchCap));
  const [hour, setHour] = useState(String(s.refreshHour));
  return (
    <form
      className="card stack-sm settings"
      onSubmit={(e) => {
        e.preventDefault();
        void act(() => api.saveSettings({ name, searchCap: Number(cap), refreshHour: Number(hour) }), "Saved.");
      }}
    >
      <h2>Settings</h2>
      <label>
        Name
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="YouTube" maxLength={60} />
        <span className="muted small">Standalone only; on a Bar Games box the box's name for the app is used.</span>
      </label>
      <label>
        Searches per day
        <input type="number" min={0} max={90} value={cap} onChange={(e) => setCap(e.target.value)} className="num" />
        <span className="muted small">Each search costs 100 of YouTube's 10,000 free daily units (reading a 200-video list costs about 8). 0 turns search off.</span>
      </label>
      <label>
        Nightly refresh at
        <select value={hour} onChange={(e) => setHour(e.target.value)}>
          {Array.from({ length: 24 }, (_, h) => (
            <option key={h} value={h}>
              {h}:00
            </option>
          ))}
        </select>
        <span className="muted small">
          {state.timezone} time. Last run: {state.lastNightlyRefresh ? new Date(state.lastNightlyRefresh).toLocaleString() : "not yet"}.
        </span>
      </label>
      <button className="primary">Save</button>
    </form>
  );
}
