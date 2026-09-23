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
 *
 * **What actually prompts is neither `bash` nor an edit**, which is measured
 * rather than guessed. A tool touching a path **outside the session's `cwd`**
 * is the trigger:
 * reading `/etc/hosts` with the `read` tool raises one
 * `session/request_permission` titled with the path, while the same file read
 * through `cat` in the `bash` tool raises nothing at all, and an in-`cwd`
 * write raises nothing because OpenCode delegates it to the client as
 * `fs/write_text_file`. A coding agent steps outside its directory constantly
 * — a global config, a sibling checkout, `/tmp`, `/opt/domo` — so this is what
 * "it asks me for permission for everything" is made of.
 *
 * That `bash` bypass is worth knowing before reasoning about the host default:
 * `external_directory` is **not** a boundary an agent cannot cross, because
 * the shell crosses it silently. It is a guardrail against the *accidental*
 * out-of-directory access the tidy tools make, which is the common case and
 * worth keeping — but nobody should defend it as containment.
 */
export type OpenCodePermission = 'ask' | 'allow'

/**
 * Which surface gets which, and why the two differ.
 *
 * A container session works in a volume Domo created and can re-create, so the
 * prompts buy nothing there and cost the user every out-of-directory read. A
 * host session works in the developer's real tree, where the same prompts do
 * catch an accidental step outside the project — so the default is kept and
 * turning it off is theirs to choose rather than Domo's to assume.
 */
export function permissionFor(
  setting: { host: OpenCodePermission, environment: OpenCodePermission },
  inContainer: boolean
): OpenCodePermission {
  return inContainer ? setting.environment : setting.host
}

/**
 * Add Domo's permission policy to an OpenCode config, keeping everything else.
 *
 * `modify`/`applyEdits` rather than parse-and-reserialise, because the config
 * is JSONC and the developer's comments are theirs. A config that already
 * names `permission` is returned untouched: somebody who deliberately set
 * `deny` on `bash` must not have it overwritten by a default.
 */
export function withPermission(content: string | null, action: OpenCodePermission): string {
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
 * is made of: the developer's own global config, plus the permission policy
 * for this surface when the config does not already name one.
 *
 * `ask` is what OpenCode does unaided, so it writes nothing at all rather than
 * spelling out the default — the smaller the config Domo injects, the less
 * there is to disagree with a future OpenCode about.
 */
export function sessionConfigContent(
  base: string | null,
  inContainer: boolean,
  setting: { host: OpenCodePermission, environment: OpenCodePermission }
): string | null {
  const action = permissionFor(setting, inContainer)
  if (action === 'ask') return base
  return withPermission(base, action)
}
