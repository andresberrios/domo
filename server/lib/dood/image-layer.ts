import { rewriteSolveRequest, rewriteSolveResponse, rewriteStatus, solveResponseEntries, PRUNE, SOLVE, STATUS } from './buildkit'
import type { EngineClient } from './engine'
import { bridgeGrpc, GRPC, GrpcError, type CallRewrite } from './grpc-bridge'
import { headerValue, type DoodRequest } from './http'
import {
  archiveNamesForAgent,
  archiveNamesForDaemon,
  containerImageForAgent,
  containerListImagesForAgent,
  deepText,
  imageDeleteForAgent,
  imageEventForAgent,
  imageHistoryForAgent,
  imageInspectForAgent,
  imageListForAgent,
  REQUESTED_IMAGE_LABEL,
  systemDfImagesForAgent
} from './image-responses'
import {
  nameForAgent,
  parseImageRef,
  parsePrivateName,
  privateName,
  privateNamesOf,
  privatePrefix,
  sourcePolicyRules,
  unprivateText
} from './images'
import { answer, withResponse, type DoodLayer, type Next, type Outcome } from './layers'
import type { Namespace } from './names'
import { domoError, parseFilters, renderFilters } from './scope'
import { archiveRewriter } from './tar'

/**
 * The layer that gives an environment its own image tags on the shared daemon
 * (see `images.ts` for the naming): every tag it *produces* is created under
 * its private repository, every name it *consumes* resolves to its private
 * tag first, and every answer is rewritten so the agent only ever sees the
 * names it used.
 *
 * Producing: a build (`/grpc`, bridged in `grpc-bridge.ts`, or the legacy
 * `POST /build`), `docker tag`, `commit`, `load`, `import`. Consuming:
 * container create, inspect, history, save, push, `rmi`, a tag's source, and
 * — through a BuildKit source policy — a build's `FROM`. Pulls stay shared.
 *
 * Placed inside the scope layer, so a container reference in `commit` is
 * already resolved and this layer's transforms see the daemon's answers
 * before the scope layer hides the `domo.*` labels it reads.
 */

/** The label the scope layer stamps on every container an environment creates (`manager.ts`). */
const ENVIRONMENT_LABEL = 'domo.env'

export interface ImageLayerOptions {
  ns: Namespace
  engine: EngineClient
  onError?(error: unknown): void
}

type Json = Record<string, any>

const PRUNE_REFUSAL = 'the build cache is shared by every environment on this daemon, so it cannot be pruned from inside one. '
  + 'Prune it from the host if you mean to.'

const imagePath = (name: string) => name.split('/').map(encodeURIComponent).join('/')

const json = (body: Buffer | null): unknown => {
  if (!body?.length) return {}
  try {
    return JSON.parse(body.toString('utf8'))
  } catch {
    return undefined
  }
}

const withBody = (request: DoodRequest, body: unknown): DoodRequest =>
  ({ ...request, body: Buffer.from(JSON.stringify(body), 'utf8') })

function splitName(name: string): { repo: string, tag: string } {
  const colon = name.lastIndexOf(':')
  return { repo: name.slice(0, colon), tag: name.slice(colon + 1) }
}

/** `/images/<name>/<action>`: the name may itself hold slashes (`ghcr.io/org/app`). */
function imageRoute(path: string, method: string): { name: string, action: string } | null {
  if (!path.startsWith('/images/')) return null
  const rest = path.slice('/images/'.length)
  const decode = (text: string) => text.split('/').map(segment => decodeURIComponent(segment)).join('/')
  if (method === 'DELETE') return rest ? { name: decode(rest), action: 'delete' } : null
  const slash = rest.lastIndexOf('/')
  if (slash <= 0) return null
  const action = rest.slice(slash + 1)
  if (!['json', 'history', 'get', 'push', 'tag'].includes(action)) return null
  return { name: decode(rest.slice(0, slash)), action }
}

export function imageLayer(options: ImageLayerOptions): DoodLayer {
  const { ns, engine } = options
  const report = (error: unknown) => options.onError?.(error)
  const unprivate = (text: string) => unprivateText(ns, text)

  const exists = async (name: string) =>
    (await engine.request('GET', `/images/${imagePath(name)}/json`)).status === 200

  const inspect = async (name: string): Promise<Json | null> => {
    const response = await engine.request('GET', `/images/${imagePath(name)}/json`)
    return response.status === 200 ? response.body : null
  }

  /** A name as the environment means it: its private tag when it has one, else the name as given (shared). */
  const resolve = async (reference: string): Promise<{ name: string, isPrivate: boolean }> => {
    const privateTag = privateName(ns, reference)
    if (privateTag && await exists(privateTag)) return { name: privateTag, isPrivate: true }
    return { name: reference, isPrivate: false }
  }

  /** Every tag on the daemon. The private ones are read out of it; a list is one round trip on a local socket. */
  const allTags = async (): Promise<string[]> => {
    const response = await engine.request('GET', '/images/json')
    if (response.status !== 200 || !Array.isArray(response.body)) return []
    return response.body.flatMap((image: Json) => Array.isArray(image.RepoTags) ? image.RepoTags : [])
  }

  const tag = async (source: string, target: string) => {
    const { repo, tag } = splitName(target)
    const response = await engine.request('POST', `/images/${imagePath(source)}/tag?repo=${encodeURIComponent(repo)}&tag=${encodeURIComponent(tag)}`)
    if (response.status >= 300) throw new Error(`could not tag ${source} as ${target}: ${response.body?.message ?? response.status}`)
  }

  const untag = async (name: string) => {
    const response = await engine.request('DELETE', `/images/${imagePath(name)}?noprune=1`)
    if (response.status >= 300 && response.status !== 404) {
      throw new Error(`could not untag ${name}: ${response.body?.message ?? response.status}`)
    }
  }

  /** The private name for a name the environment produces, or the loud answer when it has none. */
  const producedName = (name: string): { name: string } | { refusal: Outcome } => {
    const privateTag = privateName(ns, name)
    if (privateTag) return { name: privateTag }
    return {
      refusal: answer(400, domoError(`${name} cannot be given a name of this environment's own on the shared daemon `
        + '(an IPv6 registry, a digest, or a name too long once prefixed), so it is not tagged. Use a registry host name.'))
    }
  }

  const unprivateLines = (line: unknown) => deepText(line, unprivate)

  // ---- builds -------------------------------------------------------------

  /** One `/grpc` channel's calls: the three that carry image names, and the prune that is refused. */
  const buildRewrites = (path: string): CallRewrite | null => {
    if (path === PRUNE) return { refuse: new GrpcError(GRPC.PERMISSION_DENIED, `Domo: ${PRUNE_REFUSAL}`) }
    if (path === STATUS) return { response: message => rewriteStatus(message, unprivate), statusMessage: unprivate }
    if (path !== SOLVE) return null

    /** A pushed name's shared tag before the build: the push tags it locally, and it is put back after. */
    const pushed = new Map<string, string | null>()
    return {
      async request(message) {
        const rules = sourcePolicyRules(ns, await allTags())
        const edit = rewriteSolveRequest(message, {
          privateName(name) {
            const privateTag = privateName(ns, name)
            if (!privateTag) {
              throw new GrpcError(GRPC.INVALID_ARGUMENT, `Domo: ${name} cannot be given a name of this environment's own on the shared daemon `
                + '(an IPv6 registry, or a name too long once prefixed), so the build would tag a name every environment shares. Use a registry host name.')
            }
            return privateTag
          }
        }, rules)
        for (const name of edit.pushed) {
          const before = await inspect(name)
          pushed.set(name, typeof before?.Id === 'string' ? before.Id : null)
        }
        return edit.message
      },
      async response(message) {
        if (pushed.size) {
          const image = solveResponseEntries(message).get('containerimage.config.digest')
          for (const [name, before] of pushed) {
            const privateTag = privateName(ns, name)
            if (!privateTag || !image) continue
            try {
              await tag(image, privateTag)
              // The shared tag the push made is put back as it was: moved back, or gone.
              if (before === null) await untag(name)
              else if (before !== image) await tag(before, name)
            } catch (error) {
              throw new GrpcError(GRPC.INTERNAL, `Domo: the build was pushed, but its local copy could not be tagged as ${name} `
                + `for this environment: ${error instanceof Error ? error.message : String(error)}`)
            }
          }
        }
        return rewriteSolveResponse(message, unprivate)
      },
      statusMessage: unprivate
    }
  }

  /** The legacy builder (`POST /build`, `DOCKER_BUILDKIT=0`, and API clients): `t` and `cachefrom`. */
  const legacyBuild = async (request: DoodRequest, next: Next): Promise<Outcome> => {
    const query = new URLSearchParams(request.query)
    const tags = query.getAll('t')
    if (tags.length) {
      query.delete('t')
      for (const name of tags) {
        const produced = producedName(name)
        if ('refusal' in produced) return produced.refusal
        query.append('t', produced.name)
      }
    }
    const cacheFrom = query.get('cachefrom')
    if (cacheFrom) {
      try {
        const names = JSON.parse(cacheFrom)
        if (Array.isArray(names)) {
          query.set('cachefrom', JSON.stringify(await Promise.all(names.map(async (name: unknown) =>
            typeof name === 'string' ? (await resolve(name)).name : name))))
        }
      } catch { /* the daemon's own error */ }
    }
    return withResponse(await next({ ...request, query }), { line: unprivateLines })
  }

  // ---- the image endpoints -----------------------------------------------

  const list = async (request: DoodRequest, next: Next): Promise<Outcome> => {
    const filters = parseFilters(request.query.get('filters'))
    const references = filters.reference ?? []
    delete filters.reference
    const query = new URLSearchParams(request.query)
    if (Object.keys(filters).length) query.set('filters', renderFilters(filters))
    else query.delete('filters')
    // A filtered list may leave out the private image that shadows a shared one.
    const shadowed = Object.keys(filters).length ? privateNamesOf(ns, await allTags()) : undefined
    return withResponse(await next({ ...request, query }), {
      json: body => imageListForAgent(ns, body, { references, ...(shadowed && { shadowed }) })
    })
  }

  /**
   * `rmi`. The environment's own tag goes as asked. A shared name may go too —
   * a real machine allows it, and what it costs is a pull — but only when no
   * container outside this environment runs on that image, and never forced.
   * The daemon's own check is not enough on its own: it refuses to delete an
   * image a container uses, but *untagging* a name the image has others of is
   * always allowed, and on a shared daemon those others may be another
   * environment's private names — measured, `rmi alpine:3` from one
   * environment took the tag away from the host's own containers while
   * another environment held a private tag on the same image. By id, the
   * image goes only when this environment's names are all it has; one another
   * environment also names loses this environment's names and nothing else.
   */
  const remove = async (request: DoodRequest, next: Next, name: string): Promise<Outcome> => {
    const resolved = await resolve(name)
    const forget = (outcome: Outcome) => withResponse(outcome, { json: body => imageDeleteForAgent(ns, body) })
    if (resolved.isPrivate) return forget(await next({ ...request, path: `/images/${imagePath(resolved.name)}` }))

    const image = await inspect(name)
    // Not there: the daemon says so in its own words.
    if (!image) return next(request)
    const tags: string[] = Array.isArray(image.RepoTags) ? image.RepoTags : []
    const own = tags.filter(tag => parsePrivateName(tag) && nameForAgent(ns, tag) !== null)
    const shared = tags.filter(tag => !parsePrivateName(tag))
    const id = String(image.Id ?? '')
    const byId = id === name || (/^(sha256:)?[0-9a-f]+$/.test(name) && id.replace(/^sha256:/, '').startsWith(name.replace(/^sha256:/, '')))

    if (byId && tags.length && !shared.length) {
      // Only other environments' names: invisible here, so not there.
      if (!own.length) return answer(404, { message: `No such image: ${name}` })
      if (own.length === tags.length) return forget(await next(request))
      for (const tag of own) await untag(tag)
      return answer(200, own.map(tag => ({ Untagged: nameForAgent(ns, tag) })))
    }
    const users = await containersOutside(id)
    if (users.length) {
      return answer(409, domoError(`${name} is shared with the host and the other environments on this daemon, and `
        + `${users.length === 1 ? 'a container' : `${users.length} containers`} outside this environment `
        + `${users.length === 1 ? 'runs' : 'run'} on it, so it is not removed from inside one.`))
    }
    const query = new URLSearchParams(request.query)
    query.delete('force')
    return forget(await next({ ...request, query }))
  }

  /** Containers on the daemon, other than this environment's own, created from an image. */
  const containersOutside = async (imageId: string): Promise<string[]> => {
    const response = await engine.request('GET', '/containers/json?all=1')
    if (response.status !== 200 || !Array.isArray(response.body)) {
      throw new Error(`could not list the daemon's containers: ${response.body?.message ?? response.status}`)
    }
    return response.body
      .filter((container: Json) => container.ImageID === imageId && container.Labels?.[ENVIRONMENT_LABEL] !== ns.environmentId)
      .map((container: Json) => String(container.Id))
  }

  const push = async (request: DoodRequest, next: Next, repo: string): Promise<Outcome> => {
    const tagName = request.query.get('tag')
    if (!tagName) {
      const prefix = privatePrefix(ns)
      const repoRef = parseImageRef(repo)
      const held = (await allTags()).some((tag) => {
        const parsed = parsePrivateName(tag)
        return tag.startsWith(prefix) && parsed && repoRef && parsed.ref.domain === repoRef.domain && parsed.ref.path === repoRef.path
      })
      if (held) {
        return answer(400, domoError(`\`docker push --all-tags ${repo}\` would push the tags every environment shares, not this `
          + 'environment\'s own. Push each tag by name.'))
      }
      return withResponse(await next(request), { line: unprivateLines })
    }
    const name = `${repo}${tagName.startsWith('sha256:') ? '@' : ':'}${tagName}`
    const resolved = await resolve(name)
    if (!resolved.isPrivate) return withResponse(await next(request), { line: unprivateLines })
    // The registry needs the real name: it is tagged for the push and put back as it was afterwards.
    const before = await inspect(name)
    await tag(resolved.name, name)
    return withResponse(await next(request), {
      line: unprivateLines,
      after: async () => {
        if (before && typeof before.Id === 'string') await tag(before.Id, name)
        else await untag(name)
      }
    })
  }

  /** `POST /images/create`: a pull stays shared; an import is produced. */
  const create = async (request: DoodRequest, next: Next): Promise<Outcome> => {
    const query = new URLSearchParams(request.query)
    if (query.get('fromSrc')) {
      const repo = query.get('repo')
      if (!repo) return next(request)
      const tagName = query.get('tag')
      const produced = producedName(tagName ? `${repo}:${tagName}` : repo)
      if ('refusal' in produced) return produced.refusal
      const { repo: privateRepoName, tag: privateTag } = splitName(produced.name)
      query.set('repo', privateRepoName)
      query.set('tag', privateTag)
      return withResponse(await next({ ...request, query }), { line: unprivateLines })
    }
    const image = query.get('fromImage')
    const tagName = query.get('tag')
    if (!image || (!tagName && !parseImageRef(image)?.tag)) return next(request)
    const name = tagName ? `${image}${tagName.startsWith('sha256:') ? '@' : ':'}${tagName}` : image
    const privateTag = privateName(ns, name)
    if (!privateTag || !(await exists(privateTag))) return next(request)
    // A pull replaces what the name means on a real machine: the private tag
    // the environment had moves to what was pulled, once the pull succeeded.
    let failed = false
    return withResponse(await next(request), {
      line: (line) => {
        if (line && typeof line === 'object' && ('error' in line || 'errorDetail' in line)) failed = true
        return line
      },
      after: async (status) => {
        if (status === 200 && !failed) await tag(name, privateTag)
      }
    })
  }

  const containerCreate = async (request: DoodRequest, next: Next): Promise<Outcome> => {
    const spec = json(request.body) as Json | undefined
    if (!spec || typeof spec.Image !== 'string' || !spec.Image) return next(request)
    const resolved = await resolve(spec.Image)
    if (!resolved.isPrivate) return next(request)
    return next(withBody(request, {
      ...spec,
      Image: resolved.name,
      Labels: { ...(spec.Labels ?? {}), [REQUESTED_IMAGE_LABEL]: spec.Image }
    }))
  }

  return {
    wantsBody(request) {
      return request.method === 'POST' && request.path === '/containers/create'
    },

    async handle(request, next) {
      const { method, path } = request

      if (method === 'POST' && path === '/grpc' && headerValue(request.headers, 'upgrade')) {
        return withResponse(await next(request), {
          hijack: (client, daemon) => bridgeGrpc(client, daemon, { rewrites: buildRewrites, onError: report })
        })
      }
      if (method === 'POST' && path === '/build') return legacyBuild(request, next)
      if (method === 'POST' && path === '/containers/create') return containerCreate(request, next)
      if (method === 'GET' && path === '/containers/json') {
        return withResponse(await next(request), { json: body => containerListImagesForAgent(ns, body) })
      }
      if (method === 'GET' && /^\/containers\/[^/]+\/json$/.test(path)) {
        return withResponse(await next(request), { json: body => containerImageForAgent(ns, body) })
      }
      if (method === 'GET' && path === '/events') {
        return withResponse(await next(request), { line: event => imageEventForAgent(ns, event) })
      }
      if (method === 'GET' && path === '/system/df') {
        return withResponse(await next(request), { json: body => systemDfImagesForAgent(ns, body) })
      }
      if (method === 'POST' && path === '/commit') {
        const repo = request.query.get('repo')
        if (!repo) return next(request)
        const tagName = request.query.get('tag')
        const produced = producedName(tagName ? `${repo}:${tagName}` : repo)
        if ('refusal' in produced) return produced.refusal
        const query = new URLSearchParams(request.query)
        const target = splitName(produced.name)
        query.set('repo', target.repo)
        query.set('tag', target.tag)
        return next({ ...request, query })
      }
      if (method === 'GET' && path === '/images/json') return list(request, next)
      if (method === 'POST' && path === '/images/create') return create(request, next)
      if (method === 'POST' && path === '/images/load') {
        const archive = archiveNamesForDaemon(ns, name => report(new Error(`a loaded image kept the shared name ${name}: it cannot be made private`)))
        const outcome = await next(request)
        if (outcome.kind !== 'forward') return outcome
        return withResponse({ ...outcome, requestBody: archiveRewriter(archive, report) }, { line: unprivateLines })
      }
      if (method === 'POST' && path === '/images/prune') {
        return withResponse(await next(request), { json: body => imageDeleteForAgent(ns, body) })
      }
      if (method === 'GET' && path === '/images/get') {
        const names = request.query.getAll('names')
        const query = new URLSearchParams(request.query)
        query.delete('names')
        for (const name of names) query.append('names', (await resolve(name)).name)
        return withResponse(await next({ ...request, query }), { stream: () => archiveRewriter(archiveNamesForAgent(ns), report) })
      }

      const route = imageRoute(path, method)
      if (!route) return next(request)
      switch (route.action) {
        case 'delete':
          return remove(request, next, route.name)
        case 'push':
          return push(request, next, route.name)
        case 'tag': {
          const repo = request.query.get('repo')
          const source = await resolve(route.name)
          const forwarded = { ...request, path: `/images/${imagePath(source.name)}/tag` }
          if (!repo) return next(forwarded)
          const tagName = request.query.get('tag')
          const produced = producedName(tagName ? `${repo}:${tagName}` : repo)
          if ('refusal' in produced) return produced.refusal
          const target = splitName(produced.name)
          const query = new URLSearchParams(request.query)
          query.set('repo', target.repo)
          query.set('tag', target.tag)
          return next({ ...forwarded, query })
        }
        default: {
          const source = await resolve(route.name)
          const outcome = await next({ ...request, path: `/images/${imagePath(source.name)}/${route.action}` })
          if (route.action === 'json') return withResponse(outcome, { json: body => imageInspectForAgent(ns, body) })
          if (route.action === 'history') return withResponse(outcome, { json: body => imageHistoryForAgent(ns, body) })
          if (route.action === 'get') return withResponse(outcome, { stream: () => archiveRewriter(archiveNamesForAgent(ns), report) })
          return outcome
        }
      }
    }
  }
}

/** Every tag an environment made, for the retirement sweep. */
export function privateTagsOf(ns: Namespace, tags: Iterable<string>): string[] {
  const prefix = privatePrefix(ns)
  return [...new Set([...tags].filter(tag => tag.startsWith(prefix) || tag.startsWith(`docker.io/${prefix}`)))]
}
