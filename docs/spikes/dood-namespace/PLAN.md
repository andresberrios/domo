# Plan: each environment sees the host daemon as its own Docker host

Settled with the user on 2026-09-25. This is the working plan for the next
stretch of `worktree-dood-shared-daemon`; delete it (or fold what survives into
`AGENTS.md`) when the work lands. The image-tag question is being settled by
the spike in `README.md` beside this file — **done: viable**, and built, see
"Done: images".

## Where things stand (committed)

- `server/lib/dood/`: per-environment unix socket onto the host daemon, a byte
  splice framing both directions. Translates container create (workspace
  binds → workspace volume + subpath, host publishing dropped and written on a
  `domo.ports` label, networks joined by the environment), labels
  network/volume create with `domo.env=<id>`, detaches the environment from a
  network on delete (compose down; hidden from inspect). Sweep by label on retire; stop
  stops the stack.
- `docker: true` = docker-outside-of-docker Feature's CLI only + the proxy
  socket via `-v` at `/var/run/docker.sock`. Existing environments keep DinD.
- Ports panel: one global port helper (`<prefix>port-helper`, `--pid=host`,
  `SYS_ADMIN` + `SYS_PTRACE`) `nsenter -n`s services by PID; scanner +
  userland forwarder to the Mac. Rows keyed by `service`.

## Done: decisions 1–3 (scoping, names, response rewriting)

Landed on this branch (`feat(dood): give each environment its own names…`).
What a later phase needs to know:

- **The extension API is a stack of layers** (`server/lib/dood/layers.ts`),
  outermost first, passed to `startDoodProxy({ layers })`; `manager.ts` builds
  the stack (today: `[scopeLayer(…)]`). A layer is
  `{ wantsBody?(request), handle(request, next) }`:
  - `wantsBody` is asked first, because a body has to be buffered before the
    first layer runs. Only for JSON bodies you read or rewrite — never a build
    context or an archive.
  - `handle` may await pre-work, rewrite `request` (method, `path` without the
    version prefix, `query`, `headers`, `body`), call `next(request)`, or
    `answer(status, body)` itself (use `domoError('…')` for the loud refusal).
  - `withResponse(outcome, { json, line, after })` registers a response
    transform: `json` for a finite 2xx JSON body (buffered), `line` for an
    NDJSON stream (events, rewritten while it streams), `after(status)` once the
    response is delivered — the hook for reconciling relays after
    `start`/`stop`/`kill`/`rm`/`restart`. Transforms compose inner-first.
  - A layer placed **inside** the scope layer sees references already resolved
    to real ids / host names, and names already prefixed; one placed outside
    sees the agent's own names. Publishing, binds and `network_mode: host`
    should go inside.
  - Every JSON error has the prefix stripped (`rewriteError`), whatever layer
    produced the request.
- **Ports seam.** The client's original `PortBindings`/`PublishAllPorts` are
  on the `domo.publishing` label (JSON), the dropped ports on `domo.ports`
  (unchanged, the scanner reads it), the original `Binds`/`Mounts` on
  `domo.binds`. Inspect and `docker ps` report publishing through
  `reportedPorts()` / `reportedPortList()` in `responses.ts`: a binding that
  named a host port is shown as asked, one that did not as `null` (exposed,
  unpublished). The localhost-publishing phase records the allocation and
  reports it there.
- **Unresolved references are sent prefixed** (`replacementFor`), so the
  daemon answers "No such container: env_x-foo" / "network … not found" /
  "get …: no such volume" and the prefix is stripped on the way out — Docker's
  own wording for every object type, for free.
- **The environment's own container is hidden from `network inspect`/`ls`
  endpoints** instead of leaving the network on inspect: compose then sends
  the DELETE, and the environment leaves on the DELETE. `network prune`
  disconnects it first from networks it is the only endpoint of.
- **`docker builder prune` is buildx → BuildKit gRPC (`Control/Prune`)**, not
  `POST /build/prune` (measured: `docker builder prune --help` is `docker
  buildx prune` with buildx 0.37). Only the HTTP one is refused now; the
  `/grpc` bridge (decision 4) must refuse `Control/Prune` too.
- **Anonymous volumes carry no label** (the daemon makes them), so they are
  invisible to the environment's `volume ls`/`prune`; they go with their
  container (`--rm`, `rm -v`, the sweep's `rm --volumes`).
- Not translated yet, left to the images phase: `POST /build?networkmode=<net>`
  and the image-side of `commit` (`repo=`). Exec ids (`/exec/{id}`) are not
  scoped — they are unguessable and per-container.
- Objects an environment made **before** this change (unprefixed, labelled)
  keep working: an unprefixed name resolves as itself.
- Tests: `test/unit/dood-{http,names,responses,scope-layer,rewrite}.spec.ts`;
  `test/docker/dood-namespace.live.spec.ts` (two environments + bystanders,
  real CLI and compose, ~11 s).

## Done: publishing on the environment's `localhost`, and `host.docker.internal`

Landed on this branch. AGENTS.md has the load-bearing summary; what a later
phase needs to know on top of it:

- **Layer stack is now `[scopeLayer, publishLayer]`** (`manager.ts`). The
  publish layer sits inside the scope layer: it reads the `domo.publishing`
  label the scope layer wrote at create, and sees real ids in `start`/`stop`.
  It **refuses a create whose `NetworkMode` is `container:` and that has
  publishing** (Docker's own "conflicting options" wording, since the daemon no
  longer sees the ports to refuse them). The `network_mode: host` phase
  rewrites to `container:<env>`: it must drop `domo.publishing` (or run inside
  the publish layer with the ports already gone), or every such service is
  refused. A `container:` service also gets no `ExtraHosts` (Docker refuses
  "custom host-to-IP mapping and the network mode"), which is right for it:
  it shares the environment's `/etc/hosts`.
- **`EnvironmentNetwork` (`network.ts`) is the per-environment hook for "the
  environment's namespace changed"**: `environment()` notices a new PID on
  every reconcile, and reconciles run on environment start, on Domo boot and on
  the environment container's own `start`/`die` events. The `network_mode:
  host` phase's "restart the running ones on environment start" belongs there.
- **The port helper is now built, not pulled**: `RUNTIME_IMAGE` + `iptables`,
  tagged `<prefix>port-helper:<hash of the Dockerfile>`
  (`server/lib/dev-env/port-helper.ts`, which also owns `ensurePortHelper`
  now). A failed build (offline) falls back to `RUNTIME_IMAGE` with a warning:
  ports work, the redirect does not. It runs with `NET_ADMIN` and
  `--security-opt systempaths=unconfined` in addition to before — still not
  `--privileged` (asserted in `test/unit/service-ports.spec.ts`).
- Measured: the `docker run` CLI with no `--network` sends `NetworkMode:
  "default"` **and** `EndpointsConfig: {"default": {}}` — "default" means the
  bridge. Docker's container netns uses the nft backend; the helper's Debian
  `iptables` (1.8.9, nf_tables) coexists with Docker's embedded-DNS rules
  there. One rule per protocol with `-m addrtype --dst-type LOCAL ! -d
  127.0.0.0/8` covers every address the environment has, including networks it
  joins later. `node:22-bookworm-slim` has IPv6 on loopback, so `::` dual-stack
  works and the relay reports both families; it falls back to `0.0.0.0` where
  there is none.
- Measured on Docker 29: a refused start answers **500** with `failed to set
  up container networking: driver failed programming external connectivity on
  endpoint <name> (<id>): Bind for 0.0.0.0:<port> failed: port is already
  allocated`, and leaves the container `created` with `NetworkSettings.Ports`
  `{}`; a stopped container reports `{}` too, and `docker port` prints nothing
  for it. Docker Desktop reports an `sctp` publish as `udp` (its bug) — we
  refuse SCTP at create.
- **Not done / not verified**: IPv6 targets (decided against, see the next
  section); SCTP; Linux hosts (all measured on Docker Desktop). `-P` publishes
  only what the container/image exposes, as Docker does (and is now forwarded
  to the Mac as well, see the next section).
- Tests: `test/unit/dood-{publish,relay}.spec.ts` (the relay script runs for
  real on loopback), `test/unit/dood-responses.spec.ts`;
  `test/docker/dood-publish.live.spec.ts` (two stand-in environments, every
  scenario in the brief, ~50 s); `dev-environment.live.spec.ts` now checks
  `localhost:8080` and `host.docker.internal` in a real environment.

## Done: binds outside the checkout, `network_mode: host`, and the phase-2 leftovers

Landed on this branch. AGENTS.md has the load-bearing summary; what the images
phase needs on top of it:

- **Binds** (`binds.ts`, pure; applied in `rewriteContainerCreate`, so in the
  *scope* layer — the stack is still `[scopeLayer, publishLayer]`). The mount
  table is the environment container's own `docker inspect` (`Mounts`, plus
  `HostConfig.Mounts` for a volume mounted with a subpath), cached with the
  own-container lookup — mounts are fixed at creation. Longest destination
  wins: volume → volume + subpath (`requiredSubpaths` is now
  `{ volume, subpath }[]`, made only in volumes the environment mounts
  writable; `ensureSubpaths(volume, subpaths)`); bind → its host source
  (Docker Desktop reports the plain path, `/private/var/…` resolved; the
  `/host_mnt/…` form is accepted too and stripped); the socket → the proxy
  socket, always in `Binds`, even when the client asked with `Mounts`; a system
  path (`SYSTEM_PATHS`: `/etc/localtime`, `/etc/timezone`, `/usr/share/zoneinfo`,
  `/dev`, `/sys`, `/proc`, `/lib/modules`, `/run`, `/var/run`,
  `/var/lib/docker`) → unchanged; anything else → **400
  `Domo: <path> exists only inside this dev environment, …`**, with a hint to
  `<path>-host` when the home overlay mounted the host's copy beside it
  (`~/.ssh` → `~/.ssh-host`, `~/.gitconfig` → `~/.gitconfig-host`). A mount is
  never less read-only than the environment's. Sources are normalised
  (`..`), so `../shared` outside the checkout lands in whatever mount it really
  is in, or is refused by its real path. Inspect/`docker ps` show every
  translated mount by the source asked for (`domo.binds`, by destination).
  **Not translated**: a symlink inside the environment's filesystem that points
  into a mount (the path is refused; resolving it would need an exec per
  create). A *service* that mounts the socket and binds a path of its own gets
  it resolved against the **environment's** table, not the service's.
- **Host namespaces** (`hostModes` in `rewrite.ts`): `NetworkMode: host` →
  `container:<env id>`, dropping `Hostname`, `Domainname`, `MacAddress`,
  `ExposedPorts`, `ExtraHosts`, `Dns*`, `PortBindings`, `PublishAllPorts`,
  `NetworkingConfig` — Docker refuses each beside a `container:` mode
  (measured: `conflicting options: hostname …`, `… dns …`, `… port exposing
  …`); ports are discarded as a real host discards them, so no
  `domo.publishing` and no refusal from the publish layer. `PidMode: host` →
  `container:<env>` (measured: `ps` shows the environment's PID 1).
  `IpcMode: host` → `container:<env>` only when the environment is
  `--ipc shareable`, which new environments now are (`container.ts`); an older
  one answers `non-shareable IPC`, so there it keeps meaning the daemon host's.
  `UTSMode`, `UsernsMode`, `CgroupnsMode` `host` pass through. What was asked
  is on `domo.modes` and inspect reports `host`. A service in the
  environment's network namespace keeps running in the old one when the
  environment restarts (measured: only `lo` left); `EnvironmentNetwork`
  stops and starts every running `container:<env>` service whose `StartedAt`
  is before the environment's, on each fresh namespace (so also on Domo boot
  after a restart it missed). A `--pid container:<env>` service dies with the
  environment's PID 1 and is left stopped, like the rest of a stack after an
  environment stop.
- **`-P` is forwarded to the Mac** like `-p`: `requestedPorts(labels,
  exposedPorts, bindings)` adds every exposed port of a `PublishAllPorts`
  container, preferring the port the relay allocated in the environment.
- **`host.docker.internal` after the environment moves**: measured, Docker
  gives a restarted container its old address back when free, but not when
  something took it while it was stopped (it came back on `.4`, `.2` was the
  thief's). `ExtraHosts` cannot be updated through the API and a stable alias
  address is not available (a static IP needs a user-configured subnet), so
  every reconcile compares each running service's `ExtraHosts` entry with the
  environment's current address on its network and, when they differ, rewrites
  the service's `/etc/hosts` in place through the helper
  (`/proc/<pid>/root/etc/hosts`, measured on a running container; written with
  `cat >`, not renamed over, since it is a bind mount). Docker rewrites the
  file from the stale `ExtraHosts` on every start, so it is redone per start
  (keyed by PID + address); between a start and the reconcile its `start`
  event triggers, the old address is visible for a moment.
- **IPv6: nothing done, deliberately.** There is no IPv6 `route_localnet`: a
  DNAT to `::1` of traffic arriving from another host is dropped as martian,
  so the loopback redirect cannot be done for IPv6 at all, and the relay's
  targets are the containers' IPv4 addresses. `host.docker.internal` is an
  IPv4 entry, so a client resolving it never tries IPv6. Not cheap, not needed.
- **Docker Desktop findings the images phase inherits** (both in AGENTS.md):
  a host socket bind-mounted into a container only works from a host path of
  **≤ 88 bytes** (`doodSocketPath` enforces it; live specs use
  `mkdtemp('/tmp/ddX-')`), and **`docker restart` of a container that mounts a
  host socket fails** (`open /socket_mnt/…: no such file or directory`) while
  stop + start works — the proxy turns such a restart into a stop (via the
  engine) and forwards the `start` (`restartAsStop`), and `restartStranded`
  uses stop + start too. A restart *policy* on such a container fails the same
  way (measured) and is not closable. Never `docker restart` an environment.
- Tests: `test/unit/dood-binds.spec.ts` (mount table, resolution, refusals,
  `..`, read-only, both syntaxes, host modes, the 88-byte check), additions to
  `dood-{responses,publish,scope-layer}.spec.ts` and `service-ports.spec.ts`;
  `test/docker/dood-binds.live.spec.ts` (one stand-in environment, every
  scenario in the brief, ~20 s).

## Done: images (decision 4)

Landed on this branch. AGENTS.md has the load-bearing summary ("Images are
shared; the tags an environment produces are its own"); what a later phase
needs on top of it:

- **Layer stack is `[scopeLayer, publishLayer, imageLayer]`** (`manager.ts`).
  The image layer sits inside the scope layer so its transforms read the
  `domo.image` label (the name a container was created from, when the proxy
  gave the daemon a private one) before the scope layer hides `domo.*`.
- **Naming** (`images.ts`): `domo-<envId>/<registry>/<path>:<tag>`, registry
  always spelled (`docker.io` too), lowercased, `:port` → `__port` (a hostname
  has no `_`, so it round-trips). `app` → `domo-env_x/docker.io/library/app:latest`,
  `ghcr.io/o/a:1` → `domo-env_x/ghcr.io/o/a:1`, `localhost:5000/a` →
  `domo-env_x/localhost__5000/a:latest`. Every one is a valid Docker Hub name
  and the containerd store lists it as `docker.io/domo-env_x/…`. No spelling
  for an IPv6 registry, a digest, or past 255 characters: refused with a
  `Domo:` error where a name is produced (`tag`, `commit`, `import`, a build's
  exporter as gRPC `INVALID_ARGUMENT`).
- **`FROM` resolves through a source policy, not named contexts** — a
  deliberate departure from the spike. Measured: BuildKit's `dockerfile2llb`
  asks `NamedContext(st.Name)` for every `FROM … AS <name>`, so a
  `context:app` injected for a private `app:latest` replaces any stage called
  `app` (read in `convert.go`; the live spec builds that case and gets the
  stage). A `CONVERT` rule per private name on `Control/Solve` field 12
  (`^docker-image://docker\.io/library/app:dev(@sha256:…)?$` →
  `docker-image://docker.io/domo-env_x/docker.io/library/app:dev${1}`,
  appended after any rules the client sent) applies to every source the
  gateway frontend resolves, `COPY --from=<image>` included. No policy is sent
  when the environment holds no private image.
- **The cosmetic target is met exactly**: with the policy the vertices read
  `[internal] load metadata for docker.io/library/X` and `[1/n] FROM
  docker.io/library/X`, numbering included (the frontend names them after the
  Dockerfile; only the `docker.io/domo-env_x/…` in `FROM` and `naming to` needs
  the Status rewrite). Diffed `--progress=plain` of the same build direct and
  proxied: identical after timings and digests. One trap in the comparison,
  not the proxy's: whether BuildKit prints a `FROM` of a local image as
  `CACHED` or `DONE` depends on what it solved before, so both sides are run
  once first.
- **Found and fixed in the bridge**: Node's `http2` joins a repeated header
  into `a, b`; BuildKit's session announces each method it serves as a
  repeated `x-docker-expose-session-grpc-method`, and joined they name none.
  Symptom: `compose build` of two targets sharing a context →
  `no local sources enabled` (only with a source policy present, which is why
  the spike never saw it). Headers are forwarded from `rawHeaders`. The probe
  has the same latent bug. The spike's `VertexLog` field was also wrong
  (`msg` is 4; 3 is a stream number).
- **Push** (`docker push`, private image): the real name is tagged for the
  push and put back after (untagged, or moved back to the image a shared tag
  of that name had). `--all-tags` of a repository the environment holds is
  refused. A build with `push=true` keeps the registry name in the exporter
  and tags the private name from `containerimage.config.digest` before the
  solve's answer reaches the client; the local tag the push made is removed or
  put back the same way.
- **Pull** stays shared, and moves the environment's own tag of that name to
  what was pulled once it succeeded (no `error` line) — what a pull means on a
  machine of its own.
- **Load/save** rewrite the three naming files of the archive
  (`index.json`, `manifest.json`, `repositories`) as it streams (`tar.ts`):
  in on a load, so no shared tag is ever created or moved; out on a save. A
  request body the proxy streams can now be transformed (`Outcome.requestBody`,
  re-sent chunked), and so can a response body (`ResponseTransform.stream`).
- **`rmi`**: own tag as asked; a shared name unforced, refused (409) when any
  container outside the environment runs on that image; by id, only an image
  nothing else names. Measured why the daemon's check is not enough: `rmi
  alpine:3` from one environment succeeded while the host's containers ran on
  it, because another environment's private tag on the same image made it a
  mere untag.
- **Legacy `POST /build`**: `t` privatised, `cachefrom` resolved,
  `networkmode` translated in the scope layer (network / `container:` resolved,
  `host` → `container:<env>`; BuildKit's `version=2` keeps `host`). BuildKit
  builds never send a custom network — buildx refuses one itself — and
  `--network host` there stays the daemon VM's (BuildKit has no `container:`
  mode). `FROM` a private image does **not** work on the legacy builder or
  `/build?version=2` (no policy there).
- **`system df -v` on API ≥ 1.52** answers `{ContainerUsage, VolumeUsage,
  ImageUsage: {Items}}` and the phase-1 transform only knew the old shape, so
  it listed every environment's containers; both shapes are narrowed now. The
  counts are still the daemon's.
- **Not rewritten, documented**: provenance in `--metadata-file` names a
  private base by its private name (buildx reads it from a content-addressed
  blob through `Content/Read`); `docker buildx history` shows every
  environment's builds; a `docker-container` buildx builder (a separate
  buildkitd) resolves `FROM` from registries only.
- Measured: ~15–20 ms per cached build through the bridge (167–172 ms direct,
  187–193 ms proxied).
- Tests: `test/unit/dood-{images,buildkit,tar,image-responses,image-layer,grpc-bridge}.spec.ts`
  (the bridge with real HTTP/2 on both sides over local sockets), additions to
  `dood-{http,responses,scope-layer}.spec.ts`; `test/docker/dood-images.live.spec.ts`
  (two stand-in environments, every scenario in the brief, ~40 s).

## The goal

From inside an environment, Docker behaves like a normal machine whose
"host" is the environment container — without modifying the project — while
N environments share one daemon (and its image/build cache) without seeing
or breaking each other or the developer's own containers (Domo's own Postgres
and Electric run on the same daemon). **Not isolation**: an agent can still
run `--privileged`/`--pid=host`. The scoping prevents accidents only.

Where something cannot be translated, **fail loudly**: the proxy answers the
request itself with a Docker-shaped JSON error (`{"message":"Domo: …"}`),
which the CLI and compose print like a daemon error. Safe because Docker
clients never pipeline: when request N+1 arrives, response N is complete.

## Decisions (confirmed)

1. **Names are namespaced, not merely reported.** Containers, networks and
   volumes are created on the host as `<envId>-<name>`; the agent sees
   `<name>` everywhere. Reason: parallel environments of one project running
   one compose file collide on every `container_name:`, every compose file in
   a subdirectory (same project name), every `docker run --name`. The
   unprefixed container name is added as a network alias on every network so
   DNS by container name keeps working. Collisions *within* one environment
   still get Docker's own error, prefix stripped from the message.
2. **Everything is scoped.** Lists, events and prunes get the `domo.env`
   label filter (networks also keep the builtins `bridge`/`host`/`none`).
   Every container/network/volume reference in a path, query or body is
   *resolved within the environment* (full id, prefixed name, unique id
   prefix) and replaced by the real id; not found → Docker's own `No such
   container: <ref>` 404. The environment's own container is resolvable (for
   `--network container:$(hostname)`) but cannot be stopped/removed from
   inside — loud error.
3. **Responses are rewritten for the JSON endpoints that need it** (inspect,
   lists, errors; events line by line), never for streams (logs, attach,
   build output, stats). Requires parsing response framing (status line,
   headers, content-length/chunked, HEAD/204/304 no body, 101 → raw) on every
   response, with a FIFO of per-request transforms. Inspect restores the
   original binds/mounts (kept on a `domo.binds` label at create), names,
   network names, `PortBindings` and `NetworkSettings.Ports` (so `docker
   port` / `docker compose port` / `docker ps` PORTS are right), and hides
   `domo.*` labels.
4. **Images** — done, see above (the `FROM` mechanism became a source
   policy). As planned: pulls and pulled
   tags stay shared (the cache is the point). Tags an environment *produces*
   become private, `domo-<envId>/<original name>`:
   - builds: the proxy terminates `/grpc` with `node:http2` on both sides and
     rewrites the exporter `name` in `Control/Solve` (not when it pushes —
     keep the registry name, add the private tag from the response digest);
     it injects `context:<name>=docker-image://<private>` into the
     `LLBBridge/Solve` `FrontendOpt` for every private image of the
     environment, so `FROM` / `COPY --from` resolve to them;
   - `docker tag` (target), `commit ?repo=`, `load` (retag what the stream
     reports): plain HTTP rewrites;
   - consuming a name from X: X's private tag if present, else the verbatim
     (shared) name. Builds never produce public tags, so nothing of another
     environment's is ever visible under one;
   - `docker images` / `image inspect` in X: X's private tags shown
     unprefixed, other environments' private tags hidden;
   - `docker push <name>` of a private image: tag the real name, push, untag.
   - the bridge also rewrites the private name back to the original in the
     `Control/Status` stream (Vertex 3 name; VertexStatus 1 ID, 3 name;
     VertexLog 3 msg; VertexWarning 3, 4) and in the `Solve` response's
     `ExporterResponse` values, so progress output and `--metadata-file` show
     `docker.io/library/<name>` — measured, both done in the probe;
   - a CLI resetting its socket once every call is answered is its normal
     hang-up: close the daemon side, log only if a call was still open —
     measured, no errors logged;
   - **still visible**: a `FROM` served by a named context is labelled
     `[context X] load metadata for X` / `[context X] X` instead of
     `[internal] load metadata for docker.io/library/X` / `[1/2] FROM
     docker.io/library/X`, and the following steps number one lower
     (`[1/2] RUN` instead of `[2/2] RUN`). Try rewriting those vertex names
     and the `[i/n]` counters in the Status stream; judge it by diffing
     `--progress=plain` of the same build direct vs through the proxy, as the
     spike did. If the numbering cannot be made exact, the names alone are
     worth fixing.
5. **Order of work**: ~~scoping + names → response rewriting~~ (done) → ~~`localhost`
   publishing + `host.docker.internal`~~ (done) → ~~binds + `network_mode: host`~~
   (done) → ~~images~~ (done).

## Pieces, each with what was measured

### Scoping and names (decisions 1–2) — done, see above
- A small Engine API client to the daemon socket (Node `http` with
  `socketPath`), not the `docker` CLI: resolutions happen on the request path.
- Rewrite: create `?name=`, rename `?name=`, `Links`, `VolumesFrom`,
  `NetworkMode`/`PidMode`/`IpcMode` `container:<ref>`, `EndpointsConfig`
  keys (+ alias), network connect/disconnect body `Container`, named volumes
  in `Binds`/`Mounts` (create them first *with the label*, or implicit
  creation leaves them unlabelled and unswept), `commit?container=`.
- Prune: containers/networks/volumes get the label filter. `image prune -a`
  and `builder prune` would empty the *shared* cache → refuse loudly.
  Swarm/services/nodes/secrets/configs/plugins mutations → refuse loudly.

### Publishing into the environment (`localhost:<port>` from the agent) — done, see above
- Measured: the port helper can `nsenter` the environment's netns and listen
  on `127.0.0.1:5432` relaying to the service's IP; the environment's
  `localhost:5432` answered, and the listener is invisible to the agent's
  `ps`. It dies when the environment restarts (new netns).
- Relay target = the service's address on a shared network + container port —
  the same semantics as real publishing (a service bound only to its own
  loopback is not reachable through a published port on a real host either).
- Design: one relay process per environment, running in the helper under
  `nsenter` into the environment's netns, driven over its stdin by Domo
  (desired state: listen port → target container). Dies with Domo (stdin
  EOF) and is re-established on boot and on environment start (PID change).
  Reconciled after start/stop/kill/rm/restart responses and on scans.
- TCP and UDP (datagram relay with per-sender sessions + idle timeout). SCTP
  → refuse loudly. Port ranges, `HostIp` (`127.0.0.1` vs all, IPv6),
  `-P` (image `ExposedPorts` via image inspect), host port 0/none → allocate,
  record on the label, report in inspect. Host port already in use in the
  environment → fail `start` loudly as a real host does ("port is already
  allocated"): pre-check before forwarding the start.
- The scanner must not list these relays as the environment's own ports.
- Keep auto-forwarding published ports to the Mac (Ports panel).

### `host.docker.internal` from a service → the environment (Operea: Restate → dev server) — done, see above
- Measured: `ExtraHosts host.docker.internal:<environment IP on the service's
  network>` plus, in the environment's netns via the helper,
  `sysctl net.ipv4.conf.all.route_localnet=1` and an iptables `nat
  PREROUTING` DNAT to `127.0.0.1` → a service reached a **loopback-only**
  server in the environment (matches Docker Desktop's behaviour for the Mac).
- Must always add the entry: without it Docker Desktop's DNS answers
  `host.docker.internal` = `192.168.65.254` (the Mac). Rewrite compose's
  `host-gateway` too.
- The helper then needs `NET_ADMIN` and `--security-opt
  systempaths=unconfined` (`/proc/sys` is read-only otherwise — measured),
  still not `--privileged`, and an image with `iptables` (build a small helper
  image from `RUNTIME_IMAGE`). Try one rule for all of the environment's
  addresses: `-m addrtype --dst-type LOCAL -j DNAT --to-destination
  127.0.0.1`. Re-apply on every environment start.
- `network_mode: container:<env>` services share `/etc/hosts` with the
  environment; nothing to add there.

### Binds outside the checkout — done, see above
- Resolve the source against the environment container's own mounts, longest
  prefix: a volume → that volume + subpath (generalises the workspace case);
  a bind (`~/.aws`, `~/.ssh-host` …) → its source on the host (check whether
  Docker Desktop accepts the `/host_mnt/…` form `inspect` reports, or use the
  path Domo mounted from); `/var/run/docker.sock` → *this environment's own
  proxy socket*, as a `Binds` entry (Docker Desktop refuses a socket through
  `Mounts`), so what that service creates is labelled too.
- System paths pass through to the daemon host (`/etc/localtime`,
  `/etc/timezone`, `/dev`, `/sys`, `/proc`, `/lib/modules`, `/run/…`) —
  common in compose files.
- Anything else exists only in the environment's filesystem → refuse loudly
  (`Domo: /home/vscode/cache exists only inside this environment and cannot
  be mounted by a container on the host daemon`).

### `network_mode: host` — done, see above
- Rewrite to `container:<environment container id>` and drop what conflicts
  with it (`Hostname`, `Domainname`, `ExtraHosts`, `Dns*`, `MacAddress`,
  `PortBindings`, `NetworkingConfig`). On environment start, restart the
  running ones (their netns went with the old one).

## Not closable (document)
- Anything the agent does with `--privileged` / `--pid=host` / the host's
  socket by other means. Shared image tags for *pulled* images (by design).
- Global `docker info` / `system df` counts.

## Testing
- Pure translation functions in `test/unit` (request rewrite, response
  rewrite, resolution decisions), as `rewrite.ts` is now.
- `test/docker/*.live.spec.ts` with the real CLI and real compose for each
  piece: two environments running one compose file with `container_name:`
  side by side; `docker ps`/`rm -f $(docker ps -aq)`/`volume prune` from one
  not touching the other or a bystander container; `psql localhost:5432`
  from the environment; a service calling `host.docker.internal:<port>` of a
  loopback-only server in the environment; `docker compose port`; binds
  (`~/.aws`, docker.sock, refused path); `network_mode: host`.
- End to end in the app (second dev server on `domo_e2e`, ports 3766/3767),
  ideally with the Operea stack.
