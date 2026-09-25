import {
  bytesOf,
  decodeMapEntry,
  decodeMessage,
  encodeBytesField,
  encodeVarintField,
  rewriteStrings,
  type Field,
  type StringPaths
} from './protobuf'

/**
 * The BuildKit messages the build bridge edits, as pure functions over their
 * wire bytes. Field numbers are BuildKit's (`api/services/control/control.proto`,
 * `sourcepolicy/pb/policy.proto`); every field not named here passes through
 * untouched.
 */

export const CONTROL = '/moby.buildkit.v1.Control/'
export const SOLVE = `${CONTROL}Solve`
export const STATUS = `${CONTROL}Status`
export const PRUNE = `${CONTROL}Prune`

/** SolveRequest fields. */
const SOLVE_EXPORTER_DEPRECATED = 3
const SOLVE_EXPORTER_ATTRS_DEPRECATED = 4
const SOLVE_SOURCE_POLICY = 12
const SOLVE_EXPORTERS = 13
/** Exporter fields. */
const EXPORTER_TYPE = 1
const EXPORTER_ATTRS = 2
/** Policy / Rule / Selector / Update fields and enums. */
const POLICY_VERSION = 1
const POLICY_RULES = 2
const RULE_ACTION = 1
const RULE_SELECTOR = 2
const RULE_UPDATES = 3
const ACTION_CONVERT = 2
const SELECTOR_IDENTIFIER = 1
const SELECTOR_MATCH_TYPE = 2
const MATCH_REGEX = 2
const UPDATE_IDENTIFIER = 1

/** Exporters that name an image in the daemon's own store. `oci` / `docker` / `tar` write a file for the client instead. */
const STORE_EXPORTERS = new Set(['moby', 'image'])

export interface ExporterNaming {
  /**
   * The private name for one name an exporter would create. Throws (with the
   * message the build should fail with) when it cannot be made private.
   */
  privateName(name: string): string
}

export interface SolveRequestEdit {
  message: Buffer
  /** Names an exporter pushes to a registry, and so keeps (see `rewriteSolveRequest`). */
  pushed: string[]
  /** Names that were made private, as the client gave them. */
  renamed: string[]
}

const stringField = (fields: Field[], number: number): string => {
  const found = fields.find(field => field.field === number)
  return (found && bytesOf(found)?.toString('utf8')) ?? ''
}

const truthy = (value: string | undefined) => value !== undefined && ['1', 'true'].includes(value.toLowerCase())

/**
 * An exporter's attributes with every name it would tag in the daemon made
 * private. A name the exporter *pushes* is a registry's and is left alone —
 * the bridge tags the private name itself once the build has answered with
 * the image's digest.
 */
function rewriteExporterAttrs(
  entries: Buffer[],
  type: string,
  naming: ExporterNaming,
  edit: { pushed: string[], renamed: string[] }
): Buffer[] | null {
  if (!STORE_EXPORTERS.has(type)) return null
  const attrs = new Map(entries.map(entry => decodeMapEntry(entry)))
  const names = (attrs.get('name') ?? '').split(',').map(name => name.trim()).filter(Boolean)
  if (!names.length) return null
  if (truthy(attrs.get('push'))) {
    edit.pushed.push(...names)
    return null
  }
  const renamed = names.map(name => naming.privateName(name))
  edit.renamed.push(...names)
  // Entry contents, as they came in: the caller puts each back under its own field number.
  return entries.map((entry) => {
    const [key] = decodeMapEntry(entry)
    return key === 'name' ? Buffer.concat([encodeBytesField(1, 'name'), encodeBytesField(2, renamed.join(','))]) : entry
  })
}

function encodeRule(rule: { from: string, to: string }): Buffer {
  const selector = Buffer.concat([
    encodeBytesField(SELECTOR_IDENTIFIER, rule.from),
    encodeVarintField(SELECTOR_MATCH_TYPE, MATCH_REGEX)
  ])
  const update = encodeBytesField(UPDATE_IDENTIFIER, rule.to)
  return encodeBytesField(POLICY_RULES, Buffer.concat([
    encodeVarintField(RULE_ACTION, ACTION_CONVERT),
    encodeBytesField(RULE_SELECTOR, selector),
    encodeBytesField(RULE_UPDATES, update)
  ]))
}

/**
 * `Control/Solve`'s request with the environment's names in it: exporter
 * names made private, and a source policy that converts every image the
 * environment holds privately to its private tag. A policy the client sent
 * itself keeps its own rules first — they are evaluated in order, and a rule
 * of the client's (a `DENY`, a pin) has to keep meaning what it said.
 *
 * This is the one place the policy can go: buildx runs a build as a gateway
 * client, and the policy set on its solve applies to every source the frontend
 * resolves under it (measured: `FROM` a private-only base built, the vertex
 * still read `[1/2] FROM docker.io/library/<name>`).
 */
export function rewriteSolveRequest(
  message: Buffer,
  naming: ExporterNaming,
  rules: Array<{ from: string, to: string }>
): SolveRequestEdit {
  const edit = { pushed: [] as string[], renamed: [] as string[] }
  const fields = decodeMessage(message)
  const deprecatedType = stringField(fields, SOLVE_EXPORTER_DEPRECATED)
  const deprecatedAttrs = fields.filter(field => field.field === SOLVE_EXPORTER_ATTRS_DEPRECATED).map(field => bytesOf(field)!)
  const renamedDeprecated = deprecatedType ? rewriteExporterAttrs(deprecatedAttrs, deprecatedType, naming, edit) : null
  let deprecatedWritten = false

  let policyWritten = false
  const encodedRules = rules.map(encodeRule)
  const parts: Buffer[] = []
  for (const field of fields) {
    const bytes = bytesOf(field)
    if (field.field === SOLVE_EXPORTERS && bytes) {
      const inner = decodeMessage(bytes)
      const type = stringField(inner, EXPORTER_TYPE)
      const attrs = inner.filter(entry => entry.field === EXPORTER_ATTRS).map(entry => bytesOf(entry)!)
      const renamed = rewriteExporterAttrs(attrs, type, naming, edit)
      if (!renamed) {
        parts.push(field.raw)
        continue
      }
      let attrIndex = 0
      const rebuilt = inner.map(entry => entry.field === EXPORTER_ATTRS && bytesOf(entry)
        ? encodeBytesField(EXPORTER_ATTRS, renamed[attrIndex++]!)
        : entry.raw)
      parts.push(encodeBytesField(SOLVE_EXPORTERS, Buffer.concat(rebuilt)))
      continue
    }
    if (field.field === SOLVE_EXPORTER_ATTRS_DEPRECATED && renamedDeprecated) {
      // Re-emitted all at once, where the first of them stood.
      if (!deprecatedWritten) parts.push(...renamedDeprecated.map(entry => encodeBytesField(SOLVE_EXPORTER_ATTRS_DEPRECATED, entry)))
      deprecatedWritten = true
      continue
    }
    if (field.field === SOLVE_SOURCE_POLICY && bytes && encodedRules.length && !policyWritten) {
      parts.push(encodeBytesField(SOLVE_SOURCE_POLICY, Buffer.concat([bytes, ...encodedRules])))
      policyWritten = true
      continue
    }
    parts.push(field.raw)
  }
  if (encodedRules.length && !policyWritten) {
    parts.push(encodeBytesField(SOLVE_SOURCE_POLICY, Buffer.concat([encodeVarintField(POLICY_VERSION, 1), ...encodedRules])))
  }
  const changed = edit.renamed.length > 0 || encodedRules.length > 0
  return { message: changed ? Buffer.concat(parts) : message, ...edit }
}

/** What a finished `Control/Solve` answered: `ExporterResponse`, key to value. */
export function solveResponseEntries(message: Buffer): Map<string, string> {
  return new Map(decodeMessage(message).filter(field => field.field === 1 && bytesOf(field)).map(field => decodeMapEntry(bytesOf(field)!)))
}

/**
 * `ExporterResponse` values: `image.name` names what was built, and is what
 * `--metadata-file` prints. A value that is base64 of JSON (descriptors,
 * provenance) is decoded, rewritten and encoded again, so a name inside it is
 * put back too.
 */
export function rewriteSolveResponse(message: Buffer, rewrite: (text: string) => string): Buffer {
  return rewriteStrings(message, { 1: { 2: true } }, (value) => {
    const direct = rewrite(value)
    if (direct !== value) return direct
    if (value.length < 8 || !/^[A-Za-z0-9+/]+=*$/.test(value)) return value
    const decoded = Buffer.from(value, 'base64').toString('utf8')
    if (!decoded.startsWith('{') && !decoded.startsWith('[')) return value
    const rewritten = rewrite(decoded)
    return rewritten === decoded ? value : Buffer.from(rewritten, 'utf8').toString('base64')
  })
}

/**
 * `Control/Status`: every string the progress display prints. Vertex (1):
 * name, error. VertexStatus (2): ID (`naming to …`), name. VertexLog (4 is its
 * `msg`; 3 is a stream number). VertexWarning (3): short, detail.
 */
const STATUS_STRINGS: StringPaths = {
  1: { 3: true, 7: true },
  2: { 1: true, 3: true },
  3: { 4: true },
  4: { 3: true, 4: true }
}

export function rewriteStatus(message: Buffer, rewrite: (text: string) => string): Buffer {
  return rewriteStrings(message, STATUS_STRINGS, rewrite)
}
