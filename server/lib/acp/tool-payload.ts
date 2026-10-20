/**
 * A tool event as it is kept in `agent_events`: without the bytes of any image
 * in it, and without Claude Code's `toolResponse`.
 *
 * An agent that reads a screenshot gets the picture back as base64, and
 * claude-agent-acp sends it twice in one update (ACP's `content` and the
 * Anthropic block in `rawOutput`) and a third time in another (its
 * `toolResponse`). Nothing draws them, and every row streams to the browser:
 * one session that checked its renders wrote 1.4 GB (measured). The block
 * keeps its type and mime type, so the card still says an image came back.
 *
 * `toolResponse` is Claude Code's own copy of the result, already in
 * `content` or `rawOutput`. Only its `isAsync` is read (by the manager, before
 * this runs); it is kept so the log still says so.
 */
export function slimToolPayload(update: any): any {
  const slim = withoutImageBytes(update)
  const claudeCode = slim?._meta?.claudeCode
  if (claudeCode && typeof claudeCode === 'object' && 'toolResponse' in claudeCode) {
    const { toolResponse, ...rest } = claudeCode
    const isAsync = toolResponse?.isAsync
    slim._meta = { ...slim._meta, claudeCode: isAsync === undefined ? rest : { ...rest, toolResponse: { isAsync } } }
  }
  return slim
}

/** A copy with every image block's bytes dropped: ACP's `data`, Anthropic's `source.data`, Claude Code's `file.base64`. */
function withoutImageBytes(value: any): any {
  if (Array.isArray(value)) return value.map(withoutImageBytes)
  if (!value || typeof value !== 'object') return value
  const copy: Record<string, any> = {}
  for (const [key, inner] of Object.entries(value)) copy[key] = withoutImageBytes(inner)
  if (copy.type !== 'image') return copy
  if (typeof copy.data === 'string') copy.data = omitted(copy.data)
  if (typeof copy.source?.data === 'string') copy.source = { ...copy.source, data: omitted(copy.source.data) }
  if (typeof copy.file?.base64 === 'string') copy.file = { ...copy.file, base64: omitted(copy.file.base64) }
  return copy
}

function omitted(base64: string): string {
  return `[image omitted: ${base64.length} base64 chars]`
}
