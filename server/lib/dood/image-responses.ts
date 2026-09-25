import {
  canonicalName,
  familiarName,
  familiarRepo,
  nameForAgent,
  parseImageRef,
  parsePrivateName,
  privateName,
  privateNamesOf,
  privateRepo,
  referenceMatches,
  tagsForAgent,
  unprivateText,
  type ImageRef
} from './images'
import type { Namespace } from './names'
import type { ArchiveNames } from './tar'

/**
 * What the agent is shown of images: the daemon's answers with its own private
 * names unprefixed and every other environment's taken out. Pure functions
 * over parsed JSON, like `responses.ts` beside it.
 */

type Json = Record<string, any>

const isObject = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value)

/** Where the image name a container was created from is kept, when the proxy gave the daemon a private one. */
export const REQUESTED_IMAGE_LABEL = 'domo.image'

/** Every string inside a JSON value, rewritten — for progress streams whose shape varies by message. */
export function deepText(value: unknown, rewrite: (text: string) => string): unknown {
  if (typeof value === 'string') return rewrite(value)
  if (Array.isArray(value)) return value.map(item => deepText(item, rewrite))
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, deepText(item, rewrite)]))
  return value
}

/** An image's own tags before any are hidden: a `<none>:<none>` placeholder is not a tag. */
const realTags = (tags: unknown): string[] =>
  Array.isArray(tags) ? tags.filter((tag): tag is string => typeof tag === 'string' && tag !== '<none>:<none>') : []

const realDigests = (digests: unknown): string[] =>
  Array.isArray(digests) ? digests.filter((digest): digest is string => typeof digest === 'string' && digest !== '<none>@<none>') : []

function digestsForAgent(ns: Namespace, digests: unknown): unknown {
  if (!Array.isArray(digests)) return digests
  return realDigests(digests).map(digest => nameForAgent(ns, digest)).filter((digest): digest is string => digest !== null)
}

export interface ImageListOptions {
  /** The familiar names the environment holds privately (`privateNamesOf`), whose shared namesakes are hidden. */
  shadowed: Set<string>
  /** `reference` filters the proxy applies itself, since the daemon only knows the private names. */
  references?: string[]
}

/**
 * One image of `GET /images/json` (and `system df`), or null to hide it. An
 * image whose tags were all someone else's is hidden entirely — shown with none
 * it would look like the agent's own dangling image. One that never had a tag
 * is shown: dangling images are everyone's garbage, and `image prune` may
 * collect them.
 */
export function imageSummaryForAgent(ns: Namespace, entry: unknown, options: ImageListOptions): unknown | null {
  if (!isObject(entry)) return entry
  const before = realTags(entry.RepoTags)
  let tags = tagsForAgent(ns, before, options.shadowed) as string[]
  if (before.length && !tags.length) return null
  let digests = digestsForAgent(ns, entry.RepoDigests)
  if (options.references?.length) {
    // As the daemon does it: only the names that matched are listed, digests included.
    const matches = (name: string) => options.references!.some(pattern => referenceMatches(pattern, name))
    tags = tags.filter(matches)
    if (!tags.length) return null
    if (Array.isArray(digests)) digests = digests.filter((digest: string) => matches(digest.split('@')[0]!))
  }
  return {
    ...entry,
    RepoTags: before.length ? tags : entry.RepoTags,
    RepoDigests: digests
  }
}

export function imageListForAgent(ns: Namespace, body: unknown, options: Omit<ImageListOptions, 'shadowed'> & { shadowed?: Set<string> }): unknown {
  if (!Array.isArray(body)) return body
  const shadowed = options.shadowed ?? privateNamesOf(ns, body.flatMap(entry => realTags(entry?.RepoTags)))
  return body.map(entry => imageSummaryForAgent(ns, entry, { ...options, shadowed })).filter(entry => entry !== null)
}

/** `GET /images/{name}/json`. */
export function imageInspectForAgent(ns: Namespace, body: unknown): unknown {
  if (!isObject(body)) return body
  return {
    ...body,
    RepoTags: realTags(body.RepoTags).length ? tagsForAgent(ns, realTags(body.RepoTags)) : body.RepoTags,
    RepoDigests: digestsForAgent(ns, body.RepoDigests)
  }
}

/** `GET /images/{name}/history`: each layer's `Tags`. */
export function imageHistoryForAgent(ns: Namespace, body: unknown): unknown {
  if (!Array.isArray(body)) return body
  return body.map(entry => isObject(entry) && Array.isArray(entry.Tags) ? { ...entry, Tags: tagsForAgent(ns, entry.Tags) } : entry)
}

/** `DELETE /images/{name}` and `image prune`: `Untagged` names. */
export function imageDeleteForAgent(ns: Namespace, body: unknown): unknown {
  const entries = Array.isArray(body) ? body : isObject(body) && Array.isArray(body.ImagesDeleted) ? body.ImagesDeleted : null
  if (!entries) return body
  const rewritten = entries
    .map((entry: unknown) => {
      if (!isObject(entry) || typeof entry.Untagged !== 'string') return entry
      const name = nameForAgent(ns, entry.Untagged)
      return name === null ? null : { ...entry, Untagged: name }
    })
    .filter((entry: unknown) => entry !== null)
  return Array.isArray(body) ? rewritten : { ...(body as Json), ImagesDeleted: rewritten }
}

/** `GET /system/df`: its `Images`, as `docker images` would show them. */
export function systemDfImagesForAgent(ns: Namespace, body: unknown): unknown {
  if (!isObject(body)) return body
  const out: Json = { ...body }
  if (Array.isArray(out.Images)) out.Images = imageListForAgent(ns, out.Images, {})
  // API 1.52 and later, with `verbose`.
  if (isObject(out.ImageUsage) && Array.isArray(out.ImageUsage.Items)) {
    out.ImageUsage = { ...out.ImageUsage, Items: imageListForAgent(ns, out.ImageUsage.Items, {}) }
  }
  return out
}

/** `Config.Image` in container inspect, `Image` in `docker ps`: what the client asked for. */
export function containerImageForAgent(ns: Namespace, body: unknown): unknown {
  if (!isObject(body)) return body
  const labels = body.Config?.Labels ?? body.Labels
  const requested = isObject(labels) && typeof labels[REQUESTED_IMAGE_LABEL] === 'string' ? labels[REQUESTED_IMAGE_LABEL] as string : null
  if (isObject(body.Config)) {
    const image = requested ?? (typeof body.Config.Image === 'string' ? unprivateText(ns, body.Config.Image) : body.Config.Image)
    return { ...body, Config: { ...body.Config, Image: image } }
  }
  if (typeof body.Image === 'string') return { ...body, Image: requested ?? unprivateText(ns, body.Image) }
  return body
}

export function containerListImagesForAgent(ns: Namespace, body: unknown): unknown {
  return Array.isArray(body) ? body.map(entry => containerImageForAgent(ns, entry)) : body
}

/**
 * One `GET /events` line. Image events name the image (`Actor.ID` for a
 * pull, `name` for a tag): another environment's private name is dropped,
 * the environment's own is unprefixed. A container's `image` attribute is
 * the name it was created from, private when the proxy made it so.
 */
export function imageEventForAgent(ns: Namespace, event: unknown): unknown | null {
  if (!isObject(event)) return event
  const actor: Json = isObject(event.Actor) ? event.Actor : {}
  const attributes: Json = isObject(actor.Attributes) ? actor.Attributes : {}
  const type = String(event.Type ?? '')
  if (type === 'image') {
    for (const value of [actor.ID, attributes.name, event.id, event.from]) {
      if (typeof value !== 'string') continue
      const parsed = parsePrivateName(value)
      if (parsed && nameForAgent(ns, value) === null) return null
    }
  }
  if (type !== 'image' && type !== 'container') return event
  const rewrite = (value: unknown) => typeof value === 'string' ? unprivateText(ns, value) : value
  const requested = typeof attributes[REQUESTED_IMAGE_LABEL] === 'string' ? attributes[REQUESTED_IMAGE_LABEL] : null
  const out: Json = {
    ...event,
    Actor: {
      ...actor,
      ID: rewrite(actor.ID),
      Attributes: Object.fromEntries(Object.entries(attributes).map(([key, value]) =>
        [key, type === 'container' && key === 'image' && requested ? requested : rewrite(value)]))
    }
  }
  if (typeof event.id === 'string') out.id = rewrite(event.id)
  if (typeof event.from === 'string') out.from = type === 'container' && requested ? requested : rewrite(event.from)
  return out
}

/** Names in an image archive, in both directions (`tar.ts` does the tar). */
function archiveNames(mapName: (name: string, canonical: boolean) => string | null, mapRepo: (repo: string) => string | null): ArchiveNames {
  return {
    rewrite(file, json) {
      if (file === 'manifest.json' && Array.isArray(json)) {
        return json.map(entry => isObject(entry) && Array.isArray(entry.RepoTags)
          ? { ...entry, RepoTags: entry.RepoTags.map((tag: string) => mapName(tag, false)).filter((tag: string | null) => tag !== null) }
          : entry)
      }
      if (file === 'index.json' && isObject(json) && Array.isArray(json.manifests)) {
        return {
          ...json,
          manifests: json.manifests.map((manifest: unknown) => {
            if (!isObject(manifest) || !isObject(manifest.annotations)) return manifest
            const annotations = Object.entries(manifest.annotations).flatMap(([key, value]) => {
              // `ref.name` is often only a tag; only a whole name is one.
              const named = key === 'io.containerd.image.name' || (key === 'org.opencontainers.image.ref.name' && /[/:]/.test(String(value)))
              if (!named || typeof value !== 'string') return [[key, value]]
              const mapped = mapName(value, true)
              return mapped === null ? [] : [[key, mapped]]
            })
            return { ...manifest, annotations: Object.fromEntries(annotations) }
          })
        }
      }
      if (file === 'repositories' && isObject(json)) {
        return Object.fromEntries(Object.entries(json)
          .map(([repo, tags]) => [mapRepo(repo), tags] as const)
          .filter(([repo]) => repo !== null))
      }
      return null
    }
  }
}

/** `docker save`: the environment's private names become the ones it asked for; nobody else's leave. */
export function archiveNamesForAgent(ns: Namespace): ArchiveNames {
  const forAgent = (name: string, canonical: boolean) => {
    const parsed = parsePrivateName(name)
    if (!parsed) return name
    if (nameForAgent(ns, name) === null) return null
    return canonical ? canonicalName(parsed.ref) : familiarName(parsed.ref)
  }
  return archiveNames(forAgent, (repo) => {
    const parsed = parsePrivateName(repo)
    if (!parsed) return repo
    return nameForAgent(ns, repo) === null ? null : familiarRepo(parsed.ref)
  })
}

/**
 * `docker load`: every name in the archive becomes the environment's private
 * one, so a load never moves a shared tag — the one another environment, or
 * the host, already has under that name stays where it was. `unnamed` is
 * told about a name that cannot be made private (an IPv6 registry), which is
 * then left as it is.
 */
export function archiveNamesForDaemon(ns: Namespace, unnamed?: (name: string) => void): ArchiveNames {
  const toPrivate = (name: string, canonical: boolean) => {
    if (parsePrivateName(name)) return name
    const ref = parseImageRef(name)
    const privateTag = ref && !ref.digest ? privateName(ns, name) : null
    if (!privateTag) {
      unnamed?.(name)
      return name
    }
    return canonical ? `docker.io/${privateTag}` : privateTag
  }
  return archiveNames(toPrivate, (repo) => {
    const ref = parseImageRef(repo)
    const privateRepoName = ref && privateRepo(ns, ref as ImageRef)
    if (!privateRepoName) {
      unnamed?.(repo)
      return repo
    }
    return privateRepoName
  })
}
