# Spike: can an environment's image builds get private tags?

**Answer: yes, cleanly, by terminating BuildKit's `/grpc` HTTP/2 channel in
the proxy.** Measured 2026-09-25 on Docker Desktop 4.92 (Engine 29.8, buildx
0.37.1, Compose 5.5.1) with `grpc-mitm-probe.mjs` beside this file.

## The problem

Environments share the host daemon's images on purpose, but a tag an
environment *builds* must not overwrite another environment's (`app:dev`
built by two agents in parallel). The obvious fix — prefix the tag in the
build request — has nothing to rewrite: `docker build -t` and `docker compose
build` send **no `/build?t=`** request at all. Traced through the proxy, a
build is only `HEAD /_ping`, `GET /version`, `POST /grpc` and `POST
/session`, the last two upgraded to raw connections. The tag travels inside a
gRPC message over HTTP/2 on `/grpc`.

Editing HTTP/2 frames in place is fragile (a changed message length has to be
reconciled with flow control in both directions). A prefixed tag also breaks
`FROM <locally built image>`: the Dockerfile frontend resolves `FROM` against
the daemon's real tags.

## What was measured

The probe splices every connection as the real proxy does, except `POST
/grpc`: it forwards the upgrade, reads the daemon's `101`, and then bridges
the two sides with **two `node:http2` sessions** — a server facing the CLI,
a client facing the daemon — so each side runs its own flow control and the
proxy sees decoded gRPC messages it can change. `/session` stays spliced.

1. **Both `docker build` and `docker compose build` succeed through the
   bridge**, unmodified, with identical output.
2. **The tag is readable and rewritable.** `moby.buildkit.v1.Control/Solve`,
   field 13 (`Exporters`), type `moby`, attr `name` = `probeimg:dev` (compose:
   `probeapp:dev`, with its labels in field 7 `FrontendAttrs`). Rewriting it to
   `domo-env-a/probeimg:dev` produced exactly that tag and **no** public
   `probeimg:dev`; compose reported `Image probeapp:dev Built`.
3. **The result is readable too.** The `Solve` response's
   `ExporterResponse` carries `containerimage.config.digest` (the image ID) and
   `image.name`, so the proxy knows exactly what a build produced, with no race
   against another environment building the same name.
4. **`FROM` chains work through named build contexts.** A child Dockerfile
   `FROM probebase:dev` (only the private `domo-env-a/probebase:dev` existing)
   fails as predicted when nothing is injected (`pull access denied … probebase`).
   Injecting `context:probebase:dev=docker-image://domo-env-a/probebase:dev`
   into the **`moby.buildkit.v1.frontend.LLBBridge/Solve`** request's
   `FrontendOpt` (field 3, only on the call whose field 2 `Frontend` is set)
   made BuildKit log `[context probebase:dev] load metadata for
   domo-env-a/probebase:dev`, and the child saw the base's file. Injecting into
   `Control/Solve`'s `FrontendAttrs` instead does **nothing**: buildx runs the
   build as a gateway client and passes the frontend its own options on the
   bridge call. The Dockerfile itself is never touched.
5. **Cost:** a cached build took 0.18–0.19 s through the bridge against
   0.16–0.17 s direct.
6. **`ERR_HTTP2_ERROR Protocol error` on the CLI side at the end of every
   `/grpc` connection is benign**: the CLI resets the socket (no FIN) once its
   calls are answered. Close the daemon side quietly on it.

Protobuf is handled by hand (varints, length-delimited fields, `map<string,
string>` as repeated `{1 key, 2 value}` entries), keeping every untouched
field's bytes verbatim. Only three messages are ever decoded: `Control/Solve`
request and response, and `LLBBridge/Solve` request.

## Conclusion — the mechanism for decision 4 of `PLAN.md`

- The proxy terminates `/grpc` with `node:http2` on both sides; everything
  else, `/session` included, stays a splice.
- `Control/Solve`: exporter `name` values become the environment's private
  names. **Not** when the exporter pushes (`push=true`): that name is for a
  registry — keep it, and add the private tag after the build from the
  response's digest.
- `LLBBridge/Solve` with a frontend: inject `context:<name>` for each of the
  environment's private images, so `FROM` and `COPY --from` resolve to them.
- Because builds never produce public tags any more, *consuming* is simple:
  an image name from environment X resolves to X's private tag if it has one,
  else the verbatim (shared, pulled) name. Another environment's builds are
  never visible under a public name, so nothing has to be hidden there.
- Everything else that *produces* a tag goes through plain HTTP: `docker tag`
  (target), `commit` (`?repo=`), `load` (retag what the load stream reports),
  and pulls stay public. `docker push <name>` of a private image needs the real
  name for the registry: tag, push, untag.

## Afterwards: the output

The progress stream (`Control/Status`) and the `Solve` response carried the
private name (`naming to docker.io/domo-env-a/probechild:dev`, and the same in
`--metadata-file`). Rewriting those strings back in the bridge made both read
`docker.io/library/probechild:dev`; the probe now does it. What still differs
from a direct build is how BuildKit labels a `FROM` served by a named context
(`[context X] …`) and the step numbering after it — see `PLAN.md`.

## Not checked

`docker buildx bake` directly (compose uses the same path); `--push` builds;
multi-platform builds.
