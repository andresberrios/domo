import { applyEdits, modify, parse, type ParseError } from 'jsonc-parser'

/**
 * OpenCode's own permission policy, and why Domo sets one.
 *
 * OpenCode has no permission *mode*. Its `mode` config option offers exactly
 * `build` and `plan`, and neither is a policy — Build's own description says it
 * "executes tools based on configured permissions", which is this. So there is
 * nothing for Domo's mode picker to select that stops a container session
 * asking about every command, and inventing an entry would break the rule that
 * the adapter is the authority on its modes.
 *
 * What there is instead is a `permission` block in OpenCode's config, read out
 * of the shipped validator rather than the documentation:
 *
 *     PermissionActionConfig = "ask" | "allow" | "deny"
 *     PermissionConfig       = PermissionActionConfig | {
 *       read, edit, glob, grep, list, bash, task, external_directory,
 *       question, webfetch, websearch, lsp, doom_loop, skill }
 *
 * and a bare string is expanded to `{ "*": action }` by the config loader, so
 * `"permission": "allow"` is the whole-agent form.
 */
export const PERMISSIVE_PERMISSION = 'allow'

/**
 * Whether Domo supplies one, which is a question about *where the checkout is*.
 *
 * A container session works in a volume Domo created and can re-create, behind
 * a namespace whose whole point is that an agent may act in it. A host session
 * works in the developer's real tree with nothing around it, so turning every
 * prompt off there is a decision to make deliberately rather than to inherit
 * from a version bump. Hence: containers permissive, host untouched.
 */
export function shouldSetPermission(inContainer: boolean): boolean {
  return inContainer
}

/**
 * Add Domo's permission policy to an OpenCode config, keeping everything else.
 *
 * `modify`/`applyEdits` rather than parse-and-reserialise, because the config
 * is JSONC and the developer's comments are theirs. A config that already
 * names `permission` is returned untouched: somebody who deliberately set
 * `deny` on `bash` must not have it overwritten by a default.
 */
export function withPermission(content: string | null, action: string = PERMISSIVE_PERMISSION): string {
  if (!content || !content.trim()) return JSON.stringify({ permission: action })
  const errors: ParseError[] = []
  const parsed = parse(content, errors, { allowTrailingComma: true })
  // Unparseable, or not an object: hand it over exactly as it is. OpenCode is
  // the one that should complain about the developer's own file, in its own
  // words, rather than Domo silently replacing it with something that parses.
  if (errors.length || !parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return content
  if ('permission' in parsed) return content
  return applyEdits(content, modify(content, ['permission'], action, {}))
}

/**
 * The `OPENCODE_CONFIG_CONTENT` a session starts with.
 *
 * One function so the merge cannot be skipped on one path and applied on
 * another, and so there is a single place to look for what a session's config
 * is made of: the developer's own global config, plus Domo's permission policy
 * when the session is in a container and the config does not already have one.
 */
export function sessionConfigContent(base: string | null, inContainer: boolean): string | null {
  if (!shouldSetPermission(inContainer)) return base
  return withPermission(base)
}
