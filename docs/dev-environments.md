# Dev environments and their Docker

Read this before you change the environment lifecycle (`server/lib/dev-env/`,
`server/lib/dev-environments.ts`, `server/lib/projects.ts`) or the Docker proxy
(`server/lib/dood/`), or when `docker` inside an environment acts in an
unexpected way.

## `"docker": true` is the host daemon, seen through a proxy

- **Each environment gets its own unix socket onto the host daemon**, mounted
  at `/var/run/docker.sock`. The socket a request arrives on is its only
  identity. This replaced a daemon per environment (DinD), whose volumes
  filled the Docker VM. Older environments keep DinD, and so does a project
  that lists the docker-in-docker Feature itself. Only those run
  `--privileged`.
- **It is not a security boundary.** Anything that reaches the host daemon can
  take the host.
- **Each environment sees the daemon as its own.** Names it gives are created
  as `<envId>-<name>` and shown back without the prefix everywhere, including
  error messages. Everything it makes carries `domo.env=<id>`, and lists,
  events and prunes are narrowed to that label. What cannot be translated is
  refused as `{"message":"Domo: …"}`.
- **The proxy is a byte splice, not an HTTP server.** Docker clients reuse one
  connection, and `POST /containers/{id}/wait` is a long poll. An in-order
  HTTP server queues the `start` behind the wait, and every `docker run`
  deadlocks. Both sockets need `allowHalfOpen: true`, or `docker run` prints
  nothing and exits 0.
- **The environment's own container is hidden from `network inspect`.** If
  `compose down` sees any endpoint, it never deletes the network.
- **The docker-outside-of-docker Feature contributes only its binaries.** Its
  `socat` fallback cuts attached output off.

## Binds, namespaces and images

- Bind sources resolve against the environment container's own mounts
  (`binds.ts`). A path that exists only in the environment's image layer is
  refused by name. Otherwise the daemon's host would mount an empty directory.
- `network_mode: host`, `--pid host` and `--ipc host` become
  `container:<environment>`. That is why environments are created
  `--ipc shareable`.
- **Pulls are shared. Tags an environment produces are private**
  (`domo-<envId>/<registry>/<path>:<tag>`, `images.ts`). A build is gRPC over
  h2c, bridged in `grpc-bridge.ts`. `FROM` a private image goes through a
  BuildKit **source policy**, not named contexts. A named context also replaces
  a *stage* of the same name, so `FROM … AS app` would silently become the
  environment's `app:latest`.
- **Forward gRPC metadata from the raw header list.** Node joins repeated
  headers, and BuildKit sends its session methods as one. Joined, compose
  builds of two targets that share a context fail.
- **`rmi` of a shared name is refused while a container outside the
  environment runs on it.** The daemon allows untagging a name that has other
  names, and the other name may belong to another environment.

## Ports and publishing

- **One global port helper enters each service's network namespace** with
  `nsenter -n` (`port-helper.ts`). A sibling service's loopback port, which is
  where Vite and Next listen by default, cannot be reached any other way. Do
  not reach services by name instead, and do not add a reverse proxy. Both
  were considered and rejected.
- **`-p` / `ports:` publish on the environment's own `localhost`**, through a
  relay in its namespace. Nothing is published on the daemon's host, so two
  environments can both use `localhost:5432`.
- **`host.docker.internal` inside a service means the environment.** Every
  create gets an `ExtraHosts` entry, because Docker Desktop's DNS would
  otherwise answer with the Mac.

## The socket path (Docker Desktop)

- **Mount the socket with `-v`, never `--mount`.** `--mount` of a host socket
  fails on Docker Desktop.
- **Docker Desktop forwards a socket only if its host path is at most 88
  bytes, and fails silently past that.** The mount succeeds and every
  connection is refused. Sockets live at `~/.domo/s/…` for this reason
  (`doodSocketPath`). Changing how the path is derived breaks every existing
  environment until it is recreated, because the path is fixed into its mounts.
- **Docker Desktop cannot `docker restart` a container that mounts a host
  socket.** Stop and start it instead, as Domo does (`restartAsStop`).

## Linux is only partly verified

Everything above was measured on Docker Desktop for macOS. On rootful Docker
Engine, three problems are known and not yet fixed:

- A running container does not see a socket re-created at the same path,
  because a file bind mount binds the inode. After a Domo restart, every
  running environment's `docker` is refused until the environment is stopped
  and started. The likely fix is to mount a per-environment socket
  *directory* (mode `0700`) and symlink `/var/run/docker.sock` into it.
- A container started while its socket is missing gets a root-owned directory
  at that path, and every later start fails until it is removed.
- The keep-alive's `chmod 666` changes the host file, so the socket becomes
  world-writable on the host.

## Lifecycle

- **Retirement is done when Docker no longer has the resources, not when
  `docker` exited.** A failed `volume rm` looks the same for a volume in use
  and one that never existed, and an unreachable daemon lists nothing. So
  removal is one sweep (`dev-env/reconcile.ts`): observe, remove what a row
  claims, and record what survived in `dev_environments.leftovers`. It runs
  after retirement or a failed creation, once at boot, and on request. There
  is **no retry timer**, on purpose. What survives one attempt does not go
  away by itself.
- **A resource is removed only when a row claims it** (`dev-env/leftovers.ts`).
  **Never sweep by prefix**, because the workspace volume is the only copy of
  an agent's work. Never use `docker network prune`, because it would remove
  the developer's own networks.
- **A retired environment's row is kept for good**, because the row is what
  claims its leftovers.
- **`retired_at` is lifecycle, and `status` is health.** A retired row that
  still owes resources has `status: 'error'`. The UI keys on `status`, never on
  `last_error`.
- **`bin/chrome-headless-shell` in the browser volume is a wrapper, never a
  symlink.** It supplies `LD_LIBRARY_PATH` and `FONTCONFIG_PATH`. Without
  fontconfig, Chromium dies as soon as it draws text, and the caller sees only
  "the browser has closed". A layout change must bump
  `BROWSER_LAYOUT_REVISION`, or existing installs keep mounting the old volume.
- The shared runtime and browser volumes are trusted only when their marker
  *and* their contents check out (`readyCheckScript()`). A crash mid-build
  can leave `.ready` beside truncated files.
