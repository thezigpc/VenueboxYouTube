// HTTP helpers. The client is always served by the server (Vite proxies in dev).

import type { AdminState, GoogleStatus, ListSummary, PublicTv, SavedList, SearchHit, TvInfo, YtPlaylist } from "@ytapp/shared";

const TOKEN_KEY = "youtube.adminToken";

export function getToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? "";
  } catch {
    return "";
  }
}

export function setToken(token: string): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage blocked: signed in until reload */
  }
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: "no-store" });
  } catch {
    throw new ApiError("Can't reach the server. Check the connection and try again.", 0);
  }
  const json = (await res.json().catch(() => null)) as { error?: string } | null;
  if (!res.ok) throw new ApiError(json?.error ?? `The server answered ${res.status}.`, res.status);
  return json as T;
}

const v = <T>(p: Promise<{ value: T }>) => p.then((r) => r.value);

export interface AuthStatus {
  setupNeeded: boolean;
  configured: boolean;
  broken: boolean;
  authenticated: boolean;
  minPasswordLength: number;
  venueLogin?: boolean;
  setupAllowed?: boolean;
}

export const api = {
  now: () => request<{ tvs: PublicTv[] }>("GET", "/api/now"),
  status: () => request<AuthStatus>("GET", "/api/admin/status"),
  setup: (password: string) => request<{ token: string }>("POST", "/api/admin/setup", { password }),
  login: (password: string) => request<{ token: string }>("POST", "/api/admin/login", { password }),
  logout: () => request("POST", "/api/admin/logout", {}),
  state: () => request<AdminState>("GET", "/api/admin/state"),
  saveSettings: (patch: Record<string, unknown>) => request("PUT", "/api/admin/settings", patch),

  // Google
  googleConfig: (patch: Record<string, unknown>) => v(request<{ value: GoogleStatus }>("PUT", "/api/admin/google/config", patch)),
  googleSignIn: () => v(request<{ value: { userCode: string; verificationUrl: string } }>("POST", "/api/admin/google/signin", {})),
  googleCancel: () => request("POST", "/api/admin/google/cancel", {}),
  googleSignOut: () => request("POST", "/api/admin/google/signout", {}),
  googleCheck: () => v(request<{ value: GoogleStatus }>("POST", "/api/admin/google/check", {})),
  myPlaylists: () => v(request<{ value: YtPlaylist[] }>("GET", "/api/admin/youtube/playlists")),
  search: (q: string) => v(request<{ value: SearchHit[] }>("GET", `/api/admin/youtube/search?q=${encodeURIComponent(q)}`)),

  // Library
  list: (id: string) => v(request<{ value: SavedList }>("GET", `/api/admin/lists/${encodeURIComponent(id)}`)),
  createList: (body: Record<string, unknown>) => v(request<{ value: ListSummary }>("POST", "/api/admin/lists", body)),
  updateList: (id: string, patch: Record<string, unknown>) => v(request<{ value: SavedList }>("PATCH", `/api/admin/lists/${encodeURIComponent(id)}`, patch)),
  deleteList: (id: string) => request("DELETE", `/api/admin/lists/${encodeURIComponent(id)}`),
  refreshList: (id: string) => v(request<{ value: ListSummary }>("POST", `/api/admin/lists/${encodeURIComponent(id)}/refresh`, {})),
  copyList: (id: string) => v(request<{ value: ListSummary }>("POST", `/api/admin/lists/${encodeURIComponent(id)}/copy`, {})),
  addToList: (id: string, body: Record<string, unknown>) => request<{ value: SavedList; added: number }>("POST", `/api/admin/lists/${encodeURIComponent(id)}/add`, body),
  refreshAll: () => v(request<{ value: { refreshed: number; failed: number; stopped?: string } }>("POST", "/api/admin/refresh-all", {})),

  // TVs
  linkTv: (code: string, name: string) => v(request<{ value: TvInfo }>("POST", "/api/admin/tvs", { code, name })),
  renameTv: (id: string, name: string) => request("PATCH", `/api/admin/tvs/${encodeURIComponent(id)}`, { name }),
  unlinkTv: (id: string) => request("DELETE", `/api/admin/tvs/${encodeURIComponent(id)}`),
  relinkTv: (id: string, code: string) => request("POST", `/api/admin/tvs/${encodeURIComponent(id)}/relink`, { code }),
  control: (id: string, action: string, value?: number) => request("POST", `/api/admin/tvs/${encodeURIComponent(id)}/control`, { action, value }),
  addToTv: (id: string, link: string) => request("POST", `/api/admin/tvs/${encodeURIComponent(id)}/add`, { link }),
  play: (body: { tvIds: string[]; listId?: string; link?: string; startVideoId?: string }) => request<{ failed: string[] }>("POST", "/api/admin/play", body),
};
