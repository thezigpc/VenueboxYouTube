// /admin: staff sign in (box staff go straight in), then TVs, Lists, Google and Settings.

import { useCallback, useEffect, useState, type FormEvent } from "react";
import { staffSignIn, VenueAnnouncement } from "@bargames/gamekit/client";
import type { AdminState } from "@ytapp/shared";
import { api, ApiError, getToken, setToken, type AuthStatus } from "../api";
import { useVenue } from "../useVenue";
import { TvsPanel } from "../admin/TvsPanel";
import { ListsPanel } from "../admin/ListsPanel";
import { GooglePanel } from "../admin/GooglePanel";
import { SettingsPanel } from "../admin/SettingsPanel";

type Phase = { kind: "loading" } | { kind: "auth"; status: AuthStatus } | { kind: "ready" } | { kind: "offline"; message: string };
export type Tab = "tvs" | "lists" | "google" | "settings";
const TABS: { id: Tab; label: string }[] = [
  { id: "tvs", label: "TVs" },
  { id: "lists", label: "Lists" },
  { id: "google", label: "Google" },
  { id: "settings", label: "Settings" },
];

/** Runs an action, shows its error (or `ok`), reloads; false on failure. */
export type Act = (fn: () => Promise<unknown>, ok?: string) => Promise<boolean>;
export interface PanelProps {
  state: AdminState;
  act: Act;
  reload: () => Promise<void>;
  go: (tab: Tab) => void;
}

function AuthForm({ status, onDone }: { status: AuthStatus; onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [wantSetup, setWantSetup] = useState(false);
  // On a box the box's admin password signs in; a separate password only when setupAllowed.
  const setup = status.venueLogin ? wantSetup && status.setupAllowed : status.setupNeeded;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    if (setup && password !== confirm) return setError("The passwords don't match.");
    setBusy(true);
    try {
      const r = setup ? await api.setup(password) : await api.login(password);
      setToken(r.token);
      onDone();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409 && status.venueLogin) setError("That isn't the venue box's admin password.");
      else setError(err instanceof Error ? err.message : "That didn't work.");
    } finally {
      setBusy(false);
    }
  };

  if (status.broken && !status.venueLogin) {
    return (
      <div className="auth card">
        <h1>YouTube admin</h1>
        <p className="error">The admin password file on the server is damaged. Ask whoever runs the server to fix or delete admin.json in the data folder.</p>
      </div>
    );
  }
  return (
    <form className="auth card" onSubmit={submit}>
      <h1>YouTube admin</h1>
      <p className="muted">
        {setup
          ? status.venueLogin
            ? `Choose a separate password for this app (the box's admin password keeps working too). At least ${status.minPasswordLength} characters.`
            : `Choose the admin password. Whoever sets it first becomes the admin, so do this now. At least ${status.minPasswordLength} characters.`
          : status.venueLogin
            ? `Sign in with the venue box's admin password${status.configured ? " (or this app's own password)" : ""}.`
            : "Sign in to manage the TVs and lists."}
      </p>
      <label>
        Password
        <input type="password" autoComplete={setup ? "new-password" : "current-password"} value={password} onChange={(e) => setPassword(e.target.value)} autoFocus required />
      </label>
      {setup && (
        <label>
          Password again
          <input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required />
        </label>
      )}
      {error && <p className="error">{error}</p>}
      <button className="primary" disabled={busy || !password}>
        {setup ? "Set password" : "Sign in"}
      </button>
      {status.venueLogin && status.setupAllowed && (
        <button type="button" className="link" onClick={() => (setWantSetup((v) => !v), setError(""))}>
          {wantSetup ? "Sign in with the box's password instead" : "Set a separate password for this app"}
        </button>
      )}
    </form>
  );
}

const tabFromHash = (): Tab => {
  const h = location.hash.slice(1);
  return TABS.some((t) => t.id === h) ? (h as Tab) : "tvs";
};

export function AdminPage() {
  const venue = useVenue();
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [state, setState] = useState<AdminState | null>(null);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  const [tab, setTab] = useState<Tab>(tabFromHash);

  const go = useCallback((t: Tab) => {
    setTab(t);
    history.replaceState(null, "", `#${t}`);
  }, []);

  const check = useCallback(async () => {
    try {
      const status = await api.status();
      if (status.authenticated && getToken()) {
        setPhase({ kind: "ready" });
        setState(await api.state());
        return;
      }
      const staffToken = await staffSignIn("");
      if (staffToken) {
        setToken(staffToken);
        setPhase({ kind: "ready" });
        setState(await api.state());
        return;
      }
      setToken("");
      setPhase({ kind: "auth", status });
    } catch (err) {
      setPhase({ kind: "offline", message: err instanceof Error ? err.message : "Can't reach the server." });
    }
  }, []);

  useEffect(() => {
    document.title = "YouTube admin";
    void check();
  }, [check]);

  const reload = useCallback(async () => {
    try {
      setState(await api.state());
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return void check();
    }
  }, [check]);

  // Now Playing and a sign-in in progress change on their own: keep the page fresh.
  useEffect(() => {
    if (phase.kind !== "ready") return;
    const t = setInterval(() => {
      if (!document.hidden) void reload();
    }, 3000);
    return () => clearInterval(t);
  }, [phase.kind, reload]);

  const act: Act = useCallback(
    async (fn, ok) => {
      try {
        await fn();
        if (ok) setNotice({ text: ok, error: false });
        await reload();
        return true;
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          void check();
          return false;
        }
        setNotice({ text: err instanceof Error ? err.message : "That didn't work.", error: true });
        await reload();
        return false;
      }
    },
    [check, reload],
  );

  useEffect(() => {
    if (!notice || notice.error) return;
    const t = setTimeout(() => setNotice(null), 3500);
    return () => clearTimeout(t);
  }, [notice]);

  const signOut = async () => {
    await api.logout().catch(() => undefined);
    setToken("");
    void check();
  };

  const props = state ? { state, act, reload, go } : null;
  const googleBad = state && (state.google.state === "disconnected" || (state.google.problem && state.google.problem.kind !== "quota"));
  const tvBad = state?.tvs.some((t) => t.link === "relink");

  return (
    <div className="ad-page">
      <VenueAnnouncement ctx={venue} />
      {phase.kind === "loading" && <p className="muted center-page">Loading…</p>}
      {phase.kind === "offline" && (
        <div className="auth card">
          <h1>YouTube admin</h1>
          <p className="error">{phase.message}</p>
          <button onClick={() => void check()}>Try again</button>
        </div>
      )}
      {phase.kind === "auth" && <AuthForm status={phase.status} onDone={() => void check()} />}
      {phase.kind === "ready" && (
        <>
          <header className="ad-header">
            <h1>YouTube</h1>
            <nav className="tabs" role="tablist">
              {TABS.map((t) => (
                <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? "tab is-on" : "tab"} onClick={() => go(t.id)}>
                  {t.label}
                  {((t.id === "google" && googleBad) || (t.id === "tvs" && tvBad)) && <span className="dot" aria-label="needs attention" />}
                </button>
              ))}
            </nav>
            <div className="ad-header-links">
              <a href="/" target="_blank" rel="noreferrer">
                Guest page
              </a>
              <button className="link" onClick={() => void signOut()}>
                Sign out
              </button>
            </div>
          </header>
          {notice && (
            <div className={`notice${notice.error ? " is-error" : ""}`} role="status">
              <span>{notice.text}</span>
              <button className="link" onClick={() => setNotice(null)} aria-label="Dismiss">
                ×
              </button>
            </div>
          )}
          {state && state.attention.length > 0 && (
            <ul className="attention">
              {state.attention.map((a, i) => (
                <li key={i} className={a.level === "error" ? "is-error" : ""}>
                  <button className="link" onClick={() => go(a.actionPath.includes("google") ? "google" : "tvs")}>
                    {a.message}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {!props ? (
            <p className="muted center-page">Loading…</p>
          ) : (
            <main className="ad-main">
              {tab === "tvs" && <TvsPanel {...props} />}
              {tab === "lists" && <ListsPanel {...props} />}
              {tab === "google" && <GooglePanel {...props} />}
              {tab === "settings" && <SettingsPanel {...props} />}
            </main>
          )}
        </>
      )}
    </div>
  );
}
