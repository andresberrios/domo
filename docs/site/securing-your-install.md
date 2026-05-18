# Securing your install

Domo has **built-in email + password authentication**. The first visit creates the **admin** account; anyone who signs up afterward is **pending** until the admin approves them, and the entire backend — every API procedure, the SSE/WS streams, and the durable session-stream proxy — is gated server-side (an unauthenticated or unapproved request is rejected, not merely hidden in the UI). No email is ever sent; approval is a button in the admin's **Users** screen.

That said, an approved user gets a full Claude Code agent with **host file, git, terminal, and `claude` control** over your machine and projects — so still treat an account on this instance as equivalent to a shell on the host. A strong admin password is the gate; the network hardening below is defence in depth, not optional, and is **not** a reason to expose `:7575` to the public internet.

## Default: localhost only

`domo up` binds the app to **`127.0.0.1:7575`** — reachable only from the machine it runs on. The infra is locked down too:

- **Postgres** is not published to the host at all (only the compose network reaches it).
- **agents-server** ports (`4437`/`4438`) are bound to `127.0.0.1` only.

On a single trusted machine, the default is safe with no extra steps.

## Remote access (the right way)

To use Domo from other devices, do **not** widen the bind — instead put a secure layer in front of the localhost listener:

- **[Tailscale](https://tailscale.com/)** — `tailscale serve https / http://127.0.0.1:7575`, reachable only inside your tailnet.
- **[Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)** — `cloudflared tunnel` to `http://127.0.0.1:7575`, ideally behind Cloudflare Access.
- **Your own reverse proxy** (Caddy/nginx/Traefik) terminating TLS and enforcing authentication (Basic auth, OAuth proxy, mTLS) before proxying to `127.0.0.1:7575`.

All of these connect to localhost, so the default bind needs no change.

## Widening the bind (advanced, opt-in)

If you must have Domo listen on another interface (e.g. a private VLAN you fully control), set `DOMO_BIND` before `domo up`:

```bash
DOMO_BIND=0.0.0.0 domo up      # all interfaces
DOMO_BIND=10.0.0.5 domo up     # one specific interface
```

Only do this on a network you trust end to end. **Never** bind to a public interface, and never port-forward `:7575` from a router to the host: the built-in login raises the bar, but a public agent with full host control is too valuable a target to expose on a single password — keep a tunnel or authenticating proxy in front.

## Checklist

- [ ] App reachable only via localhost, a tunnel, or an authenticating proxy.
- [ ] `DOMO_BIND` unset (or set to a trusted private interface only).
- [ ] No router/firewall port-forward exposing `:7575` to the internet.
- [ ] TLS + authentication enforced on any remote entry point.
- [ ] `$DOMO_HOME` (default `~/.domo`) has appropriate filesystem permissions — it holds your state DB and Postgres/streams data.
