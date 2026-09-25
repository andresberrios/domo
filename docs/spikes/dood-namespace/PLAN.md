# Plan: each environment sees the host daemon as its own Docker host

Settled with the user on 2026-09-25. This is the working plan for the next
stretch of `worktree-dood-shared-daemon`; delete it (or fold what survives into
`AGENTS.md`) when the work lands. The image-tag question is being settled by
the spike in `README.md` beside this file — **done: viable**, see decision 4.

## Where things stand (committed)

- `server/lib/dood/`: per-environment unix socket onto the host daemon, a byte
  splice parsing only client→daemon. Translates container create (workspace
  binds → workspace volume + subpath, host publishing dropped and written on a
  `domo.ports` label, networks joined by the environment), labels
  network/volume create with `domo.env=<id>`, detaches the environment from a
  network on inspect/delete (compose down). Sweep by label on retire; stop
  stops the stack.
- `docker: true` = docker-outside-of-docker Feature's CLI only + the proxy
  socket via `-v` at `/var/run/docker.sock`. Existing environments keep DinD.
- Ports panel: one global port helper (`<prefix>port-helper`, `--pid=host`,
  `SYS_ADMIN` + `SYS_PTRACE`) `nsenter -n`s services by PID; scanner +
  userland forwarder to the Mac. Rows keyed by `service`.

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
4. **Images** (mechanism settled by the spike, `README.md`): pulls and pulled
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
5. **Order of work**: scoping + names → response rewriting → `localhost`
   publishing + `host.docker.internal` → binds + `network_mode: host` →
   images (the `/grpc` bridge, then the HTTP-side tag handling).

## Pieces, each with what was measured

### Scoping and names (decisions 1–2)
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

### Publishing into the environment (`localhost:<port>` from the agent)
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

### `host.docker.internal` from a service → the environment (Operea: Restate → dev server)
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

### Binds outside the checkout
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

### `network_mode: host`
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
