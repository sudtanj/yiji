# yiji-relay

Browsers cannot open raw TCP sockets, so the yiji database drivers talk to your databases through this relay. It accepts a WebSocket, checks a token and a target allowlist, then copies bytes between the WebSocket and a TCP connection. The protocol is in [docs/design.md](../docs/design.md#relay-protocol-v1).

The relay speaks plain `ws://`. Put TLS in front of it (see below).

## Run

```sh
YIJI_TOKEN=$(head -c 32 /dev/urandom | base64 | tr -d '=+/' | head -c 40) \
YIJI_ALLOW=db.lan:5432,10.0.0.5:27017 \
YIJI_ORIGINS=https://sudtanj.github.io \
cargo run --release
```

| Variable | Meaning |
|----------|---------|
| `YIJI_TOKEN` | Shared secret, at least 32 characters. The relay exits at startup if it is shorter. |
| `YIJI_ALLOW` | Comma-separated `host:port` targets, matched exactly. The relay exits at startup if it is empty. |
| `YIJI_LISTEN` | Listen address. Defaults to `127.0.0.1:8080`. |
| `YIJI_ORIGINS` | Comma-separated allowed `Origin` values. If unset, any origin is accepted. |
| `YIJI_MAX_CONN` | Maximum simultaneous connections. Defaults to 64. |
| `YIJI_IDLE_SECS` | Close a connection after this many seconds without data in either direction. Defaults to 1800. |

Save the token somewhere safe: you enter the same value in the yiji connection form.

The relay resolves allowlisted hostnames through the DNS of the machine it runs on, so you are trusting that DNS to return the right addresses.

The relay logs one line per connection open and close to stderr: peer address and target, never the token or payload. Refused connections log the reason.

## Behind Cloudflare Tunnel

Keep `YIJI_LISTEN` on `127.0.0.1:8080` and point a tunnel at it:

```sh
cloudflared tunnel --url http://127.0.0.1:8080
```

For a stable hostname, create a named tunnel with an ingress rule to `http://127.0.0.1:8080`. Use `wss://<your-hostname>/` as the relay URL in yiji.

## Behind Tailscale

Run the relay on a machine in your tailnet, set `YIJI_LISTEN` to its tailnet IP (or `0.0.0.0`), and use `ws://<machine>.<tailnet>.ts.net:8080/` from a device on the same tailnet. Browsers on an HTTPS page block `ws://`, so for a hosted yiji use Tailscale Serve to add TLS:

```sh
tailscale serve --bg 8080
```

Then use `wss://<machine>.<tailnet>.ts.net/`. Bind `YIJI_LISTEN` to `127.0.0.1:8080` in that case.

## Build

```sh
cargo build --release
```

CI cross-builds `aarch64-unknown-linux-gnu` (Orange Pi Zero 3) and uploads the binary as an artifact of the `relay` workflow.
