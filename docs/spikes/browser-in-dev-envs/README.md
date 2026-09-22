# A browser in a Domo dev environment

Status: **recommendation reached and built.** The browser half is implemented on
this branch; the global-config half is a recommendation *not* to build something,
with the reasoning set out below.

Everything marked measured was run inside a real Domo dev environment
(Ubuntu 24.04, arm64, Docker 29.8.1, DinD available) on 2026-09-22. The probes
beside this file are the real ones.

---

## Recommendation

Ship Chromium in a **shared, read-only, content-addressed Docker volume** mounted
at `/opt/domo-browser`, the same way `/opt/domo` already ships Node and the ACP
adapters. Drive it with **`@playwright/mcp`**, attached as a built-in MCP server
the way the `domo` mesh server already is. Add **one site address to the
Caddyfile** so a container can reach Domo over HTTP/2. And **do not build global
`.domo.json` merging** — the volume removes the requirement that motivated it.

Proven end to end through the shipped code path: a clean
`mcr.microsoft.com/devcontainers/base:ubuntu-24.04` container with **zero apt
packages installed**, mounting only `/opt/domo` and the browser volume, drove the
live Domo app over HTTPS through the real `browserMcpServer()` config and returned
a **31,361-character accessibility snapshot** (75 headings and buttons with
clickable refs) plus a **90 KB PNG inline in the tool result**.

---

## Why a volume, and not the four options in the brief

| Option | Verdict |
| --- | --- |
| **Shared volume** (`/opt/domo-browser`) | **Recommended and built.** 337 MB, built once per machine in ~26 s. No image change, no Feature, no `.domo.json`, no network at container start. Reaches a project that has opted into nothing — which this repo is. |
| Devcontainer Feature in the image | Rejected. ~500 MB onto *every* project's image and build time onto *every* environment creation, and it only reaches projects whose `.domo.json` names it — so it needs global config, which has the drift problem below. |
| Install at container start | Rejected. Needs working apt, network and root in an image Domo does not own, and makes a `docker start` differ from a fresh create. |
| Sidecar container | Rejected. It cannot see the workspace volume, so uploads and traces land on the wrong side, and it needs its own lifecycle, network path and cleanup for no gain. |
| Browser on the host | Rejected. The host browser is the developer's own, and driving it needs a host-side control channel strictly more dangerous than the container it was meant to stay inside. |

---

## The three things that will bite whoever touches this

**1. Never ship glibc in the volume.** This is the one that cost the most and is
least obvious. The volume's `lib` directory goes on `LD_LIBRARY_PATH`, which is
searched ahead of the system paths **for every library the process loads** — not
just the browser's. A library closure computed naively includes `libc.so.6`, and
shipping the builder's copy means an Ubuntu 24.04 image resolves *its own* newer
`libstdc++` against bookworm's glibc:

```
/opt/domo/node/bin/node: /opt/domo-browser/lib/libc.so.6: version `GLIBC_2.38'
  not found (required by /lib/aarch64-linux-gnu/libstdc++.so.6)
```

That kills Node before the browser is launched. `IMAGE_OWNED_LIBRARIES` in
`browser-volume.ts` excludes glibc, the loader, `libstdc++` and `libgcc_s`, which
must all come from the image. A hand-built volume that takes its libraries from
the *same* image it is tested on hides this completely — mine did, and would have
shipped broken for every image but one.

**2. No fontconfig means a blank screenshot, and almost nothing says so.** With
the libraries but no fonts and no `fonts.conf`, Chromium launches, navigates, and
answers every question about the DOM correctly — `--dump-dom` returned
`<h1>Hello Domo</h1>` — and the PNG comes back **entirely blank**. The only hint
is one non-fatal `Fontconfig error: Cannot load default config file` among dozens
of harmless dbus warnings. A verification tool that silently screenshots nothing
is worse than none, so the volume build now renders text and **refuses to write
`.ready` if the PNG has no ink in it**.

**3. `ldd` is not the dependency closure, twice over.**
 - NSS `dlopen`s its PKCS#11 modules (`libsoftokn3.so`, `libfreeblpriv3.so`,
   `libnssckbi.so`). `ldd` never names them. The browser starts fine and dies
   **fatally** the first time it fetches anything over TLS:
   `FATAL:crypto/nss_util.cc:146 nss_error=-5925`. Topped up from `dpkg -L libnss3`.
 - One `ldd` pass misses transitive deps: the binary needs libgobject, which needs
   `libffi.so.8`, and `debian:trixie-slim` carries the first and not the second —
   a bare `error while loading shared libraries: libffi.so.8`. The walk now runs
   to a fixed point. (Deriving the set from an `apt-get --dry-run` "Inst" diff has
   the same hole from the other side: it silently omits whatever the *builder*
   image already had.)

---

## Measured

**The image has nothing.** `mcr.microsoft.com/devcontainers/base:ubuntu-24.04` —
the default — has no `libnss3`, `libatk`, `libgbm`, `libasound`, `libdrm`,
`libxkbcommon`, `libcups` or `libpango`, and no browser.

**Cost.** The volume is **337 MB** (269 MB browser, 45 MB JS, 21 MB libraries,
2 MB fonts) and builds in **~26 s** through the real `ensureBrowserVolume()`.
Built once per machine, shared by every environment, never written to. For
comparison, the apt route costs **215 MB and 8 s per image** for the minimal
headless set; Playwright's own `install-deps chromium` list is **94 packages**
because it carries the entire Xvfb and X server stack, which headless never uses.

**Where it runs.** Smoke-tested from a clean container with only the two volumes
mounted and the browser env set:

| base image | glibc | result |
| --- | --- | --- |
| `mcr.microsoft.com/devcontainers/base:ubuntu-24.04` | 2.39 | renders |
| `ubuntu:24.04` | 2.39 | renders |
| `debian:trixie-slim` | 2.41 | renders |
| `debian:bookworm-slim` | 2.36 | renders |
| `node:22-bookworm-slim` | 2.36 | renders |
| `fedora:41` | 2.40 | renders |
| `ubuntu:22.04` | 2.35 | **fails** — `GLIBC_2.36' not found` |

Non-Debian images work, which matters: nothing about this is Debian-specific at
*use* time, only at build time.

**The floor is real and it is new.** The volume's libraries come from
`RUNTIME_IMAGE` (bookworm, glibc 2.36), so anything older fails. That is a
**stricter floor than Domo already has**: the bundled Node runs fine on
`ubuntu:22.04` (measured, `v22.23.2`), so such an image passes `preflight()` today
and would get a working environment with a broken browser. This is the sharpest
open question in the change — see below.

---

## Reaching Domo from inside a container

Separately broken, and it is the motivating use case.

**Measured from inside a dev environment, before the fix:**
 - `http://host.docker.internal:3667/` (Nuxt) → **200**, because `scripts/dev.mjs`
   runs Nuxt with `--public`.
 - `https://host.docker.internal:3666/` (Caddy) → fails. But the TCP port **is
   open** — Caddy already binds the wildcard. The failure is purely a TLS
   handshake rejection: no certificate for that SNI, so Caddy sends
   `tlsv1 alert internal error`.

So the only reachable Domo was the one address AGENTS.md says never to open a
browser at — and **that warning is correct, now measured rather than asserted.**
Four tabs on `http://…:3667`:

```
tab1 status=200 ms=3068  textlen=2953   <- renders
tab2 status=200 ms=21123 textlen=0      <- 200, then a blank body
tab3 status=200 ms=20067 textlen=0
tab4 status=200 ms=19994 textlen=0
```

The document returns 200 and the body never arrives; Electric's shape long-polls
hold HTTP/1.1's six connections per origin. The same four tabs through an HTTP/2
front end: **all four render in ~3 s.**

**The fix is one site address.** `host.docker.internal:{$DOMO_HTTPS_PORT}` beside
the existing one, so Caddy provisions an internal certificate for that name.
Verified against the repo's real `Caddyfile` with Caddy 2.10.2: `Valid
configuration`, `domains":["localhost","host.docker.internal"]`, and both names
answer `code=200 ver=2`. `scripts/dev.mjs` exports `DOMO_HTTPS_PORT` from whatever
`DOMO_HTTPS_ADDRESS` was overridden to, so the two site addresses cannot drift
onto different ports.

**No CA trust plumbing is needed, and none should be added.**
`--ignore-https-errors` handles the untrusted local CA and HTTP/2 still
negotiates. Binding is unchanged — the port was already open on every interface —
so this exposes no new socket, only a new name.

---

## How the agent drives it

**Verified against real adapters.** `pnpm test:agents` drives this end to end:
both Claude Code and Codex are handed the server, call `browser_navigate` and
`browser_snapshot` on it, and report back the heading of a page the test serves
itself. The assertion that matters is a recorded HTTP hit on that page —
nothing else in the test process can produce one, so it means a real Chromium
inside the container really fetched something.

`@playwright/mcp` 0.0.82, 25 tools. It has exactly the flags this design needs:
`--executable-path`, `--ignore-https-errors`, `--no-sandbox`, `--headless`,
`--isolated`, `--output-dir`.

**The screenshot comes back inline.** Called with **no `filename`**,
`browser_take_screenshot` returns MCP `image` content —
`image/png`, 119,940 base64 characters — so the agent *sees* the page in its tool
result. No file path, no ACP filesystem callback, no question about whether a
binary read survives `cat`. Given a `filename` it writes a file instead and
answers with a link, and the path must be inside `--output-dir` or it refuses with
`File access denied: … is outside allowed roots`. **The inline form is the one
that closes the verification gap**, and it is the reason this feature works at all.

**How it is attached.** `mcpServersForSession` already merges the user's
`mcp_servers` rows with one built-in (`domo`). The browser is a **second
built-in**, container-only, for the same reason the mesh is not a row: every path
in it names a mounted volume that exists nowhere on the host.

**A latent bug found on the way.** `mcpServersForSession` passes a stdio row's
`command` through verbatim to an adapter that may be on the host *or* in a
container. A user-configured stdio MCP server is therefore **already quietly
broken for container sessions** — its host path does not exist in there. Out of
scope here, but real and undocumented.

---

## The second half: should there be a global Domo config?

**For the browser: no — and that is the strongest argument for the volume.**

If the browser were a Feature delivered by global config, you must pick one of two
semantics and both are bad:

 - **"The default for a project that says nothing"** — then every project that has
   a `.domo.json` at all (i.e. every project that customised *anything*) silently
   loses the browser, long after the edit that caused it.
 - **"Merged into every project"** — then changing a global setting invalidates
   every project's image, but images and mounts are fixed at creation, so two
   environments of the same project built a week apart differ with nothing in the
   repo explaining why. That is exactly the silent drift AGENTS.md exists to
   prevent, and it breaks "a project *is* its checkout".

A mounted volume avoids the choice entirely: it reaches every environment
regardless of what its `.domo.json` says, including the common case of none.

**Re-read against what just landed, and it holds.** `shared/agent-adapters.ts` and
the per-adapter settings pages make the codebase's existing split explicit, and
there are now three examples of it:

| kind | examples | where it lives |
| --- | --- | --- |
| what *differs*, described once | `AGENT_ADAPTERS`, `ADAPTER_PACKAGES`, now `BROWSER_PACKAGES` | a literal table in code |
| what the *user* chooses | `defaultAgentModes`, `homeMounts`, now `browserTools` | a `settings` row |

The browser's contents are the first kind and its on/off is the second, which is
why this change adds a pinned table and exactly one boolean. A user-editable
structured config that merges into image builds would be a **third** mechanism,
unlike either, and the only one of the three that can silently change what a build
produces. That is an argument against it, not for it.

**If it is ever wanted anyway**, it should mean *"the default for a project that
says nothing"* and nothing more — and note that
`defaultEnvironmentConfig()` in `server/lib/dev-env/config.ts` **already is
exactly that**, hard-coded. The whole feature is "make that function's return
value editable", it now has an obvious home at `/settings/environments`, and it
should stay a separate change. The browser must not depend on it.

Worth knowing: Domo *already* has a global, non-project config contributing to
every coding agent — the `mcp_servers` table, with `scope: voice | coding | both`.
Anything built here should extend that idea rather than invent a second one.

---

## Decisions for the reader

1. **The glibc floor.** The browser needs glibc ≥ 2.36; the bundled Node does not.
   An `ubuntu:22.04`-based project passes `preflight()` today and would get a
   working environment whose browser fails only when an agent first uses it.
   Options: leave it (the failure is visible and attributable), add a preflight
   probe that drops the MCP server for that environment, or build the libraries
   from an older image than `RUNTIME_IMAGE` at the cost of a second pin. **Left
   as-is deliberately; this is the reader's call.**
2. **`browserTools` defaults to `true`.** That costs one 337 MB volume and ~26 s on
   the next environment created, once per machine. Turn it off if that is wrong.
3. **The Caddyfile change** makes Domo answer to a second hostname. Nothing new is
   bound, but it is a deliberate widening.

## Not verified from inside a container

 - **Anything on the host.** The Caddyfile was validated and run *inside* this
   container against the real file; the host's own Caddy was never restarted. In
   particular Caddy opens a `:80` HTTP→HTTPS redirect vhost for named sites — it
   already does for `localhost:3666`, so this is not a regression, but it was not
   observed on a host.
 - **amd64.** Everything here is arm64. The volume name hashes the architecture,
   so an amd64 machine builds its own, but no amd64 build has been run.
 - **OpenCode.** The live suite's `describe.each` runs `codex` and `claude-code`
   only, so the third adapter is exercised by nothing — which predates this
   change and is not specific to the browser.
 - **Whether it actually closes the verification gap.** I got correct screenshots
   and a rich accessibility tree out. I did not evaluate whether an agent reading
   them can judge the things AGENTS.md keeps deferring — whether a green reads as
   organic or as swamp, whether four pickers fit at 390px. Those may still need a
   human. The tool removes the excuse, not necessarily the need.
 - **`pnpm build` in production**, where there is no Caddy at all and the
   container-facing URL question is unanswered.
