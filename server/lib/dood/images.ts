import type { Namespace } from './names'

/**
 * How an environment's images are named on the shared daemon, and how those
 * names are turned back into the ones the agent used.
 *
 * Images are shared on purpose — a pull made by one environment is a pull
 * nobody else has to make — but a tag an environment *produces* (a build, a
 * `docker tag`, a `commit`, a `load`) is private to it, or two agents building
 * `app:dev` in parallel would each run the other's image. So every produced
 * tag is created as
 *
 *     domo-<envId>/<registry>/<path>:<tag>
 *
 * with the reference's registry kept as a path component of its own —
 * `docker.io` included, so the first component after the prefix is *always*
 * the registry and the name round-trips with no guessing. A registry is a
 * hostname and a path component is `[a-z0-9]+([._-]+[a-z0-9]+)*`, so the two
 * characters a registry may have that a path component may not are
 * encoded: its port's `:` becomes `__` (a hostname has no `_` at all, so the
 * mapping is unambiguous), and its case is folded (DNS is case-insensitive).
 * An IPv6 literal (`[::1]:5000`) cannot be spelled at all and is refused where
 * a name is produced. `app` is `domo-env_x/docker.io/library/app:latest`,
 * `ghcr.io/org/app:1` is `domo-env_x/ghcr.io/org/app:1`, and
 * `localhost:5000/app` is `domo-env_x/localhost__5000/app:latest` — every one a
 * valid reference on Docker Hub's own grammar, so the daemon stores it like any
 * other name (`docker.io/domo-env_x/…` in the containerd store).
 *
 * Consuming a name goes the other way: X's private tag if it has one, else
 * the name as given, which is the shared one. Nothing else is ever private, so
 * that is the whole rule. The agent never sees a private name: lists, inspect,
 * errors, build output and archives are rewritten on the way out.
 *
 * Pure: no Docker, no state.
 */

export interface ImageRef {
  /** Lowercased registry host, `docker.io` for Docker Hub. */
  domain: string
  /** The repository path, `library/app` on Docker Hub for an official image. */
  path: string
  tag: string | null
  digest: string | null
}

const DEFAULT_DOMAIN = 'docker.io'
const LEGACY_DOMAIN = 'index.docker.io'
const PATH_COMPONENT = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/
const TAG = /^\w[\w.-]{0,127}$/
const DIGEST = /^[a-z0-9]+(?:[.+_-][a-z0-9]+)*:[a-zA-Z0-9=_-]+$/
const DOMAIN = /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?)*|\[[a-fA-F0-9:]+\])(?::\d+)?$/
/** Docker's own limit on a repository name, registry included. */
const NAME_MAX = 255

/**
 * A reference as `docker` normalises it (`distribution/reference`'s
 * `ParseNormalizedNamed`): the first component is a registry only if it has a
 * `.` or a `:`, or is `localhost`; otherwise the name is Docker Hub's, and a
 * one-component Hub name lives under `library/`. Null for anything that is not
 * a valid reference — an image id among them — which callers then pass on
 * verbatim, so the daemon answers it in its own words.
 */
export function parseImageRef(reference: string): ImageRef | null {
  if (!reference || reference.includes('://')) return null
  let rest = reference
  let digest: string | null = null
  const at = rest.indexOf('@')
  if (at !== -1) {
    digest = rest.slice(at + 1)
    rest = rest.slice(0, at)
    if (!DIGEST.test(digest)) return null
  }
  let tag: string | null = null
  const lastSlash = rest.lastIndexOf('/')
  const colon = rest.lastIndexOf(':')
  if (colon > lastSlash) {
    tag = rest.slice(colon + 1)
    rest = rest.slice(0, colon)
    if (!TAG.test(tag)) return null
  }
  let domain = DEFAULT_DOMAIN
  let path = rest
  const slash = rest.indexOf('/')
  if (slash !== -1) {
    const first = rest.slice(0, slash)
    if (/[.:]/.test(first) || first === 'localhost' || first.toLowerCase() !== first) {
      domain = first
      path = rest.slice(slash + 1)
    }
  }
  if (!DOMAIN.test(domain)) return null
  domain = domain.toLowerCase()
  if (domain === LEGACY_DOMAIN) domain = DEFAULT_DOMAIN
  if (domain === DEFAULT_DOMAIN && !path.includes('/')) path = `library/${path}`
  if (!path.split('/').every(component => PATH_COMPONENT.test(component))) return null
  if (domain.length + 1 + path.length > NAME_MAX) return null
  return { domain, path, tag, digest }
}

const suffix = (ref: ImageRef, defaultTag: boolean) =>
  `${ref.tag ? `:${ref.tag}` : defaultTag && !ref.digest ? ':latest' : ''}${ref.digest ? `@${ref.digest}` : ''}`

/** `docker.io/library/app:dev` — how BuildKit and the containerd store spell a name. */
export function canonicalName(ref: ImageRef, defaultTag = false): string {
  return `${ref.domain}/${ref.path}${suffix(ref, defaultTag)}`
}

/** `app` for `docker.io/library/app`, `org/app` for `docker.io/org/app`; others unchanged. */
export function familiarRepo(ref: Pick<ImageRef, 'domain' | 'path'>): string {
  if (ref.domain !== DEFAULT_DOMAIN) return `${ref.domain}/${ref.path}`
  const rest = ref.path.startsWith('library/') && ref.path.split('/').length === 2 ? ref.path.slice('library/'.length) : ref.path
  return rest
}

/** `app:dev` — how `docker images` and `RepoTags` spell a name. */
export function familiarName(ref: ImageRef, defaultTag = false): string {
  return `${familiarRepo(ref)}${suffix(ref, defaultTag)}`
}

/** `domo-<envId>/`: what every private repository starts with. */
export function privatePrefix(ns: Namespace): string {
  return `domo-${ns.environmentId.toLowerCase()}/`
}

const encodeDomain = (domain: string): string | null =>
  domain.startsWith('[') ? null : domain.replaceAll(':', '__')

const decodeDomain = (component: string) => component.replaceAll('__', ':')

/**
 * The private repository for a reference (no tag): `domo-env_x/docker.io/library/app`.
 * Null when it cannot be spelled — an IPv6 registry, or a name that would
 * pass Docker's length limit once prefixed.
 */
export function privateRepo(ns: Namespace, ref: ImageRef): string | null {
  const domain = encodeDomain(ref.domain)
  if (!domain) return null
  const repo = `${privatePrefix(ns)}${domain}/${ref.path}`
  if (repo.length > NAME_MAX) return null
  return repo
}

/**
 * The private tag a produced name becomes, `latest` when none was given. Null
 * for a reference that is not a name (an id), carries a digest (a digest names
 * content, not a tag, and nothing can be tagged with one), or cannot be spelled.
 */
export function privateName(ns: Namespace, reference: string): string | null {
  const ref = parseImageRef(reference)
  if (!ref || ref.digest) return null
  const repo = privateRepo(ns, ref)
  return repo && `${repo}:${ref.tag ?? 'latest'}`
}

/** Which environment a private name belongs to, and what it stands for; null for a shared name. */
export function parsePrivateName(name: string): { environmentId: string, ref: ImageRef } | null {
  const bare = name.startsWith(`${DEFAULT_DOMAIN}/`) ? name.slice(DEFAULT_DOMAIN.length + 1) : name
  const match = bare.match(/^domo-(env_[a-z0-9]+)\/([^/]+)\/(.+)$/)
  if (!match) return null
  const inner = parseImageRef(`${decodeDomain(match[2]!)}/${match[3]!}`)
  if (!inner) return null
  return { environmentId: match[1]!, ref: inner }
}

const ownedBy = (ns: Namespace, parsed: { environmentId: string } | null) =>
  !!parsed && parsed.environmentId === ns.environmentId.toLowerCase()

/**
 * A `RepoTags` / `RepoDigests` / event name as the agent sees it: its own
 * private name unprefixed (familiar, like the daemon's own list), a shared
 * name as it is, and another environment's private name as nothing at all.
 */
export function nameForAgent(ns: Namespace, name: string): string | null {
  const parsed = parsePrivateName(name)
  if (!parsed) return name
  if (!ownedBy(ns, parsed)) return null
  return familiarName(parsed.ref)
}

/**
 * The tags of one image as the agent sees them. `shadowed` is the familiar
 * names the environment holds privately: the shared tag of the same name is
 * not the one the agent's `app:dev` means, so it is not shown under it.
 */
export function tagsForAgent(ns: Namespace, tags: unknown, shadowed: Set<string> = new Set()): string[] | unknown {
  if (!Array.isArray(tags)) return tags
  const out: string[] = []
  for (const tag of tags) {
    if (typeof tag !== 'string') continue
    const parsed = parsePrivateName(tag)
    if (parsed) {
      if (ownedBy(ns, parsed)) out.push(familiarName(parsed.ref))
      continue
    }
    const ref = parseImageRef(tag)
    if (ref && !ref.digest && shadowed.has(familiarName(ref, true))) continue
    out.push(tag)
  }
  return [...new Set(out)]
}

/** The familiar names an environment holds privately, from every tag on the daemon. */
export function privateNamesOf(ns: Namespace, tags: Iterable<string>): Set<string> {
  const names = new Set<string>()
  for (const tag of tags) {
    const parsed = parsePrivateName(tag)
    if (ownedBy(ns, parsed)) names.add(familiarName(parsed!.ref, true))
  }
  return names
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Every private name of the environment in free text — build output, an error,
 * a `Loaded image:` line, a package URL — put back as the agent would have
 * seen it with a daemon of its own. BuildKit and the containerd store write a
 * name in its canonical form (`docker.io/domo-env_x/docker.io/library/app:dev`),
 * which becomes `docker.io/library/app:dev`, exactly what a direct build
 * prints; anywhere else it is the familiar form (`app:dev`), as `docker`
 * prints it.
 */
export function unprivateText(ns: Namespace, text: string): string {
  const prefix = privatePrefix(ns)
  if (!text.includes(prefix)) return text
  const pattern = new RegExp(
    `(${escapeRegExp(DEFAULT_DOMAIN)}/)?${escapeRegExp(prefix)}([a-z0-9][a-z0-9._-]*)/([a-z0-9]+(?:(?:[._/]|__|-+)[a-z0-9]+)*)`,
    'g'
  )
  return text.replace(pattern, (whole, canonical: string | undefined, domain: string, path: string) => {
    const ref = parseImageRef(`${decodeDomain(domain)}/${path}`)
    if (!ref) return whole
    return canonical ? `${ref.domain}/${ref.path}` : familiarRepo(ref)
  })
}

/**
 * A `docker images <pattern>` reference filter, as the daemon applies it:
 * `path.Match` against the familiar name with its tag, then without it. `*`
 * and `?` stop at a `/`.
 */
export function referenceMatches(pattern: string, name: string): boolean {
  const matcher = globToRegExp(pattern)
  if (!matcher) return false
  if (matcher.test(name)) return true
  const ref = parseImageRef(name)
  return !!ref && matcher.test(familiarRepo(ref))
}

function globToRegExp(pattern: string): RegExp | null {
  let source = '^'
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index]!
    if (char === '*') source += '[^/]*'
    else if (char === '?') source += '[^/]'
    else if (char === '\\' && index + 1 < pattern.length) source += escapeRegExp(pattern[++index]!)
    else if (char === '[') {
      const end = pattern.indexOf(']', index + 1)
      if (end === -1) return null
      let set = pattern.slice(index + 1, end)
      if (set.startsWith('^')) set = `!${set.slice(1)}`
      source += set.startsWith('!') ? `[^${set.slice(1).replaceAll('\\', '\\\\')}]` : `[${set.replaceAll('\\', '\\\\')}]`
      index = end
    } else source += escapeRegExp(char)
  }
  try {
    return new RegExp(`${source}$`)
  } catch {
    return null
  }
}

/**
 * The BuildKit source-policy rules that make a build resolve an image name the
 * environment holds privately to its private tag: one `CONVERT` rule per
 * private name, matching the canonical `docker-image://` identifier with or
 * without the digest the frontend pins after resolving it.
 *
 * A source policy rather than the named build contexts the spike used,
 * because a named context is looked up for *stage names* too
 * (`dockerfile2llb` asks `NamedContext(st.Name)` for every `FROM … AS <name>`)
 * — an environment holding `app:latest` would have had every Dockerfile stage
 * called `app` silently replaced by that image. A policy only ever converts an
 * image *source*, and the frontend still names the vertex after what the
 * Dockerfile said, so the output reads exactly as a direct build's.
 */
export function sourcePolicyRules(ns: Namespace, privateTags: Iterable<string>): Array<{ from: string, to: string }> {
  const rules: Array<{ from: string, to: string }> = []
  const seen = new Set<string>()
  for (const tag of privateTags) {
    const parsed = parsePrivateName(tag)
    if (!ownedBy(ns, parsed) || !parsed!.ref.tag) continue
    const original = canonicalName(parsed!.ref)
    if (seen.has(original)) continue
    seen.add(original)
    const repo = privateRepo(ns, parsed!.ref)
    if (!repo) continue
    rules.push({
      from: `^docker-image://${escapeRegExp(original)}(@sha256:[a-f0-9]{64})?$`,
      to: `docker-image://${DEFAULT_DOMAIN}/${repo}:${parsed!.ref.tag}\${1}`
    })
  }
  return rules
}
