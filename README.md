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
- `MDVIEW_ALLOW_LOGIN`: Tailscale login permitted to access shared files (required)
- `MDVIEW_ALLOW_DNSNAMES`: comma-separated Tailscale device DNS names permitted to access shared files (required)
- `MDVIEW_ACCESS_LOG`: access log path, default `/tmp/mdview.access.log`
- `MDVIEW_REG_DIR`: registry directory (required)
- `TAILSCALE_BIN`: path to the `tailscale` binary used for `whois` and host auto-detection

## Share a file (24h expiry by default)

```bash
node mdview.js share /absolute/path/to/file.md --ttl-hours 24
```

## Security

Three layers protect shared files:

1. **Secret URLs.** Share tokens are 256-bit random base64url strings. URLs are unguessable and expire after a configurable TTL (default 24 hours).
2. **Tailscale identity.** Every request must come from an authenticated Tailscale user whose login matches `MDVIEW_ALLOW_LOGIN` and whose device DNS name is in `MDVIEW_ALLOW_DNSNAMES`. Requests that fail either check get a 403. Identity is verified via `tailscale whois --json <clientIP>` (cached for 5 minutes). When the server sits behind Tailscale Serve, forwarded identity headers are trusted only from loopback.
3. **No path traversal.** The server only serves files that have been explicitly registered via `mdview share`. It does not accept file paths over HTTP.

Outputs a URL like:
`https://<your-device-hostname>/mdview/md/<TOKEN>`

## Revoke / prune

```bash
node mdview.js revoke <TOKEN>
node mdview.js prune
```

## Registry

`$MDVIEW_REG_DIR/registry.json`

- Stores `token -> {path, createdAtMs, expiresAtMs, size}`
- Tokens are random 256-bit base64url strings
- Viewer accepts tokens only; it does not accept file paths via HTTP
