# solidcraft-triage

A Rust→WASM triage table for any GitHub repo's issues. Paste a `owner/repo`
(and optionally a token), and it loads every issue into a WASM engine that
answers instant filter/sort/facet queries: label chips (`needs-triage`,
`triaged`, `duplicate`, `verified`, …), open/closed, close outcome
(completed vs closed-as-duplicate/not-planned), text search, sortable columns.

No server, no build step to run it — the WASM does all parsing, filtering,
sorting, and facet counting client-side.

## Use

Serve `web/` over HTTP (browsers require http:// for `instantiateStreaming`):

```sh
cd web && python3 -m http.server 8777
# open http://localhost:8777
```

- **No token**: REST path, works on public repos, capped at the newest ~1000
  items (GitHub caps page pagination at 10 pages for large repos).
- **With token**: GraphQL cursor path — full history, no cap. Token is kept
  in `localStorage` only and only ever sent to `api.github.com`.
- Repo can also be set via hash: `http://localhost:8777/#/owner/repo`.

## Build

```sh
rustup target add wasm32-unknown-unknown
cargo build --release --target wasm32-unknown-unknown
cp target/wasm32-unknown-unknown/release/triage.wasm web/triage.wasm
```

## Test

```sh
gh api "repos/tangency-labs/solidcraft/issues?state=all&per_page=100&page=1" > test/page1.json
node test/harness.js test/page1.json
```

## Architecture

- `src/lib.rs` — the engine. Raw C ABI (no wasm-bindgen): JS passes JSON in
  via `alloc` + `triage_load`/`triage_query`; results return as a buffer
  whose first 4 bytes are a u32 length followed by UTF-8 JSON.
- `web/app.js` — GitHub fetching (REST or GraphQL), wasm glue, DOM rendering.
- `web/index.html` — styling + layout.
