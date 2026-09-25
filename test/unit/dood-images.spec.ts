import { describe, expect, it } from 'vitest'

import {
  canonicalName,
  familiarName,
  nameForAgent,
  parseImageRef,
  parsePrivateName,
  privateName,
  privateNamesOf,
  referenceMatches,
  sourcePolicyRules,
  tagsForAgent,
  unprivateText
} from '../../server/lib/dood/images'
import { namespaceFor } from '../../server/lib/dood/names'

/**
 * How an environment's image names are made private and taken back: every
 * reference shape Docker accepts, round-tripped.
 */

const ns = namespaceFor('env_abc123')
const other = namespaceFor('env_def456')

describe('references, as docker normalises them', () => {
  it.each([
    ['app', 'docker.io', 'library/app', null],
    ['app:dev', 'docker.io', 'library/app', 'dev'],
    ['org/app:1.2', 'docker.io', 'org/app', '1.2'],
    ['docker.io/library/app:dev', 'docker.io', 'library/app', 'dev'],
    ['index.docker.io/org/app', 'docker.io', 'org/app', null],
    ['ghcr.io/org/team/app:tag', 'ghcr.io', 'org/team/app', 'tag'],
    ['localhost:5000/app', 'localhost:5000', 'app', null],
    ['localhost/app:x', 'localhost', 'app', 'x'],
    ['GHCR.IO/org/app', 'ghcr.io', 'org/app', null],
    ['[::1]:5000/app:1', '[::1]:5000', 'app', '1']
  ])('%s', (reference, domain, path, tag) => {
    expect(parseImageRef(reference)).toEqual({ domain, path, tag, digest: null })
  })

  it('keeps a digest, and refuses what is not a reference', () => {
    expect(parseImageRef(`app@sha256:${'a'.repeat(64)}`)).toMatchObject({ path: 'library/app', digest: `sha256:${'a'.repeat(64)}` })
    for (const bad of ['', 'App', 'org/App', 'a//b', 'docker-image://app', 'app:bad tag', 'app@nodigest']) {
      expect(parseImageRef(bad), bad).toBeNull()
    }
  })

  it('spells a name the way docker and BuildKit each print it', () => {
    const ref = parseImageRef('app:dev')!
    expect(familiarName(ref)).toBe('app:dev')
    expect(canonicalName(ref)).toBe('docker.io/library/app:dev')
    expect(familiarName(parseImageRef('org/app')!, true)).toBe('org/app:latest')
    expect(familiarName(parseImageRef('localhost:5000/app:1')!)).toBe('localhost:5000/app:1')
  })
})

describe('private names', () => {
  it.each([
    ['app', 'domo-env_abc123/docker.io/library/app:latest', 'app:latest'],
    ['app:dev', 'domo-env_abc123/docker.io/library/app:dev', 'app:dev'],
    ['org/app:1', 'domo-env_abc123/docker.io/org/app:1', 'org/app:1'],
    ['docker.io/library/app:dev', 'domo-env_abc123/docker.io/library/app:dev', 'app:dev'],
    ['ghcr.io/org/app:tag', 'domo-env_abc123/ghcr.io/org/app:tag', 'ghcr.io/org/app:tag'],
    ['localhost:5000/app', 'domo-env_abc123/localhost__5000/app:latest', 'localhost:5000/app:latest'],
    ['registry.example.com:8443/a/b/c:v1', 'domo-env_abc123/registry.example.com__8443/a/b/c:v1', 'registry.example.com:8443/a/b/c:v1'],
    ['localhost/app', 'domo-env_abc123/localhost/app:latest', 'localhost/app:latest']
  ])('%s round-trips', (reference, expected, back) => {
    const name = privateName(ns, reference)
    expect(name).toBe(expected)
    // A valid reference in its own right, on Docker Hub's grammar.
    expect(parseImageRef(name!)).toMatchObject({ domain: 'docker.io' })
    expect(parsePrivateName(name!)).toMatchObject({ environmentId: 'env_abc123' })
    expect(nameForAgent(ns, name!)).toBe(back)
    // And the canonical spelling the containerd store lists it under.
    expect(nameForAgent(ns, `docker.io/${name}`)).toBe(back)
  })

  it('has none for a digest, an IPv6 registry, or a name too long once prefixed', () => {
    expect(privateName(ns, `app@sha256:${'a'.repeat(64)}`)).toBeNull()
    expect(privateName(ns, '[::1]:5000/app:1')).toBeNull()
    expect(privateName(ns, `org/${'a'.repeat(240)}`)).toBeNull()
  })

  it('hides another environment\'s names, and leaves shared ones alone', () => {
    const theirs = privateName(other, 'app:dev')!
    expect(nameForAgent(ns, theirs)).toBeNull()
    expect(nameForAgent(ns, 'postgres:17')).toBe('postgres:17')
    expect(nameForAgent(ns, 'domo-dev-env_abc123:latest')).toBe('domo-dev-env_abc123:latest')
  })

  it('shows an image\'s tags as the environment knows them, a shared namesake shadowed by its own', () => {
    const tags = [privateName(ns, 'app:dev')!, privateName(other, 'app:dev')!, 'app:dev', 'alpine:3', 'app']
    const shadowed = privateNamesOf(ns, [privateName(ns, 'app:dev')!, privateName(ns, 'app')!])
    expect([...shadowed]).toEqual(['app:dev', 'app:latest'])
    expect(tagsForAgent(ns, tags, shadowed)).toEqual(['app:dev', 'alpine:3'])
    expect(tagsForAgent(ns, tags)).toEqual(['app:dev', 'alpine:3', 'app'])
    expect(tagsForAgent(ns, null)).toBeNull()
  })
})

describe('private names in free text', () => {
  const own = privateName(ns, 'app:dev')!

  it('become what a daemon of the environment\'s own would have printed', () => {
    // BuildKit's canonical form, as in `naming to …` and `FROM …`.
    expect(unprivateText(ns, `naming to docker.io/${own} done`)).toBe('naming to docker.io/library/app:dev done')
    expect(unprivateText(ns, `[1/2] FROM docker.io/${own}@sha256:${'b'.repeat(64)}`))
      .toBe(`[1/2] FROM docker.io/library/app:dev@sha256:${'b'.repeat(64)}`)
    // `docker`'s familiar form, as in `Loaded image:` and `Successfully tagged`.
    expect(unprivateText(ns, `Loaded image: ${own}`)).toBe('Loaded image: app:dev')
    // A package URL in provenance.
    expect(unprivateText(ns, 'pkg:docker/domo-env_abc123/docker.io/library/app@dev?platform=linux%2Farm64'))
      .toBe('pkg:docker/app@dev?platform=linux%2Farm64')
    expect(unprivateText(ns, `pushing ${privateName(ns, 'localhost:5000/team/app:1')}`)).toBe('pushing localhost:5000/team/app:1')
    expect(unprivateText(ns, `x docker.io/${privateName(ns, 'ghcr.io/o/a:1')} y`)).toBe('x ghcr.io/o/a:1 y')
  })

  it('leaves everything else as it is', () => {
    const theirs = privateName(other, 'app:dev')!
    expect(unprivateText(ns, theirs)).toBe(theirs)
    expect(unprivateText(ns, 'domo-dev-env_abc123 is the environment image')).toBe('domo-dev-env_abc123 is the environment image')
    expect(unprivateText(ns, 'no names here')).toBe('no names here')
  })
})

describe('reference filters', () => {
  it.each([
    ['app', 'app:dev', true],
    ['app:dev', 'app:dev', true],
    ['app:*', 'app:dev', true],
    ['a*', 'app:dev', true],
    ['*', 'org/app:dev', false],
    ['*/*', 'org/app:dev', true],
    ['ap?', 'app:1', true],
    ['[ab]pp', 'app:1', true],
    ['[!a]pp', 'app:1', false],
    ['other', 'app:dev', false]
  ])('%s against %s', (pattern, name, matches) => {
    expect(referenceMatches(pattern, name)).toBe(matches)
  })
})

describe('the build\'s source policy', () => {
  it('converts every private name of the environment, with or without a pinned digest, and nobody else\'s', () => {
    const rules = sourcePolicyRules(ns, [
      privateName(ns, 'app:dev')!,
      `docker.io/${privateName(ns, 'localhost:5000/base:1')}`,
      privateName(other, 'app:dev')!,
      'app:dev',
      privateName(ns, 'app:dev')!
    ])
    expect(rules).toHaveLength(2)
    const [app, base] = rules as [{ from: string, to: string }, { from: string, to: string }]
    const convert = (rule: { from: string, to: string }, identifier: string) => {
      const pattern = new RegExp(rule.from)
      return pattern.test(identifier) ? identifier.replace(pattern, rule.to.replace('${1}', '$1')) : null
    }
    expect(convert(app, 'docker-image://docker.io/library/app:dev')).toBe('docker-image://docker.io/domo-env_abc123/docker.io/library/app:dev')
    const digest = `@sha256:${'c'.repeat(64)}`
    expect(convert(app, `docker-image://docker.io/library/app:dev${digest}`))
      .toBe(`docker-image://docker.io/domo-env_abc123/docker.io/library/app:dev${digest}`)
    expect(convert(app, 'docker-image://docker.io/library/app:devx')).toBeNull()
    expect(convert(app, 'docker-image://docker.io/library/appxdev')).toBeNull()
    expect(convert(base, 'docker-image://localhost:5000/base:1')).toBe('docker-image://docker.io/domo-env_abc123/localhost__5000/base:1')
  })
})
