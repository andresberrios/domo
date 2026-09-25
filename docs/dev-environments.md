# Dev environments and their Docker

Read this before you change the environment lifecycle (`server/lib/dev-env/`,
`server/lib/dev-environments.ts`, `server/lib/projects.ts`) or the Docker proxy
(`server/lib/dood/`), or when `docker` inside an environment acts in an
unexpected way. The design record and every measurement behind it are in
`docs/spikes/dood-namespace/PLAN.md`.

## `"docker": true` is the host daemon, seen through a proxy

- **Each environment gets a unix socket onto the host daemon**, bind-mounted at
  `/var/run/docker.sock`. The socket a request arrived on is its only
  identity. Environments used to run their own dockerd (DinD). Nine DinD
  volumes held ~18 GB, the Docker VM filled up, and Postgres could not start.
  Environments created before the change keep their DinD. A project that lists
  the docker-in-docker Feature itself still gets it, and only then does an
  environment run `--privileged`.
- **Not a security boundary.** A container that reaches the host daemon can
  take the host. There is no off-the-shelf alternative: a nested daemon cannot
  share the host's image store (moby#29764, moby#40196), and existing socket
  proxies are ACL filters that cannot rewrite a body.
- **Each environment sees the daemon as its own.** What it names is created as
  `<envId>-<name>` and shown back without the prefix, everywhere (inspect,
  lists, events, error messages). Everything it makes carries `domo.env=<id>`,
  and lists, events and prunes are narrowed to that label. A reference it does
  not own is sent on prefixed, so the daemon answers "No such container" in
  its own words. What cannot be translated is refused as
  `{"message":"Domo: …"}`: swarm and plugin mutations, `image prune -a`, the
  build-cache prune (HTTP and buildx's gRPC `Control/Prune`), and stopping,
  removing or renaming the environment's own container.
- **The proxy is a byte splice, not an HTTP server.** A Docker client reuses
  one connection and `POST /containers/{id}/wait` is a long poll. An HTTP
  server answers in order, so the `start` that would end the wait queues
  behind it and every `docker run` deadlocks. Bytes are held back only where a
  layer asked for a JSON body. This is safe only because Docker clients never
  pipeline. Both sockets need `allowHalfOpen: true`: a client with no stdin
  half-closes after the attach, and with Node's default `docker run` prints
  nothing and exits 0.
- **The environment's own container is hidden from `network inspect`.**
  `compose down` inspects a network before it deletes it, and if it sees any
  endpoint it never sends the DELETE.
- **The docker-outside-of-docker Feature contributes only its binaries.** Its
  mount is the raw host socket, and its entrypoint falls back to a `socat`
  relay whenever the socket's group is root (always, on Docker Desktop), whose
  0.5 s half-close timeout cuts attached output off.

## Binds and host namespaces

- Bind sources are resolved against the environment container's own mounts,
  longest destination first (`binds.ts`). A volume becomes that volume with a
  subpath, a bind becomes its host source, `/var/run/docker.sock` becomes this
  environment's proxy socket (so a service given it is scoped like the agent),
  and a short list of system paths passes through. Anything else is in the
  environment's image layer and is refused by name. Without the refusal it
  would be mounted as an empty directory from the daemon's host.
- `network_mode: host`, `--pid host` and `--ipc host` become
  `container:<environment>` and are reported back as `host`. That is why
  environments are created `--ipc shareable`. Such services are stopped and
  started again when the environment comes back in a new namespace.

## Images

- **Pulls are shared; tags an environment produces are private.** A build,
  `tag`, `commit`, `load` or `import` creates
  `domo-<envId>/<registry>/<path>:<tag>` (`images.ts`; the registry is always
  spelled, a port's `:` is `__`, an IPv6 registry is refused). A name the
  environment uses means its private tag first, then the shared one. Other
  environments' private tags are hidden.
- **A build is `POST /grpc` upgraded to h2c.** `grpc-bridge.ts` is an HTTP/2
  server to the CLI and a client to the daemon, and edits three BuildKit
  messages (`buildkit.ts`). `FROM` a private image works through a **source
  policy**, not named build contexts: BuildKit also looks a named context up
  for every stage name, so `FROM … AS app` would silently become the
  environment's `app:latest`.
- **Forward gRPC metadata from the raw header list.** Node joins a repeated
  header into `a, b`, and BuildKit lists the methods its session serves as a
  repeated header. Joined, compose builds of two targets sharing a context
  failed with `no local sources enabled`.
- **`rmi` of a shared name is refused when a container outside the environment
  runs on that image.** The daemon's own check does not cover it: untagging a
  name the image has other names for always succeeds, and the other name may
  be another environment's private tag. Measured: `rmi alpine:3` took the tag
  from the host's own containers.
- Not rewritten: provenance, buildx build history, and `FROM` a private image
  under the legacy builder or `POST /build?version=2`.

## Ports and publishing

- **One global port helper enters each service's network namespace**
  (`service-ports.ts`, `port-helper.ts`). A sibling service's loopback port is
  invisible from the environment, and unreachable even by network name, which
  is where Vite and Next listen by default. So the helper (`--pid=host`,
  `SYS_ADMIN`, `SYS_PTRACE`, `NET_ADMIN`, no `--privileged`) `nsenter -n`s by
  the PID `docker inspect` reports, and reads the PID per connection so a
  restarted service needs nothing replaced. It has no environment label, so no
  environment's sweep takes it. **Do not reach services by name instead, and
  do not add a reverse proxy.** Both were tried or proposed and rejected.
- **`-p` / `ports:` publish on the environment's own `localhost`**, through one
  relay process per environment in its namespace (`network.ts`, `publish.ts`,
  `relay-script.ts`). Nothing is published on the daemon's host, so two
  environments can both have `localhost:5432`. Ports are held before a `start`
  is forwarded, and a taken one refuses it with Docker's own wording.
  Reconciled from one `GET /events` stream, so restart policies and Docker
  Desktop's buttons are covered.
- **`host.docker.internal` inside a service means the environment.** Docker
  Desktop's DNS answers it with the Mac in any container unless `/etc/hosts`
  says otherwise, so every create gets `ExtraHosts` for it. `route_localnet=1`
  plus one DNAT to `127.0.0.1` makes loopback-only dev servers reachable, so a
  server bound only to the environment's `eth0` address is not. Both die with
  the namespace and are redone when its PID changes. `ExtraHosts` is fixed at
  create, so a reconcile rewrites a running service's `/etc/hosts` in place
  when the environment's address has changed.

## The socket path

- **Mount it with `-v`, never `--mount`.** Measured on Docker Desktop 4.92:
  `--mount type=bind` of a host socket fails with `bind source path does not
  exist: /socket_mnt/…`. Mounting a directory holding it fails with `ENOTSUP`.
- **Docker Desktop forwards a socket only if its host path is at most 88
  bytes, and fails silently past that**: the mount succeeds and every
  connection gets `ECONNREFUSED`. macOS `sun_path` is 104. So sockets live at
  `~/.domo/s/<8 hex of the data dir>/<12 hex of the env id>.sock`, not under
  the data directory or `/tmp` (macOS cleans it), and `doodSocketPath` refuses
  a longer path. `NUXT_DOOD_SOCKET_DIR` overrides it.
- **Changing how the path is derived strands every existing environment**:
  the path is fixed into its mounts at creation, so its `docker` answers
  `ECONNREFUSED` until it is recreated. `restoreDockerProxies()` brings every
  socket back at boot.
- While Domo is down, `docker` inside an environment **hangs rather than
  fails** on Docker Desktop, and completes when the proxy listens again.
- **Docker Desktop cannot `docker restart` a container that mounts a host
  socket** (`open /socket_mnt/…: no such file or directory`, left stopped).
  `stop` then `start` works. Domo only stops and starts environments, and
  restarts such a service as a stop plus a start (`restartAsStop`). A restart
  *policy* fails the same way and cannot be fixed from the proxy.
- `keepAliveScript()` `chmod 666`s the forwarded sockets on every start: Docker
  Desktop presents them as root:root 0660.

## Linux is only partly verified

Everything above was measured on Docker Desktop for macOS. A partial pass on
rootful Docker Engine (`PLAN.md`, "Linux") found three differences, not yet
fixed:

- A running container does not see the socket re-created at the same path (a
  file bind mount binds the inode), so after a Domo restart every running
  environment's `docker` is refused until it is stopped and started.
- A container started while its socket is missing gets a root-owned directory
  at the socket path, and every later start fails until it is removed.
- The keep-alive's `chmod 666` changes the host file, so the socket becomes
  world-writable on the host.

## Lifecycle

- **Retirement is done when Docker no longer has the resources, not when
  `docker` exited.** `docker volume rm` fails the same way for a volume in use
  and for one that never existed, and an unreachable daemon lists nothing, just
  like a clean one. So removal is one sweep (`dev-env/reconcile.ts`): observe
  what Docker has, remove what a row claims, write what survived to
  `dev_environments.leftovers`. It runs after every retirement and every
  failed creation, once at boot, and when someone asks
  (`POST /api/dev-environments/[id]/cleanup`, the `retry_environment_cleanup`
  mesh and voice tools, the button on the environment page). There is **no
  timer**, on purpose. What survives one attempt does not go away by itself (a
  container that mounts the volume, a container made from the image, a child
  image). So a refusal names the blocking container and the command that
  removes it (`explainRefusal`), and a retry is someone's decision.
- **Attribution is positive, and that is the whole safety argument**
  (`dev-env/leftovers.ts`). A resource is removed only when a row claims it. A
  retired row claims the names derived from its id (container, workspace
  volume, image, `dind-var-lib-docker-<id>`) and everything its proxy labelled
  `domo.env=<id>` or tagged `domo-<id>/…`. Any row claims what a cleanup
  recorded as owed, which is how a failed creation's wreckage is claimed.
  A live environment's stack, the port helper and its image, the runtime and
  browser volumes, and anything of another install are never candidates. A
  resource that looks like this install's but that no row accounts for is
  logged and left in place. Never sweep by prefix: the workspace volume is the
  only copy of an agent's work. Never use `docker network prune`: it would take
  the developer's own networks.
- **A retired environment's row is kept for good**, because it is what claims
  its leftovers. Only a retired project that no environment ever lived in is
  dropped (`pruneRetiredProjects`).
- **`retired_at` is lifecycle and `status` is health. They are independent.**
  The row is retired before the sweep, not after Docker agrees: the container
  must go first, the sessions can never run again, and `retired_at` is what
  makes the row claim its resources. A retired row that still owes something is
  `error`, with the leftovers in `last_error`. If Docker cannot be reached, the
  derived names are recorded as unconfirmed, so the retirement does not report
  a clean result. Anything that renders it keys on `status === 'error'`, never
  on `lastError`. `last_error` is history.
- Relays and the `host.docker.internal` redirect are processes of the Domo that
  started them (a relay exits when its stdin closes). They are not resources on
  the daemon, so the sweep does not look for them.
- `docker rm --volumes` does not remove a DinD volume
  (`dind-var-lib-docker-<id>`), so `removeContainer()` removes the container's
  named volumes by name.
- The shared runtime and browser volumes are trusted only when their marker
  *and* their contents check out (`readyCheckScript()`). After Docker Desktop
  crashed on a full disk mid-build, a volume carried `.ready` with its files
  cut short.
