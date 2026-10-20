import { describe, expect, it } from 'vitest'

import { slimToolPayload } from '../../server/lib/acp/tool-payload'

const BYTES = 'A'.repeat(4000)

describe('slimToolPayload', () => {
  // What claude-agent-acp sends for a Read of a screenshot (shapes from a real
  // session): the picture in ACP's `content` and again in `rawOutput`.
  it('drops the bytes of both copies of an image a Read returned', () => {
    const slim = slimToolPayload({
      sessionUpdate: 'tool_call_update',
      toolCallId: 'toolu_1',
      status: 'completed',
      _meta: { claudeCode: { toolName: 'Read' } },
      content: [{ type: 'content', content: { type: 'image', mimeType: 'image/jpeg', data: BYTES } }],
      rawOutput: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: BYTES } }]
    })
    expect(JSON.stringify(slim)).not.toContain(BYTES)
    expect(slim.content[0].content).toEqual({ type: 'image', mimeType: 'image/jpeg', data: '[image omitted: 4000 base64 chars]' })
    expect(slim.rawOutput[0].source.media_type).toBe('image/jpeg')
    expect(slim.status).toBe('completed')
  })

  it('drops toolResponse, a third copy, but keeps whether the call is async', () => {
    const image = slimToolPayload({
      _meta: { claudeCode: { toolName: 'Read', toolResponse: { type: 'image', file: { type: 'image/jpeg', base64: BYTES } } } }
    })
    expect(image._meta.claudeCode).toEqual({ toolName: 'Read' })

    const agent = slimToolPayload({ _meta: { claudeCode: { toolName: 'Agent', toolResponse: { isAsync: true, prompt: 'long' } } } })
    expect(agent._meta.claudeCode).toEqual({ toolName: 'Agent', toolResponse: { isAsync: true } })
  })

  it('leaves text output and the update it was given alone', () => {
    const update = {
      content: [{ type: 'content', content: { type: 'text', text: 'ok' } }],
      rawOutput: { data: 'not an image' },
      _meta: { claudeCode: { toolName: 'Bash', toolResponse: { stdout: 'ok' } } }
    }
    const slim = slimToolPayload(update)
    expect(slim.content).toEqual(update.content)
    expect(slim.rawOutput).toEqual({ data: 'not an image' })
    expect(update._meta.claudeCode.toolResponse).toEqual({ stdout: 'ok' })
  })
})
