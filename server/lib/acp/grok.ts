import * as acp from '@agentclientprotocol/sdk'

/**
 * Grok Build's ACP server (`grok agent stdio`), made to look like the others
 * so nothing past this point needs a Grok branch. Measured on 1.0.62.
 *
 * - **Sign-in.** With no `grok login`, `session/new` answers "Authentication
 *   required" until a method is chosen, and the API key's method
 *   (`xai.api_key`) is not always advertised: `initialize` checks the key
 *   with xAI first and leaves it out when the check says no. `authenticate`
 *   takes it anyway. Never `_x.ai/setApiKey`: that writes the key into
 *   `~/.grok/auth.json`, the user's own login file.
 * - **Modes.** `session/new` publishes none, though `session/set_mode` takes
 *   `default`, `plan` and `ask`, and permissions are a separate switch
 *   (always-approve, `_x.ai/yolo_mode_changed`). Domo offers the four as one
 *   list (`GROK_MODES`).
 * - **Steering.** A second `session/prompt` waits behind the running turn.
 *   `_x.ai/interject` puts a message into it at the next safe point; one that
 *   misses the turn's last safe point becomes a turn of its own, which Domo
 *   treats as an unprompted turn.
 */

export const GROK_MODES = [
  { id: 'default', name: 'Default', description: 'Asks before it edits files or runs commands that change anything.' },
  { id: 'always-approve', name: 'Always approve', description: 'Runs tools without asking. Deny rules and hooks still apply.' },
  { id: 'plan', name: 'Plan', description: 'Explores and designs an approach before writing any code.' },
  { id: 'ask', name: 'Ask', description: 'Answers questions without using tools.' }
]

/** The ACP mode under each of Domo's: always-approve is the default mode with prompts off. */
function grokMode(modeId: string): { modeId: string, yolo: boolean } {
  return modeId === 'always-approve' ? { modeId: 'default', yolo: true } : { modeId, yolo: false }
}

/**
 * Grok answers a failed request with a bare "Internal error" and puts the
 * reason, such as xAI refusing the key, in `data.message`. The reason is
 * what the session's error and the setup guide should say.
 */
function withReason(error: any): any {
  const reason = error?.data?.message
  if (typeof reason === 'string' && reason && error instanceof Error && /^internal error$/i.test(error.message)) error.message = reason
  return error
}

/** The text a message's blocks carry, which `_x.ai/interject` requires beside them. */
function blocksText(content: any[]): string {
  return content
    .map(block => (block?.type === 'text' ? String(block.text ?? '') : block?.type === 'resource_link' ? String(block.uri ?? '') : ''))
    .filter(Boolean)
    .join('\n\n')
}

export function withGrok<T extends { agent: { request: (...args: any[]) => Promise<any>, notify: (...args: any[]) => Promise<void> } }>(
  connection: T,
  options: { apiKey: boolean }
): T {
  const request = connection.agent.request.bind(connection.agent)
  const original = (...args: any[]) => request(...args).catch((error: unknown) => {
    throw withReason(error)
  })
  const notify = connection.agent.notify.bind(connection.agent)
  const current = new Map<string, string>()

  const withModes = (sessionId: string, response: any) => {
    if (!response || typeof response !== 'object' || response.modes) return response
    return { ...response, modes: { availableModes: GROK_MODES, currentModeId: current.get(sessionId) ?? 'default' } }
  }

  connection.agent.request = (async (method: string, params: any, ...rest: any[]) => {
    if (method === acp.methods.agent.session.setMode) {
      const { modeId, yolo } = grokMode(String(params?.modeId))
      const response = await original(method, { ...params, modeId }, ...rest)
      // The process serves this one session, so the switch reaches no other.
      await notify('_x.ai/yolo_mode_changed', { yolo_mode: yolo })
      current.set(params.sessionId, String(params.modeId))
      return response
    }
    if (method === '_session/steering') {
      const content = Array.isArray(params?.prompt) ? params.prompt : []
      await original('_x.ai/interject', { sessionId: params.sessionId, text: blocksText(content), content }, ...rest)
      return { outcome: 'steered' }
    }
    const response = await original(method, params, ...rest)
    if (method === acp.methods.agent.initialize) {
      if (options.apiKey) await original(acp.methods.agent.authenticate, { methodId: 'xai.api_key' }, ...rest)
      return { ...response, _meta: { ...response?._meta, steering: { supported: true } } }
    }
    if (method === acp.methods.agent.session.new) return withModes(response?.sessionId, response)
    if (method === acp.methods.agent.session.load || method === acp.methods.agent.session.resume) {
      return withModes(params?.sessionId, response)
    }
    return response
  }) as T['agent']['request']
  return connection
}
