# Yiji

A database client that runs in your browser, on desktop or phone. Its layout follows DBeaver (navigator tree, SQL editor, results grid), so DBeaver users can find their way around.

Status: early development. Nothing is released yet.

## What it connects to

- PostgreSQL and MongoDB, through a small relay you run yourself.
- SQLite: local files in the browser, or remote libSQL / Turso databases over HTTPS.

Browsers cannot open TCP connections, so PostgreSQL and MongoDB traffic goes through `yiji-relay`. The relay passes bytes between a WebSocket and the database. It does not read queries or results, and it runs fine on a single-board computer. The database protocols themselves run in the browser, in Rust compiled to WebAssembly.

The hosted app only connects to `https://` and `wss://` addresses, so put the relay behind TLS (Cloudflare Tunnel, Tailscale or a reverse proxy).

Saved connections are encrypted in the browser with your password, then stored in your Turso database through the relay. Run the relay with `YIJI_TURSO_URL` and `YIJI_TURSO_TOKEN` set, then enter the relay URL and its `YIJI_TOKEN` in the app on first launch. They are kept on that device until you use File > Log out.

## Layout

| Path | What |
|------|------|
| `web/` | The PWA (TypeScript, Preact, Vite) |
| `wasm/` | PostgreSQL and MongoDB drivers, Rust compiled to WebAssembly |
| `relay/` | `yiji-relay`, WebSocket to TCP relay (Rust) |
| `docs/design.md` | Architecture, relay protocol, driver API |

## Name

Yi Ji (伊籍) was a Shu Han official in the Three Kingdoms period who served as an envoy to Wu.

## License

MIT. Yiji is not affiliated with DBeaver.
