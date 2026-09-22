# A browser in a Domo dev environment

Status: **investigation complete, recommendation reached, implementation not
started.** Everything below marked "measured" was run inside a real Domo dev
environment (`env_d58a98433e5344c682fe`, Ubuntu 24.04, arm64, DinD available) on
2026-09-22. The scripts beside this file are the actual probes; they work.

---

## Recommendation, in one paragraph

Ship Chromium in a **shared, read-only, content-addressed Docker volume** mounted
at `/opt/domo-browser`, exactly the way `/opt/domo` already ships Node and the two
ACP adapters — not as a devcontainer Feature, not as an install at container
start, not as a sidecar, not as a browser on the host. Drive it with
**`@playwright/mcp`**, attached as a built-in MCP server the way the `domo` mesh
server already is, resolved to a container-local path. Add **one line to the
Caddyfile** so a container can reach the Domo dev server over HTTP/2. And do
**not** build global `.domo.json` merging for this — the volume dissolves that
requirement entirely (see "The second half").

This was proven end to end: a clean `mcr.microsoft.com/devcontainers/base:ubuntu-24.04`
container with **zero apt packages installed**, mounting only `/opt/domo` and the
browser volume, drove the live Domo app over HTTPS through `@playwright/mcp` and
returned a 23,694-character accessibility snapshot plus
`evidence-mcp-screenshot.png` beside this file.

---

## Why the volume, and not the four options in the brief

| Option | Verdict |
| --- | --- |
| **Shared volume** (`/opt/domo-browser`) | **Recommended.** Built once per machine, ~337 MB total, ~58 s. No image change, no Feature, no `.domo.json`, no network at container start. Works for a project that has opted into nothing — which this repo is. |
| Devcontainer Feature baked into the image | Rejected. Adds ~500 MB to *every* project's image and build time to *every* environment creation, and only reaches projects whose `.domo.json` names it — so it needs the global-config machinery, which in turn has the drift problem below. |
| Install at container start | Rejected. ~15 s per start at best (measured, warm network), needs working apt + network + root in an image Domo does not control, and mutates the container so a `docker start` and a fresh create differ. |
| Sidecar container | Rejected. The browser cannot see the workspace volume, so traces, screenshots and file uploads land on the wrong side; needs its own lifecycle, its own network path and its own cleanup, and buys nothing the volume does not already give. |
| Browser on the host | Rejected. The host browser is the developer's own (profile, logins, windows), and an agent would need a new host-side control channel that is strictly more dangerous than the container it was supposed to stay inside. |

The volume also inherits a constraint the codebase already enforces and documents:
the image must be glibc-based. `preflight()` already fails Alpine/musl images
because the bundled Node cannot exec there, so the browser adds no new restriction.

---

## Measured facts

Numbers are arm64, warm network, Docker 29.8.1.

**The image has nothing.** `mcr.microsoft.com/devcontainers/base:ubuntu-24.04` —
the default image — has **no** `libnss3`, `libatk`, `libgbm`, `libasound`,
`libdrm`, `libxkbcommon`, `libcups` or `libpango`, and no browser. A browser
binary dropped into a volume on its own will not start.

**Cost of the apt route, for comparison.** The minimal headless dependency set is
**215 MB and 8 s**; Playwright's own `install-deps chromium` list is **94
packages** because it includes the entire Xvfb/X11 server stack, which headless
does not need. The Chromium headless shell itself is **266 MB, ~7 s** to
download. Playwright does publish `linux-arm64`.

**Cost of the volume route.** The built volume is **337 MB** and takes **~58 s**
to populate from `node:22-bookworm-slim`: 57 shared libraries, 16 fonts, the
headless shell, `playwright-core` and `@playwright/mcp`. Built once per machine,
shared by every environment, never written to.

**It works on the images that matter.** Smoke-tested (`smoke.mjs`) from a clean
container with only the two volumes mounted:

| base image | renders text | loads Domo over TLS |
| --- | --- | --- |
| `mcr.microsoft.com/devcontainers/base:ubuntu-24.04` | yes | `200 proto=h2` |
| `node:22-bookworm-slim` | yes | `200 proto=h2` |
| `debian:bookworm-slim` | yes | `200 proto=h2` |
| `debian:trixie-slim` | **see landmine 2** | — |

---

## Three landmines that cost real time. Do not re-learn these.

**1. No fontconfig means a blank screenshot, and nothing says so.** With the
library closure but no fonts and no `fonts.conf`, Chromium launches, navigates,
and answers every question about the DOM correctly — `--dump-dom` returned
`<h1>Hello Domo</h1>` — but the PNG is **entirely blank**. The only hint is a
single non-fatal `Fontconfig error: Cannot load default config file` on stderr,
among dozens of harmless dbus warnings. A verification tool that silently
screenshots nothing is worse than no verification tool. Fix: ship fonts in the
volume, write a `fonts.conf` pointing at them, set `FONTCONFIG_PATH`, and give it
a `<cachedir>` under `/tmp` because the volume is mounted read-only.

**2. `ldd` is not the dependency closure, twice over.**
 - NSS `dlopen`s its PKCS#11 modules (`libsoftokn3.so`, `libfreeblpriv3.so`,
   `libnssckbi.so`). `ldd` never names them. The browser starts fine and dies
   **fatally** the moment it fetches anything over TLS:
   `FATAL:crypto/nss_util.cc:146 nss_error=-5925`. Copy those from `dpkg -L libnss3`.
 - A one-level `ldd` pass misses transitive deps. The binary needs libgobject,
   which needs `libffi.so.8`; `debian:trixie-slim` happens to carry the first and
   not the second, so it failed with a bare `error while loading shared
   libraries: libffi.so.8`. Iterate `ldd` to a fixed point. (Deriving the set
   from an `apt-get --dry-run` "Inst" diff has the same hole from the other
   side: it silently omits anything the *helper* image already had.)
 - After the fixed-point fix, trixie was **not** re-tested. Do that.

**3. Take the libraries from the oldest glibc you intend to support.** The
volume is populated from `node:22-bookworm-slim` (glibc 2.36) on purpose, and
those libraries run on Ubuntu 24.04 (2.39). The reverse does not hold. This is
why the helper image pin is load-bearing and belongs in the volume's name hash,
exactly as `RUNTIME_IMAGE` already is for `/opt/domo`.

---

## Reaching the Domo dev server from a container

This is a separate problem from the browser and it is currently **broken**, in a
way that matters because it is the whole motivating use case.

**Measured, from inside a dev environment:**
 - `http://host.docker.internal:3667/` (Nuxt) → **200**. Reachable, because
   `scripts/dev.mjs` runs Nuxt with `--public`.
 - `https://host.docker.internal:3666/` (Caddy) → **fails**. But the TCP port
   *is* open — Caddy already binds the wildcard. The failure is purely a TLS
   handshake rejection: Caddy has no certificate for SNI `host.docker.internal`,
   so it sends a TLS internal-error alert (`tlsv1 alert internal error`).

So today the only Domo a container can reach is plain HTTP — the one address
AGENTS.md says never to open a browser at. **That warning is correct and is now
measured rather than asserted.** Four tabs on `http://…:3667`:

```
tab1 status=200 ms=3068  textlen=2953   <- renders
tab2 status=200 ms=21123 textlen=0      <- blank, 20s
tab3 status=200 ms=20067 textlen=0      <- blank
tab4 status=200 ms=19994 textlen=0      <- blank
```

The document returns 200 and the body never arrives; Electric's shape long-polls
hold the HTTP/1.1 per-origin connections. The same four tabs through an HTTP/2
front end: **all four render in ~3 s.**

**The fix is one line.** Add `host.docker.internal:3666` as a second site address
in the `Caddyfile`, so Caddy provisions an internal certificate for that name.
Verified by running Caddy 2.10.2 with exactly that config: it logs
`enabling automatic TLS certificate management domains=["host.docker.internal","localhost"]`,
serves a cert with `X509v3 SAN: DNS:host.docker.internal`, and answers
`code=200 ver=2`. Four browser tabs from a container through it: all four render.

**No CA trust plumbing is needed.** `ignoreHTTPSErrors` (Playwright) /
`--ignore-https-errors` (`@playwright/mcp`) handles the untrusted local CA, and
HTTP/2 still negotiates normally. Do not build root-CA injection into containers;
it was considered and is unnecessary.

Caveats not yet resolved:
 - Binding is unchanged (the port was already open on all interfaces), so this
   exposes nothing new at the socket level — but it does make the app answer to
   a new hostname. Worth a sentence of the reader's judgement.
 - Caddy opens a `:80` redirect vhost for named sites. It already does this for
   `localhost:3666`, so adding a name is not a regression, but it was not tested
   on the host.
 - Production (`pnpm build`, no Caddy) was not considered at all here.

---

## How the agent drives it

`@playwright/mcp` 0.0.82, 14 MB, 25 tools. It has exactly the three flags this
design needs: `--executable-path`, `--ignore-https-errors`, `--no-sandbox`, plus
`--headless`, `--isolated` and `--output-dir`.

Measured through a raw JSON-RPC stdio client (`mcp-client-probe.mjs`) from a
clean container: `tools/list` → 25 tools; `browser_navigate` → ok;
`browser_snapshot` → 23,694 characters of accessibility tree with clickable refs
(`- button "New coding agent" [ref=e17]`); `browser_take_screenshot` → a correct
PNG. One gotcha: the screenshot `filename` must be an absolute path inside an
allowed root, or it answers `File access denied: /x.png is outside allowed roots`.

**How it gets attached.** `mcpServersForSession` (`server/lib/acp/manager.ts:889`)
already merges a user-configurable `mcp_servers` table with one built-in server
(`domo`, the mesh). The browser server should be a **second built-in**, on the
same pattern, not a row — for the same reason the mesh is not a row: its command
path is container-local.

**A real asymmetry to handle.** `mcpServersForSession` passes a stdio `command`
through verbatim to an adapter that may be running on the host *or* inside a
container. `/opt/domo-browser/...` exists only in the container. This is the same
host/container split `internalBaseUrl(!!environment)` already solves for the mesh
URL, and it needs the same treatment — a container-only server, or a resolved
path per side. Note this also means **a user-configured stdio MCP server row is
already quietly broken for container sessions today** (its host command path does
not exist in there). Out of scope, but it is a real bug and nothing documents it.

---

## The second half: should there be a global Domo config?

**For the browser: no, and that is the strongest argument for the volume.**

If the browser were a Feature delivered through a global config, you must pick
one of two semantics, and both are bad:

 - **"Default for a project that says nothing"** — then every project that has a
   `.domo.json` at all (i.e. every project that customised *anything*) silently
   loses the browser. The failure is invisible and arrives long after the edit.
 - **"Merged into every project"** — then changing a global setting invalidates
   every project's image, but mounts and images are fixed at creation, so two
   environments of the same project built a week apart differ with nothing in the
   repo explaining why. That is precisely the silent drift AGENTS.md is written
   to prevent, and it breaks "a project *is* its checkout".

The volume avoids the choice: it is mounted, not baked, so it reaches every
environment regardless of what its `.domo.json` says — including one that has
none, which is the case for this repo.

**Global config as its own feature, if it is ever wanted:** it should mean
**"the default for a project that says nothing"**, nothing more. Note that
`defaultEnvironmentConfig()` in `server/lib/dev-env/config.ts` *is already*
exactly that, hard-coded — so the whole feature is "make that function's return
value editable in Settings". That is small, honest, and has a clear product
meaning: a project with a `.domo.json` is fully self-describing and reproducible
from its checkout; a project without one gets the install's house default.
It should be a separate change from the browser, and the browser must not
depend on it.

Note also that Domo **already has** a global, non-project config that contributes
to every coding agent: the `mcp_servers` table, with `scope: voice | coding | both`.
Whatever is built should sit beside that idea rather than invent a second one.

---

## Open questions for the reader

1. Does the Caddyfile change (`host.docker.internal:3666`) get made? It is the
   difference between "an agent can verify the UI" and "an agent can verify one
   tab of the UI and silently get blanks after that."
2. Is the browser on by default, or a setting? It costs 337 MB of disk once and
   nothing per environment, but it is 337 MB.
3. Does the volume get a `.ready` marker and GC like `/opt/domo`? (It should —
   same pattern, `collectRuntimeVolumes` filters on a `domo-dev-runtime-` name
   prefix and will not touch a differently-named browser volume.)
4. Should `browser_*` tools be gated per session, or per environment?

## Not verified from inside a container

 - Anything on the **host**: the real Caddyfile change was validated by running
   Caddy 2.10.2 *inside* this container against the same config shape, not by
   restarting the host's Caddy.
 - **amd64.** Everything here is arm64.
 - `debian:trixie-slim` after the fixed-point library fix.
 - Production mode (`pnpm build`), where there is no Caddy at all.
 - Whether the accessibility snapshot is actually a *good* way for an agent to
   judge a visual regression — the theme, the 390px composer wrap — as opposed
   to a screenshot a human still has to look at. I got correct screenshots out;
   I did not evaluate whether an agent reading them closes the verification gap
   this spike exists to close.
