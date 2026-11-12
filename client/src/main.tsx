import React from "react";
import ReactDOM from "react-dom/client";
import { basePath, ErrorBoundary } from "@bargames/gamekit/client";
import { NowPage } from "./pages/NowPage";
import { AdminPage } from "./pages/AdminPage";
import "./index.css";

// Two pages (bargames.json routes: player "/", admin "/admin"). No TV page: the TVs play
// in their own YouTube apps.
// Under path routing the page is at /youtube/admin: drop the prefix first.
const prefix = basePath();
const here = prefix && location.pathname.startsWith(prefix) ? location.pathname.slice(prefix.length) : location.pathname;
const path = here.replace(/\/+$/, "") || "/";
const Page = path === "/admin" ? AdminPage : NowPage;

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ErrorBoundary
      fallback={(_error, reload) => (
        <div className="center-page">
          <h1>Something broke</h1>
          <p className="muted">Reloading usually fixes it.</p>
          <button className="primary" onClick={reload}>
            Reload
          </button>
        </div>
      )}
    >
      <Page />
    </ErrorBoundary>
  </React.StrictMode>,
);
