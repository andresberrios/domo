#!/usr/bin/env node
/**
 * Domo agent-mesh: a zero-dependency MCP stdio server handed to every coding
 * agent Domo spawns.
 *
 * It lets a coding agent see its peers, hand work to them, spawn new agents and
 * speak to the voice supervisor — every call is proxied back into the Domo
 * server over loopback HTTP.
 *
 * Env:
 *   DOMO_INTERNAL_URL      base URL of the running Domo server
 *   DOMO_AGENT_SESSION_ID  the calling agent's session id
 */

const BASE = process.env.DOMO_INTERNAL_URL || 'http://127.0.0.1:3000'
const SELF = process.env.DOMO_AGENT_SESSION_ID || ''
const PROTOCOL_VERSION = '2025-06-18'

const TOOLS = [
  {
    name: 'list_agents',
    description:
      'List the other coding agent sessions running in Domo, with their id, title, working directory, status and a short summary of their latest output.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'message_agent',
    description:
      'Send a message to another coding agent session. The message is delivered as a new user turn in that session and it will start working on it immediately.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'Target agent session id (from list_agents).' },
        message: { type: 'string', description: 'What to tell that agent.' }
      },
      required: ['agentId', 'message'],
      additionalProperties: false
    }
  },
  {
    name: 'spawn_agent',
    description:
      'Spawn a brand new coding agent session on a task. Use this to parallelise independent work. Returns the new agent id.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short name for the new agent session.' },
        prompt: { type: 'string', description: 'The task to hand to the new agent.' },
        cwd: {
          type: 'string',
          description: 'Absolute working directory. Defaults to the spawning agent’s directory.'
        }
      },
      required: ['title', 'prompt'],
      additionalProperties: false
    }
  },
  {
    name: 'notify_supervisor',
    description:
      'Say something to the human’s voice supervisor agent. Use it to report a milestone, flag a blocker, or ask a question that needs a human decision. The supervisor may speak it out loud.',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'What to tell the supervisor.' },
        urgent: { type: 'boolean', description: 'Set when the human should be interrupted now.' }
      },
      required: ['message'],
      additionalProperties: false
    }
  }
]

async function callDomo(tool, args) {
  const response = await fetch(`${BASE}/api/internal/mesh`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ tool, args, agentSessionId: SELF })
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`Domo returned ${response.status}: ${text}`)
  try {
    const parsed = JSON.parse(text)
    return typeof parsed === 'string' ? parsed : JSON.stringify(parsed, null, 2)
  } catch {
    return text
  }
}

/* ----------------------------- transport ----------------------------- */

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function reply(id, result) {
  if (id === undefined || id === null) return
  send({ jsonrpc: '2.0', id, result })
}

function replyError(id, code, message) {
  if (id === undefined || id === null) return
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

async function handle(message) {
  const { id, method, params } = message
  switch (method) {
    case 'initialize':
      reply(id, {
        protocolVersion: params?.protocolVersion || PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'domo-agent-mesh', version: '1.0.0' }
      })
      return
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return
    case 'ping':
      reply(id, {})
      return
    case 'tools/list':
      reply(id, { tools: TOOLS })
      return
    case 'tools/call': {
      const name = params?.name
      const args = params?.arguments ?? {}
      if (!TOOLS.some(tool => tool.name === name)) {
        replyError(id, -32602, `Unknown tool: ${name}`)
        return
      }
      try {
        const text = await callDomo(name, args)
        reply(id, { content: [{ type: 'text', text }] })
      } catch (error) {
        reply(id, {
          content: [{ type: 'text', text: `Error: ${error instanceof Error ? error.message : String(error)}` }],
          isError: true
        })
      }
      return
    }
    case 'resources/list':
      reply(id, { resources: [] })
      return
    case 'prompts/list':
      reply(id, { prompts: [] })
      return
    default:
      replyError(id, -32601, `Method not found: ${method}`)
  }
}

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let index = buffer.indexOf('\n')
  while (index !== -1) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (line) {
      try {
        void handle(JSON.parse(line))
      } catch (error) {
        console.error('[domo-agent-mesh] bad message', error)
      }
    }
    index = buffer.indexOf('\n')
  }
})
process.stdin.resume()
