# 0008 — Google OAuth: GIS token model + direct fetch (no gapi.client)

## Status

Accepted (v1)

## Context

The v1 Web prototype needs to sync its portfolio JSON to Google Drive (`ADR 0002`: `drive.file` scope). The constraint is **no backend server, no client secret** — which forecloses the authorization code flow (PKCE) and pushes us to a pure client-side option.

The ticket is which OAuth library to use. The candidates:

- **Google Identity Services (GIS)** — Google's recommended replacement for `gapi.auth2`; OAuth 2.0 token model (implicit) or code model (PKCE).
- **gapi client** — Older library; still works but deprecated auth path.
- **Hand-rolled OAuth + REST** — Minimal dependencies, but reimplements popup UX, CSRF state, error handling.

## Decision

**Use GIS token model (implicit flow) to get an access token, then drive the Drive REST API v3 directly with `fetch` + `Bearer` header. Do NOT load `gapi.client`.**

### Minimal dependencies

```html
<script src="https://accounts.google.com/gsi/client" async defer></script>
```

### Minimal JS pattern

```js
let tokenClient, accessToken;

function gisLoaded() {
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: '<YOUR_CLIENT_ID>',
    scope: 'https://www.googleapis.com/auth/drive.file',
    callback: (r) => { accessToken = r.access_token; },
  });
}

// User-gesture trigger (token model requires user gesture)
async function sync() {
  if (!accessToken) await new Promise(res => {
    tokenClient.callback = (r) => { accessToken = r.access_token; res(); };
    tokenClient.requestAccessToken();
  });
  const r = await fetch(
    'https://www.googleapis.com/drive/v3/files?q=name+%3D+%27property_tracker_portfolio_v1.json%27+and+trashed%3Dfalse',
    { headers: { Authorization: `Bearer ${accessToken}` } });
  return r.json();
}
```

### Why this combination

1. **`gapi.auth2` is deprecated.** Google's own migration guide: _"[The gapi.auth2 module] is deprecated. … replace this deprecated module, and its objects and methods with the Google Identity Services library."_ Google even provides a `G_AUTH2_MIGRATION=enforced` cookie for testing without it.
2. **`gapi.client` is optional convenience, not auth.** The migration guide: _"You can safely continue using the `gapi.client` module …"_. It bundles discovery doc, batching, CORS management — we don't need any of those for two endpoints.
3. **PKCE / code flow requires a backend.** Google's code model docs: exchanges happen on a backend platform. Foreclosed by the "no backend server" constraint.
4. **GIS token model is the official client-side pattern.** Google's `use-token-model` guide: _"facilitates prompting for user consent and obtaining access tokens using the OAuth 2.0 implicit grant flow."_
5. **The Drive quickstart is already on this pattern.** Google's current Drive JS quickstart uses `google.accounts.oauth2.initTokenClient` + `tokenClient.requestAccessToken({prompt: 'consent'})`. It loads `gapi.client` only for file listing + metadata — we don't need that.
6. **Google itself recommends against hand-rolling.** Migration guide: _"use the Google Identity Services library to support a less intrusive popup UX mode and to avoid having to manage complex OAuth 2.0 requests and responses."_

### Why no `gapi.client`

We need exactly two endpoints:

- **Read**: `GET https://www.googleapis.com/drive/v3/files/{fileId}?alt=media`
- **Write**: `PATCH https://www.googleapis.com/upload/drive/v3/files/{fileId}?uploadType=media` (simple upload: <5 MB, no metadata — our portfolio JSON is <50 KB)
- **Find**: `GET /drive/v3/files?q=name='xxx' and trashed=false` (search guide)

Three fetches. No discovery doc, no batching, no CORS layer needed. Loading `gapi.client` would cost ~70 KB and one discovery-doc round-trip for nothing.

### Token lifecycle

- Access token is short-lived (~1 hour). Implicit flow issues **no refresh token**.
- On expiry → call `requestAccessToken()` again. Each sync call is a user gesture (open page / save), so the gesture requirement is naturally satisfied.
- On 401 response → re-request token, then retry.
- On page reload, the in-memory token is gone but Google's authorization record persists per browser profile. `requestAccessToken({prompt: ''})` re-acquires silently when consent was previously granted; first-time users still see consent (no prior auth → Google falls back to UI). User gesture (a click) is still required — that's an OAuth hard constraint. The header button is the entry point (see issue #09).

## Consequences

### Positive

- Single `<script>` tag, ~30 KB loaded
- No `gapi.client` discovery-doc round-trip on first sync
- Three `fetch` calls — readable, debuggable, no library lock-in
- Google's official pattern (Drive quickstart uses this base)

### Negative

- **No refresh token** — every ~1 hour the user must re-acquire a token. The header button is the user-gesture entry point (one click); with `prompt: ''`, returning users skip the consent screen. Acceptable for personal use.
- **Token in memory only** — page reload requires a click to re-acquire, but consent is skipped (see issue #09). No data loss: Drive is the source of truth, and local portfolio is in localStorage.
- **No PKCE upgrade path on Web** — if we ever want a refresh token on Web, we'd need a backend. Defer.

### Trade-offs accepted

- **Single-token usage**, no scope-incremental auth (we only need `drive.file`).
- **In-memory token + silent re-acquire** — page reload requires a user-gesture click but skips consent (via `prompt: ''`). localStorage holds the `client_id` only, not the token.

## Rejected options

- **`gapi.auth2`** — Deprecated. Officially.
- **`gapi.client` for auth** — Auth2 deprecated; `gapi.client` doesn't do auth itself.
- **`gapi.client` for API convenience** — Overkill; three fetches suffice.
- **Hand-rolled OAuth + REST** — Violates Google's own recommendation; reintroduces popup UX / CSRF state / error handling bugs.
- **PKCE / authorization code flow** — Requires backend exchange. Out of scope.

## Deferred / future

- **Refresh tokens** — Web uses implicit token model; access token expires ~hourly and the user re-acquires on next sync (1 click, silent re-consent if previously authorized). Long-running sessions would need refresh tokens (PKCE / authorization code flow), but that's not needed for personal use.
- **OAuth App Verification** — Personal use, single user, no verification needed. Cosmetic for now.
- **Multiple scopes / incremental authorization** — Only `drive.file` needed; irrelevant today.

## References

- [Use the token model — Google Identity Services](https://developers.google.com/identity/oauth2/web/guides/use-token-model)
- [Use Code Model — Google Identity Services](https://developers.google.com/identity/oauth2/web/guides/use-code-model)
- [Migrate to Google Identity Services](https://developers.google.com/identity/oauth2/web/guides/migration-to-gis)
- [JavaScript quickstart — Google Drive API](https://developers.google.com/drive/api/quickstart/js)
- [Choose Google Drive API scopes](https://developers.google.com/drive/api/guides/api-specific-auth)
- [Upload file data — Google Drive API](https://developers.google.com/drive/api/guides/manage-uploads)
- [Search for files and folders — Google Drive API](https://developers.google.com/drive/api/guides/search-files)
- [Method: files.get — Drive API v3 reference](https://developers.google.com/workspace/drive/api/reference/rest/v3/files/get)
- [Using OAuth 2.0 to Access Google APIs](https://developers.google.com/identity/protocols/oauth2)
