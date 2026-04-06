# mdview

Share local markdown files as rendered HTML pages via short-lived, secret URLs. Designed to run on a [Tailscale](https://tailscale.com/) node and exposed via Tailscale Serve.

## Server

- Runs as a launchd agent: `com.openclaw.mdview`
- Binds locally: `127.0.0.1:4323`
- Exposed to tailnet via Tailscale Serve at:
  - `https://<your-device-hostname>/mdview`

Health check:
- `http://127.0.0.1:4323/health`

## Configuration

Copy `.env.example` values into your launchd environment or shell as needed:

- `MDVIEW_HOST`: public hostname used in generated share URLs. If unset, `mdview` tries to auto-detect the Tailscale DNS name via `tailscale status --json`.
- `MDVIEW_BASEPATH`: public path prefix, default `/mdview`
- `MDVIEW_BIND`: local bind address for the server, default `127.0.0.1`
- `MDVIEW_ALLOW_LOGIN`: exact Tailscale login to allow
- `MDVIEW_ALLOW_DNSNAMES`: comma-separated allowed Tailscale DNS names
- `MDVIEW_ACCESS_LOG`: access log path, default `/tmp/mdview.access.log`
- `MDVIEW_REG_DIR`: registry directory, default `${HOME}/.openclaw/mdview`
- `TAILSCALE_BIN`: path to the `tailscale` binary used for `whois` and host auto-detection

## Share a file (24h expiry by default)

```bash
node mdview.js share /absolute/path/to/file.md --ttl-hours 24
```

## Identity binding

By default, all requests must come from an authenticated Tailscale user. Unauthenticated requests are rejected with 403.

To restrict access further:
- `MDVIEW_ALLOW_LOGIN` — only allow a specific Tailscale login (exact match from `tailscale whois`). Set to `*` to allow any authenticated tailnet user (the default behaviour).
- `MDVIEW_ALLOW_DNSNAMES` — only allow specific Tailscale device DNS names (comma-separated, including trailing dot)

Identity is verified via `tailscale whois --json <clientIP>` (cached for 5 minutes). Tailscale Serve forwarded headers are trusted only when the request arrives from a loopback address.

Outputs a URL like:
`https://<your-device-hostname>/mdview/md/<TOKEN>`

## Revoke / prune

```bash
node mdview.js revoke <TOKEN>
node mdview.js prune
```

## Registry

`${MDVIEW_REG_DIR:-$HOME/.openclaw/mdview}/registry.json`

- Stores `token -> {path, createdAtMs, expiresAtMs, size}`
- Tokens are random 256-bit base64url strings
- Viewer accepts tokens only; it does not accept file paths via HTTP
