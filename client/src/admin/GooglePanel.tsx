// Google: the setup wizard for the venue's own Google project (or Bar Games' sign-in),
// "Sign in with Google" by code (google.com/device on a phone), and connection health.

import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import type { GoogleStatus } from "@ytapp/shared";
import { api } from "../api";
import type { PanelProps } from "../pages/AdminPage";

const STEP_KEY = "youtube.wizardStep";
const readStep = () => {
  try {
    return Number(localStorage.getItem(STEP_KEY)) || 1;
  } catch {
    return 1;
  }
};

const ext = (href: string, text: string) => (
  <a href={href} target="_blank" rel="noreferrer">
    {text} ↗
  </a>
);

function Copy({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="link small"
      onClick={() => void navigator.clipboard?.writeText(text).then(() => (setDone(true), setTimeout(() => setDone(false), 1500)))}
    >
      {done ? "Copied" : "Copy"}
    </button>
  );
}

function SignInCode({ g, act }: { g: GoogleStatus } & Pick<PanelProps, "act">) {
  const p = g.pending!;
  const [left, setLeft] = useState(() => Math.max(0, p.expiresAt - Date.now()));
  useEffect(() => {
    const t = setInterval(() => setLeft(Math.max(0, p.expiresAt - Date.now())), 1000);
    return () => clearInterval(t);
  }, [p.expiresAt]);
  return (
    <div className="device-code">
      <p>
        On your phone or computer, go to <b>{ext(p.verificationUrl, p.verificationUrl.replace(/^https?:\/\/(www\.)?/, ""))}</b> and enter:
      </p>
      <p className="code">
        {p.userCode} <Copy text={p.userCode} />
      </p>
      <p className="muted small">
        Sign in with the <b>venue's</b> Google account (the one with YouTube Premium) and allow read-only access. If Google says "Google hasn't verified this app", choose Advanced → Continue
        (it's your own project). Waiting… {Math.floor(left / 60000)}:{String(Math.floor((left % 60000) / 1000)).padStart(2, "0")} left.
      </p>
      <button className="link" onClick={() => void act(() => api.googleCancel())}>
        Cancel
      </button>
    </div>
  );
}

function Step({ n, current, title, done, children, setStep }: { n: number; current: number; title: string; done: boolean; children: ReactNode; setStep: (n: number) => void }) {
  const open = n === current;
  return (
    <li className={`step${open ? " is-open" : ""}${done ? " is-done" : ""}`}>
      <button className="step-head" onClick={() => setStep(n)} aria-expanded={open}>
        <span className="step-n">{done ? "✓" : n}</span> {title}
      </button>
      {open && <div className="step-body">{children}</div>}
    </li>
  );
}

function Wizard({ g, act, highlight }: { g: GoogleStatus; highlight: number | null } & Pick<PanelProps, "act">) {
  const [step, setStepRaw] = useState(() => highlight ?? (g.clientId ? 6 : readStep()));
  const setStep = (n: number) => {
    setStepRaw(n);
    try {
      localStorage.setItem(STEP_KEY, String(n));
    } catch {
      /* fine */
    }
  };
  useEffect(() => {
    if (highlight) setStepRaw(highlight);
  }, [highlight]);
  const [clientId, setClientId] = useState(g.clientId);
  const [secret, setSecret] = useState("");
  const next = (n: number) => (
    <button className="primary" onClick={() => setStep(n + 1)}>
      Done, next
    </button>
  );
  const saveClient = async (e: FormEvent) => {
    e.preventDefault();
    // Saving checks the client at once: Google answers the sign-in request or refuses the client.
    const ok = await act(async () => {
      await api.googleConfig({ mode: "own", clientId, ...(secret ? { clientSecret: secret } : {}) });
      await api.googleSignIn();
    });
    if (ok) {
      setSecret("");
      setStep(6);
    }
  };
  const connected = g.state === "connected";

  return (
    <ol className="wizard">
      <Step n={1} current={step} setStep={setStep} done={step > 1 || connected} title="Create a Google Cloud project">
        <p>
          Sign in to Google Cloud with any Google account you control (the venue's is simplest), then {ext("https://console.cloud.google.com/projectcreate", "create a project")}. Name it after the
          venue, e.g. "Root Bar TV". It's free; no billing account is needed.
        </p>
        {next(1)}
      </Step>
      <Step n={2} current={step} setStep={setStep} done={(step > 2 || connected) && g.problem?.kind !== "api-disabled"} title="Turn on the YouTube Data API">
        <p>
          With the new project selected, open {ext("https://console.cloud.google.com/apis/library/youtube.googleapis.com", "YouTube Data API v3")} and press <b>Enable</b>.
        </p>
        {g.problem?.kind === "api-disabled" && <p className="error">Google says the API is off for this project. Enable it, then press Check below.</p>}
        {next(2)}
      </Step>
      <Step n={3} current={step} setStep={setStep} done={step > 3 || connected} title="Consent screen: External, then Publish">
        <ol className="small">
          <li>
            Open {ext("https://console.cloud.google.com/auth/branding", "Google Auth Platform → Branding")}, press Get started. App name: the venue's name. Support and contact email: yours.
          </li>
          <li>
            Audience: <b>External</b>.
          </li>
          <li>
            In {ext("https://console.cloud.google.com/auth/audience", "Audience")}, press <b>Publish app</b> (In production). Testing mode signs you out every 7 days.
          </li>
        </ol>
        <p className="muted small">No review is needed for a venue's own project: Google shows a one-time "unverified app" warning at sign-in instead.</p>
        {next(3)}
      </Step>
      <Step n={4} current={step} setStep={setStep} done={(step > 4 || connected) && g.problem?.kind !== "client-invalid"} title='Create an OAuth client: "TVs and Limited Input devices"'>
        <p>
          Open {ext("https://console.cloud.google.com/auth/clients/create", "Clients → Create client")}. Application type: <b>TVs and Limited Input devices</b>. Any name. Press Create; it shows a
          Client ID and a Client secret.
        </p>
        <p className="muted small">No redirect address is needed: you'll sign in with a code, so this works on any network.</p>
        {g.problem?.kind === "client-invalid" && <p className="error">Google doesn't accept the client that was pasted. Check it's this type, and copy the id and secret again.</p>}
        {next(4)}
      </Step>
      <Step n={5} current={step} setStep={setStep} done={!!g.clientId && g.hasClientSecret && g.problem?.kind !== "client-invalid"} title="Paste the client id and secret">
        <form className="stack-sm" onSubmit={saveClient}>
          <label>
            Client ID
            <input value={clientId} onChange={(e) => setClientId(e.target.value.trim())} placeholder="…apps.googleusercontent.com" required />
          </label>
          <label>
            Client secret {g.hasClientSecret && <span className="muted small">(saved; leave empty to keep it)</span>}
            <input type="password" value={secret} onChange={(e) => setSecret(e.target.value.trim())} autoComplete="off" required={!g.hasClientSecret} />
          </label>
          <button className="primary" disabled={!clientId}>
            Save and sign in
          </button>
        </form>
      </Step>
      <Step n={6} current={step} setStep={setStep} done={connected} title="Sign in with Google">
        {g.pending ? (
          <SignInCode g={g} act={act} />
        ) : connected ? (
          <p>
            Signed in as <b>{g.account || "the venue's account"}</b>.
          </p>
        ) : (
          <button className="primary" disabled={!g.clientId} onClick={() => void act(() => api.googleSignIn())}>
            Sign in with Google
          </button>
        )}
      </Step>
    </ol>
  );
}

export function GooglePanel({ state, act, go }: PanelProps) {
  const g = state.google;
  const [apiKey, setApiKey] = useState("");
  const highlight = g.problem && g.problem.kind !== "quota" && g.problem.kind !== "other" ? g.problem.wizardStep : null;
  const resets = new Date(g.quota.resetsAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

  return (
    <div className="stack">
      <section className="card stack-sm">
        <h2>Google connection</h2>
        {g.state === "connected" && (
          <p>
            <span className="status status-connected">Connected</span> as <b>{g.account || "the venue's account"}</b> (read-only). Lists refresh nightly.{" "}
            <button className="link" onClick={() => go("lists")}>
              Browse playlists
            </button>
          </p>
        )}
        {g.state === "disconnected" && (
          <div className="stack-sm">
            <p className="error">
              <b>Google disconnected.</b> The sign-in stopped working (password changed, access removed, or unused for months). Lists can't refresh until you reconnect; TVs keep playing.
            </p>
            <button className="primary" onClick={() => void act(() => api.googleSignIn())}>
              Reconnect
            </button>
          </div>
        )}
        {g.pending && g.mode === "fallback" && <SignInCode g={g} act={act} />}
        {g.problem?.kind === "quota" && (
          <p className="error">
            YouTube's daily limit is used up ({g.quota.usedToday.toLocaleString()} units today). It resets at midnight Pacific ({resets} your time). Playback isn't affected.
          </p>
        )}
        {g.problem?.kind === "other" && <p className="error">{g.problem.message}</p>}
        <p className="muted small">
          Today: {g.quota.usedToday.toLocaleString()} of {g.quota.dailyLimit.toLocaleString()} units · {g.quota.searchesToday} of {g.quota.searchCap} searches · resets at {resets}
          {g.lastCheckedAt && ` · checked ${new Date(g.lastCheckedAt).toLocaleString()}`}
        </p>
        <div className="row wrap">
          {(g.state === "connected" || g.state === "disconnected") && (
            <>
              <button onClick={() => void act(() => api.googleCheck(), "Checked.")}>Check now</button>
              <button className="link danger" onClick={() => confirm("Sign out of Google? Saved lists stay; they just stop refreshing.") && void act(() => api.googleSignOut(), "Signed out.")}>
                Sign out
              </button>
            </>
          )}
        </div>
        <p className="muted small">
          This sign-in only reads the account's playlists (private ones too). Videos play under the account signed in on each TV. Watch Later can't be read by apps: use a normal playlist.
        </p>
      </section>

      {g.fallbackAvailable && (
        <section className="card stack-sm">
          <h2>Whose Google project?</h2>
          <label className="check">
            <input type="radio" checked={g.mode === "own"} onChange={() => void act(() => api.googleConfig({ mode: "own" }))} /> Use our own Google project (set up below, about 10 minutes)
          </label>
          <label className="check">
            <input type="radio" checked={g.mode === "fallback"} onChange={() => void act(() => api.googleConfig({ mode: "fallback" }))} /> Use Bar Games' sign-in (nothing to set up)
          </label>
          {g.mode === "fallback" && !g.pending && g.state !== "connected" && (
            <button className="primary" onClick={() => void act(() => api.googleSignIn())}>
              Sign in with Google
            </button>
          )}
        </section>
      )}

      {g.mode === "own" && (
        <section className="card">
          <h2>Set up the venue's Google project</h2>
          <Wizard g={g} act={act} highlight={highlight} />
        </section>
      )}

      <section className="card stack-sm">
        <h2>API key (optional)</h2>
        <p className="muted small">
          Only for reading public playlists without any Google sign-in. Create one under {ext("https://console.cloud.google.com/apis/credentials", "Credentials → Create credentials → API key")}{" "}
          and restrict it to the YouTube Data API.
        </p>
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            void act(() => api.googleConfig({ apiKey }), apiKey ? "API key saved." : "API key removed.").then(() => setApiKey(""));
          }}
        >
          <input type="password" placeholder={g.hasApiKey ? "Saved (enter a new one to replace)" : "API key"} value={apiKey} onChange={(e) => setApiKey(e.target.value.trim())} autoComplete="off" />
          <button>{apiKey || !g.hasApiKey ? "Save" : "Remove"}</button>
        </form>
      </section>
    </div>
  );
}
