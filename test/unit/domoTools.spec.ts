import { describe, expect, it } from 'vitest'

import type { ToolCallView } from '~/utils/agentTranscript'
import { describeDomoCall, domoCall, domoToolLabel, parseObjectLiteral, type DomoNames } from '~/utils/domoTools'

/**
 * Domo's own tools, read back out of the three adapters' tool calls. The
 * shapes are the ones each adapter really sends.
 */

function tool(overrides: Partial<ToolCallView>): ToolCallView {
  return { toolCallId: 't', title: 'Tool', kind: 'other', status: 'completed', locations: [], content: [], ...overrides }
}

const names: DomoNames = {
  agent: id => ({ ag_peer1: 'Builder' } as Record<string, string>)[id] ?? null,
  environment: id => ({ env_1: 'scratch' } as Record<string, string>)[id] ?? null,
  project: id => ({ pr_1: 'domo' } as Record<string, string>)[id] ?? null
}

describe('domoCall', () => {
  it('reads Claude Code: the tool in the name, the arguments as they are', () => {
    const call = domoCall(tool({
      name: 'mcp__domo__get_agent',
      title: 'mcp__domo__get_agent',
      rawInput: { agentId: 'ag_peer1' },
      rawOutput: [{ type: 'text', text: '{"id":"ag_peer1","title":"Builder","status":"idle"}' }]
    }))

    expect(call).toEqual({ name: 'get_agent', args: { agentId: 'ag_peer1' }, result: { id: 'ag_peer1', title: 'Builder', status: 'idle' } })
  })

  it('reads Codex: the server and tool in the input, the result under `result`', () => {
    const call = domoCall(tool({
      title: 'mcp.domo.list_agents',
      kind: 'execute',
      rawInput: { server: 'domo', tool: 'list_agents', arguments: {} },
      rawOutput: { error: null, result: { content: [{ type: 'text', text: '{"agents":[{"id":"a"},{"id":"b"}]}' }] } }
    }))

    expect(call).toMatchObject({ name: 'list_agents', args: {}, result: { agents: [{ id: 'a' }, { id: 'b' }] } })
  })

  it('reads OpenCode from its code while it runs, and from what it reports once done', () => {
    const running = tool({
      title: 'execute',
      status: 'in_progress',
      rawInput: { code: 'await tools.domo.message_agent({\n  agentId: "ag_peer1",\n  message: "Hello, world: two\\nlines",\n})' }
    })
    expect(domoCall(running)).toMatchObject({ name: 'message_agent', args: { agentId: 'ag_peer1', message: 'Hello, world: two\nlines' } })

    const done = {
      ...running,
      status: 'completed' as const,
      rawOutput: { metadata: { toolCalls: [{ tool: 'domo.message_agent', input: { agentId: 'ag_peer1', message: 'as sent' } }] } },
      content: [{ type: 'content', content: { type: 'text', text: '{\n  "delivered": true\n}' } }]
    }
    expect(domoCall(done)).toMatchObject({ args: { message: 'as sent' }, result: { delivered: true } })
  })

  it('is not fooled by other tools, or by code that does more than one call', () => {
    expect(domoCall(tool({ name: 'Bash', title: 'pnpm test', rawInput: { command: 'pnpm test' } }))).toBeNull()
    expect(domoCall(tool({ name: 'mcp__github__get_issue', title: 'mcp__github__get_issue' }))).toBeNull()
    expect(domoCall(tool({ title: 'execute', rawInput: { code: 'const a = await tools.domo.list_agents({}); return a' } }))).toBeNull()
  })
})

describe('parseObjectLiteral', () => {
  it.each([
    ['{ agentId: "ag_1", n: 2, ok: true, }', { agentId: 'ag_1', n: 2, ok: true }],
    ['{ message: \'it\\\'s "quoted"\' }', { message: 'it\'s "quoted"' }],
    ['{ "already": "json" }', { already: 'json' }],
    ['{ message: "a, b: c" }', { message: 'a, b: c' }]
  ])('reads %s', (source, expected) => {
    expect(parseObjectLiteral(source)).toEqual(expected)
  })

  it('gives up on anything that is not plain data', () => {
    expect(parseObjectLiteral('{ message: text }')).toBeNull()
    expect(parseObjectLiteral('{ message: `hi ${name}` }')).toBeNull()
  })
})

describe('describeDomoCall', () => {
  const describe_ = (name: string, args: object, result: any = null) => describeDomoCall({ name, args, result }, names)

  it('names the agent it acted on by title', () => {
    expect(describe_('get_agent', { agentId: 'ag_peer1' })).toMatchObject({ label: 'Check agent', subject: 'Builder' })
    expect(describe_('subscribe_to_agent', { agentId: 'ag_peer1' })).toMatchObject({ label: 'Follow', subject: 'Builder' })
  })

  it('falls back to the id for an agent the page does not know', () => {
    expect(describe_('cancel_agent_turn', { agentId: 'ag_gone' }).subject).toBe('ag_gone')
  })

  it('names environments and projects', () => {
    expect(describe_('update_dev_environment', { environmentId: 'env_1', status: 'stopped' }))
      .toMatchObject({ label: 'Stop environment', subject: 'scratch' })
    expect(describe_('create_dev_environment', { projectId: 'pr_1', name: 'fix-auth' }))
      .toMatchObject({ label: 'Create environment', subject: '"fix-auth" in domo' })
  })

  it('sums a result up in a few words', () => {
    expect(describe_('list_agents', {}, { agents: [{}, {}, {}] }).outcome).toBe('3 agents')
    expect(describe_('get_agent', { agentId: 'ag_peer1' }, { title: 'Builder', status: 'thinking' }).outcome).toBe('thinking')
  })

  it('names a permission answer by its option, and by the id before the result says it', () => {
    const args = { agentId: 'ag_peer1', permissionId: 'p1', optionId: 'allow_always' }
    expect(describe_('answer_permission_request', args, { answered: true, optionId: 'allow_always', optionName: 'Always allow' }))
      .toMatchObject({ label: 'Answer a permission for', subject: 'Builder', outcome: 'Always allow' })
    expect(describe_('answer_permission_request', args).outcome).toBe('allow_always')
  })

  it('says what it is changing', () => {
    expect(describe_('manage_agent_session', { agentId: 'ag_peer1', archived: true })).toMatchObject({ label: 'Archive', subject: 'Builder' })
    expect(describe_('manage_agent_session', { title: 'New name' })).toMatchObject({ label: 'Rename', subject: 'itself to "New name"' })
    expect(describe_('forward_environment_port', { port: 3000, environmentId: 'env_1' })).toMatchObject({ label: 'Forward port 3000', subject: 'scratch' })
  })

  it('still says something for a tool it has never heard of', () => {
    expect(describe_('brand_new_tool', {})).toMatchObject({ label: 'brand new tool' })
  })

  it('has a short name for the group breakdown', () => {
    expect(domoToolLabel('list_agents')).toBe('List agents')
  })
})
