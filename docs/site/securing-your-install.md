# Securing your install

Good news: Domo has **built-in accounts**, and sensible defaults.

- The first visit creates the **admin**. Everyone who signs up afterward is **pending** until the admin approves them, so you choose who gets in.
- Sign-in is required for everything — the whole backend is protected, not just the screens.
- By default the app listens on **localhost only** (`127.0.0.1:7575`), so on your own machine it's safe with no extra setup. The helper containers aren't exposed either.

Keep in mind that anyone you approve can run a coding agent with real access to that machine and its projects — so approve people you'd trust with that, and use a strong admin password. The steps below are about safely reaching Domo from *other* devices.

## Using Domo remotely

The simplest, safest approach: leave the default localhost binding and put a secure layer in front of it.

- **[Tailscale](https://tailscale.com/)** — `tailscale serve https / http://127.0.0.1:7575`. Reachable only from your own devices.
- **[Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)** — point `cloudflared` at `http://127.0.0.1:7575`, optionally behind Cloudflare Access.
- **Your own reverse proxy** (Caddy, nginx, Traefik) terminating HTTPS in front of `127.0.0.1:7575`.

All of these talk to localhost, so you don't change anything in Domo.

## Listening on another interface (advanced)

If you really need Domo itself to listen elsewhere (say, a private network you fully control), set `DOMO_BIND` before starting:

```bash
DOMO_BIND=0.0.0.0 domo up      # all interfaces
DOMO_BIND=10.0.0.5 domo up     # one specific interface
```

Only do this on a network you trust, and still keep HTTPS in front. Please don't put Domo directly on the public internet or port-forward it from a router — keep a tunnel or proxy in between.

## Quick checklist

- [ ] Strong admin password; only people you trust are approved.
- [ ] Reached via localhost, a tunnel, or an HTTPS proxy — not a public port.
- [ ] `DOMO_BIND` left unset (or only a trusted private interface).
- [ ] `~/.domo` has sensible file permissions — it holds your data.
