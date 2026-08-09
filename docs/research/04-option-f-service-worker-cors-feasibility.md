# Research 04: Option F (Service Worker CORS bypass) feasibility

**Question**: Can a Service Worker alone (without a server-side proxy) bypass the browser's CORS check so that `lib/yahoo.js` can fetch `query1.finance.yahoo.com` from the browser?

**Verdict**: **NO — Option F is not viable as a standalone solution.** A SW can short-circuit the *page-side* CORS check (the synthetic Response it returns is exempt from the CORS check in HTTP fetch), but the SW's *own outgoing* `fetch()` to Yahoo is a regular HTTP fetch and IS subject to the same CORS check. Yahoo sends no CORS headers, so the SW's internal fetch fails. The only way to actually get Yahoo's response body is a server-side fetch (i.e., Option A1 or another proxy). See [Hybrid F+A](#hybrid-option-fa-sw--server-side-proxy) for the only real way to use SW in this design.

## Primary sources

| Source | What it tells us |
|---|---|
| [Fetch spec §4.4 HTTP fetch][fetch-44] | When a SW returns a Response, the SW response path returns BEFORE the CORS check (the check only runs in the HTTP-network-or-cache-fetch branch, which is only reached if `response is null`). |
| [Fetch spec §4.10 CORS check][fetch-410] | The exact CORS-check algorithm: `Access-Control-Allow-Origin` required, `*` disallowed with credentials, etc. |
| [Fetch spec §4.1 main fetch step 16][fetch-41] | After the SW returns, main fetch wraps the non-filtered response as a "CORS filtered response" (header exposure filter, NOT a pass/fail check). |
| [Fetch spec §5.6 fetch() on SW context][fetch-56] | When SW calls `fetch(input, init)`, only `service-workers mode` is set to `"none"` to prevent recursion. The request's `mode`, `credentials`, etc. are inherited — so the SW's fetch is a normal HTTP fetch with normal CORS rules. |
| [W3C SW spec §4.6.7 `respondWith()`][sw-respondwith] | "Renderer-side security checks about tainting for cross-origin content are tied to the types of filtered responses defined in Fetch" — confirms SW-returned Responses bypass the page-side CORS rejection. |
| [MDN FetchEvent.respondWith()][mdn-respondwith] | Type restrictions on what Responses can be returned (opaque only for no-cors requests, etc.). |

[fetch-44]: https://fetch.spec.whatwg.org/#http-fetch
[fetch-410]: https://fetch.spec.whatwg.org/#cors-check
[fetch-41]: https://fetch.spec.whatwg.org/#main-fetch
[fetch-56]: https://fetch.spec.whatwg.org/#fetch-method
[sw-respondwith]: https://www.w3.org/TR/service-workers/#fetch-event-respondwith
[mdn-respondwith]: https://developer.mozilla.org/en-US/docs/Web/API/FetchEvent/respondWith

---

## Detailed analysis

### Claim 1: SW-returned Responses bypass the page-side CORS check ✅ TRUE

The browser's normal flow for a `fetch()` from the page is:

```
page-side fetch() → main fetch → http fetch → HTTP-network-or-cache fetch → CORS check
```

When a SW intercepts and returns a Response, the SW response path returns **before** the CORS check:

> **Fetch spec §4.4 HTTP fetch** ([whatwg/fetch §4.4][fetch-44]):
>
> 1. If `request.service-workers mode is "all"`:
>    - Invoke `handle fetch` (W3C SW spec). Get `fetchResponse`.
>    - **If `fetchResponse` is a response**: set `response = fetchResponse`, run type validations, **return response**.
>    - Otherwise fall through to step 2.
> 2. If `response is null`:
>    - Run CORS-preflight (if needed).
>    - Run `HTTP-network-or-cache fetch`.
>    - **CORS check**: `if request's response tainting is "cors" and a CORS check for request and response returns failure, then return a network error`.

The comment immediately after the CORS check makes the exemption explicit:

> "As the CORS check is not to be applied to responses whose status is 304 or 407, or responses from a service worker for that matter, it is applied here."

So a SW-returned Response of any status (with or without `Access-Control-Allow-Origin`) passes through to the page without being rejected by the CORS check.

In `main fetch step 16` ([whatwg/fetch §4.1][fetch-41]), the response is then wrapped as a "CORS filtered response" — but this is a *header exposure* filter, not a pass/fail check:

> **Fetch spec §4.1 main fetch step 16:**
>
> If `response is not a network error and response is not a filtered response, then:
>
> If `request's response tainting is "cors"`, then:
>
> - Extract header names from `Access-Control-Expose-Headers`
> - Set `response's CORS-exposed header-name list` accordingly
>
> Set `response` to the following filtered response with `response` as its internal response, depending on `request's response tainting`:
>
> - `"cors"` → CORS filtered response (body accessible, headers filtered)

**Practical implication**: The page-side `fetch()` resolves successfully, and `await response.json()` works. No `Access-Control-Allow-Origin` header is required on the synthetic Response. The only header restriction is which response headers the page can read (limited to CORS-safelisted + those in `Access-Control-Expose-Headers`).

### Claim 2: SW-initiated `fetch()` is subject to CORS check ❌ THIS BLOCKS OPTION F

When the SW calls `fetch(input, init)` to actually retrieve Yahoo's data, the call goes through the normal Fetch algorithm. There is no CORS bypass:

> **Fetch spec §5.6 `fetch(input, init)` on a `ServiceWorkerGlobalScope`** ([whatwg/fetch §5.6][fetch-56]):
>
> If `globalObject is a ServiceWorkerGlobalScope object, then set request's service-workers mode to "none"`.

Only `service-workers mode` is overridden (to prevent infinite recursion). The request's `mode` is inherited from the input — default `"cors"` for cross-origin URLs. The request's `credentials` is inherited — typically `"include"` for `lib/yahoo.js`.

So the SW's `fetch()` is processed via `main fetch → http fetch`. Since `service-workers mode is "none"`, step 1 of http fetch (SW intercept) is skipped. The request falls through to `HTTP-network-or-cache fetch`, where **the CORS check IS applied**.

Since Yahoo sends no `Access-Control-Allow-Origin` header, the CORS check fails, and the SW's fetch rejects with a `TypeError`. The SW cannot read Yahoo's response.

### Claim 3: Mode `no-cors` from SW doesn't help ❌

A SW could call `fetch(url, { mode: 'no-cors' })`, but this returns an *opaque filtered response*:

> **Fetch spec §2.2.6 filtered responses** ([whatwg/fetch §2.2.6][fetch-spec-226]):
>
> An opaque filtered response is a filtered response whose:
> - `type is "opaque"`,
> - `URL list is « »`,
> - `status is 0`,
> - `status message is the empty byte sequence`,
> - `header list is « »`,
> - `body is null`.

Status 0, headers empty, body null. JavaScript cannot read the body of an opaque response. So `mode: 'no-cors'` is not a workaround.

[fetch-spec-226]: https://fetch.spec.whatwg.org/#filtered-response

### Claim 4: Other SW-initiated request modes also fail ❌

| SW fetch options | Result |
|---|---|
| `fetch(url)` (default mode = 'cors') | CORS check fails (no ACAO from Yahoo). |
| `fetch(url, { mode: 'no-cors' })` | Opaque response — body unreadable. |
| `fetch(url, { mode: 'same-origin' })` | Only same-origin URLs allowed; Yahoo is cross-origin → fails before fetch. |
| `fetch(url, { mode: 'navigate' })` | Not allowed in fetch() API (navigation only). |
| `fetch(url, { credentials: 'omit' })` | Still needs CORS check; Yahoo still has no ACAO. |

No combination of SW fetch options bypasses CORS for a Yahoo request.

---

## Hybrid Option F+A: SW + server-side proxy

If the user still wants SW involved, the **only** way is to combine it with a server-side proxy:

```
Browser → SW intercepts → SW fetches proxy URL → Cloudflare Worker → Yahoo → ... → SW constructs Response → page reads body
```

In this hybrid:
- The SW's internal `fetch()` goes to a Cloudflare Worker URL (Option A1's proxy), not directly to Yahoo.
- The Cloudflare Worker fetches Yahoo server-to-server (no CORS).
- The SW receives the Worker's response (which has ACAO headers).
- The SW returns this response (or a synthetic one) to the page.

**But this is just Option A1 with extra steps.** The SW adds nothing except a different place for the proxy URL to live. Compared to A1 alone:
- ✅ Tiny upside: hides the proxy URL from `lib/yahoo.js` (could go through a single SW abstraction)
- ❌ Significant downside: SW lifecycle complexity (registration, activation, updates), first-load race, Safari quirks, extra repo file, requires HTTPS for non-localhost deployment

For a single-user personal app, this is worse than A1 alone.

---

## Recommendation

**Reject Option F. Choose Option A1 (Cloudflare Worker).**

Reasons:
1. Option F does not bypass CORS for the SW's outgoing fetch — the blocker is fundamental, not solvable.
2. The page-side CORS bypass works, but it's irrelevant if you can't get Yahoo's data in the first place.
3. Hybrid F+A is a strict superset of A1 with more failure modes and no benefit.
4. A1 is 5-10 minutes of one-time setup, zero ongoing, and well-trodden ground (Cloudflare Worker CORS proxies are a widely-used pattern).

For Option A1 implementation:
- `lib/yahoo.js` accepts a proxy URL via `root.PORTFOLIO_CONFIG.yahooProxyUrl`
- Yahoo endpoints are URL-rewritten: `${proxy}/${originalUrl}` or `${proxy}?url=${encodeURIComponent(originalUrl)}`
- Cookie + crumb auth happens on the Worker side (cleaner — Worker manages its own Yahoo session, no browser cookie forwarding needed)
- User deploys a ~10-line Worker via `wrangler deploy` or Cloudflare dashboard paste
- All 112 existing tests pass unchanged (mock fetch)

---

## Findings feed back into ticket #13

The CORS-proxy decision (#13) can now be resolved:

- **Option F → REJECT** (this research proves it doesn't work standalone)
- **Option A1 → RECOMMENDED** (the only viable standalone approach)
- **Option B (public proxy) → fallback if user refuses Cloudflare setup**
- **Option C (extension) → fallback if both A1 and B rejected**
- **Option D → reject as before**
- **Option E → reject as before**

## References

- [Fetch Standard §4.1 Main fetch](https://fetch.spec.whatwg.org/#main-fetch) — step 16 (CORS filtered response wrapping)
- [Fetch Standard §4.4 HTTP fetch](https://fetch.spec.whatwg.org/#http-fetch) — line 5417 (CORS check exemption for SW responses)
- [Fetch Standard §4.10 CORS check](https://fetch.spec.whatwg.org/#cors-check) — the exact pass/fail algorithm
- [Fetch Standard §2.2.6 Filtered responses](https://fetch.spec.whatwg.org/#filtered-response) — opaque / CORS / basic response types
- [Fetch Standard §5.6 fetch(input, init)](https://fetch.spec.whatwg.org/#fetch-method) — `service-workers mode = "none"` for SW-initiated fetches
- [W3C Service Workers §4.6.7 `event.respondWith(r)`](https://www.w3.org/TR/service-workers/#fetch-event-respondwith) — note on filtered response types
- [MDN: FetchEvent.respondWith()](https://developer.mozilla.org/en-US/docs/Web/API/FetchEvent/respondWith) — type restrictions on returnable Responses
- [MDN: Cross-Origin Resource Sharing (CORS)](https://developer.mozilla.org/en-US/docs/Web/HTTP/CORS) — high-level overview