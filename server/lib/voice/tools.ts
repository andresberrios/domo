import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { Type, type FunctionDeclaration } from '@google/genai'

import { acpManager, normalizeCwd } from '../acp/manager'
import {
  createVoiceSession,
  getAgentSession,
  getVoiceSession,
  listAgentEvents,
  listAgentSessions,
  listDevEnvironments,
  listPermissions,
  listProjects,
  setAutoTitle,
  updateAgentSession,
  updateVoiceSession
} from '../repo'
import { getSettings } from '../settings'

export interface VoiceToolContext {
  voiceSessionId: string
  /** Move everyone listening to another conversation once this turn is spoken. */
  handOver: (voiceSessionId: string) => void
}

export interface VoiceTool {
  declaration: FunctionDeclaration
  handler: (args: any, ctx: VoiceToolContext) => Promise<any>
}

/** Pick the agent the user most likely means when they don't name one. */
async function resolveAgent(agentId?: string) {
  const sessions = await listAgentSessions()
  if (agentId) {
    const direct = sessions.find(s => s.id === agentId)
    if (direct) return direct
    const byTitle = sessions.find(
      s => s.title.toLowerCase() === agentId.toLowerCase()
        || s.title.toLowerCase().includes(agentId.toLowerCase())
    )
    if (byTitle) return byTitle
    throw new Error(`No coding agent matches "${agentId}". Call list_agent_sessions first.`)
  }
  if (!sessions.length) throw new Error('There are no coding agent sessions yet.')
  return sessions[0]!
}

/** Spoken models dress titles up; the sidebar wants a plain few words. */
export function cleanTitle(raw: unknown): string {
  const title = String(raw ?? '')
    .split('\n')[0]!
    .replace(/^["'“”‘’*#\s]+|["'“”‘’*\s]+$/g, '')
    .replace(/[.!]+$/, '')
    .trim()
  return title.length > 60 ? `${title.slice(0, 59).trimEnd()}…` : title
}

function summarise(text: string | null, max = 400): string {
  if (!text) return ''
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max)}…` : clean
}

/** Condense the durable ACP event log into something speakable. */
export async function transcriptDigest(agentSessionId: string, limit = 40) {
  const events = await listAgentEvents(agentSessionId, 0, 4000)
  const tail = events.slice(-limit * 4)
  const items: Array<{ kind: string, text: string }> = []
  let assistant = ''

  const flush = () => {
    if (assistant.trim()) items.push({ kind: 'agent', text: summarise(assistant, 600) })
    assistant = ''
  }

  for (const event of tail) {
    switch (event.type) {
      case 'user_message': {
        flush()
        const text = (event.payload?.content ?? [])
          .filter((block: any) => block?.type === 'text')
          .map((block: any) => block.text)
          .join(' ')
        items.push({ kind: 'user', text: summarise(text, 400) })
        break
      }
      case 'agent_message':
        assistant += event.payload?.text ?? ''
        break
      // Older installs logged one row per delta.
      case 'agent_message_chunk':
        if (event.payload?.content?.type === 'text') assistant += event.payload.content.text
        break
      case 'tool_call':
        flush()
        items.push({ kind: 'tool', text: `${event.payload?.title ?? 'tool'} (${event.payload?.status ?? 'pending'})` })
        break
      case 'plan':
        flush()
        items.push({
          kind: 'plan',
          text: (event.payload?.entries ?? [])
            .map((entry: any) => `${entry.status}: ${entry.content}`)
            .join('; ')
        })
        break
      case 'permission_request':
        flush()
        items.push({ kind: 'permission', text: event.payload?.toolCall?.title ?? 'permission requested' })
        break
      case 'turn_end':
        flush()
        items.push({ kind: 'status', text: `turn finished (${event.payload?.stopReason ?? 'end_turn'})` })
        break
      case 'error':
        flush()
        items.push({ kind: 'error', text: summarise(event.payload?.message ?? 'error', 300) })
        break
    }
  }
  flush()
  return items.slice(-limit)
}

export const voiceTools: Record<string, VoiceTool> = {
  start_new_conversation: {
    declaration: {
      name: 'start_new_conversation',
      description:
        'Start a brand-new conversation with fresh context and move the user into it. Use it only when the user asks to start over, clear the context, or begin a new conversation. Coding agents keep running and are still reachable from the new conversation. Say a short sign-off in the same turn; nothing from this conversation carries over.',
      parameters: { type: Type.OBJECT, properties: {} }
    },
    handler: async (_args, ctx) => {
      const session = await createVoiceSession()
      ctx.handOver(session.id)
      return { id: session.id, started: true }
    }
  },

  set_conversation_title: {
    declaration: {
      name: 'set_conversation_title',
      description:
        'Set the title this conversation is listed under. Call it on your own, without saying anything about it: once the topic is clear (usually after the first exchange), and again whenever the conversation moves on to clearly different work. 2 to 6 words, sentence case, naming the actual work ("Flaky invoice tests", "Auth refactor plan"), never "Conversation with user". Skip the call if the current title still fits.',
      parameters: {
        type: Type.OBJECT,
        properties: { title: { type: Type.STRING, description: 'The title, 2 to 6 words.' } },
        required: ['title']
      }
    },
    handler: async (args, ctx) => {
      const title = cleanTitle(args.title)
      if (!title) throw new Error('A title is required.')
      const session = await getVoiceSession(ctx.voiceSessionId)
      if (session?.titleSource === 'user') {
        return { applied: false, title: session.title, reason: 'The user named this conversation. Leave it unless they ask for a rename.' }
      }
      if (session?.title === title) return { applied: true, title }
      // Conditional on the source, so a rename landing in the meantime still wins.
      const updated = await setAutoTitle(ctx.voiceSessionId, title)
      return updated
        ? { applied: true, title }
        : { applied: false, reason: 'The user named this conversation meanwhile. Leave it.' }
    }
  },

  rename_conversation: {
    declaration: {
      name: 'rename_conversation',
      description:
        'Rename the current conversation because the user asked to call it something. Their title sticks: set_conversation_title will not replace it.',
      parameters: {
        type: Type.OBJECT,
        properties: { title: { type: Type.STRING, description: 'New title, a few words.' } },
        required: ['title']
      }
    },
    handler: async (args, ctx) => {
      const title = cleanTitle(args.title)
      if (!title) throw new Error('A title is required.')
      await updateVoiceSession(ctx.voiceSessionId, { title, titleSource: 'user' })
      return { title }
    }
  },

  list_agent_sessions: {
    declaration: {
      name: 'list_agent_sessions',
      description:
        'List every coding agent session with its id, title, working directory, status, and a short summary of its latest output. Call this before answering any question about what the agents are doing.',
      parameters: { type: Type.OBJECT, properties: {} }
    },
    handler: async () => {
      const sessions = await listAgentSessions()
      const pending = await listPermissions(undefined, true)
      return {
        agents: sessions.map(session => ({
          id: session.id,
          title: session.title,
          adapter: session.adapter,
          cwd: session.cwd,
          devEnvironmentId: session.devEnvironmentId,
          status: session.status,
          mode: session.modeId,
          lastActivityAt: session.lastActivityAt,
          summary: summarise(session.summary, 300),
          awaitingPermission: pending.filter(p => p.agentSessionId === session.id).length
        }))
      }
    }
  },

  create_agent_session: {
    declaration: {
      name: 'create_agent_session',
      description:
        'Start a new Claude Code or Codex agent session and optionally give it its first task. Use this when the user wants new work done in parallel.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          title: { type: Type.STRING, description: 'Short human name for the session, e.g. "auth refactor".' },
          adapter: {
            type: Type.STRING,
            enum: ['claude-code', 'codex'],
            description: 'Coding agent to run. Defaults to Claude Code.'
          },
          task: { type: Type.STRING, description: 'The first instruction for the agent.' },
          cwd: {
            type: Type.STRING,
            description: 'Absolute path of the repository to work in. Omit to use the configured default workspace.'
          },
          devEnvironmentId: {
            type: Type.STRING,
            description: 'Development environment id from list_dev_environments. Prefer this over cwd.'
          }
        },
        required: ['title']
      }
    },
    handler: async (args, ctx) => {
      const session = await acpManager.create({
        adapter: args.adapter === 'codex' ? 'codex' : 'claude-code',
        title: args.title,
        cwd: args.cwd,
        devEnvironmentId: args.devEnvironmentId,
        voiceSessionId: ctx.voiceSessionId,
        initialPrompt: args.task
      })
      return {
        id: session.id,
        title: session.title,
        adapter: session.adapter,
        cwd: session.cwd,
        status: session.status,
        started: !!args.task
      }
    }
  },

  list_dev_environments: {
    declaration: {
      name: 'list_dev_environments',
      description: 'List projects and their isolated development environments. Each environment can host multiple coding agents and its own Docker Compose stacks.',
      parameters: { type: Type.OBJECT, properties: {} }
    },
    handler: async () => {
      const [projects, environments, agents] = await Promise.all([
        listProjects(),
        listDevEnvironments(),
        listAgentSessions()
      ])
      return {
        projects: projects.map(project => ({
          id: project.id,
          name: project.name,
          sourceRepository: project.repoPath,
          environments: environments
            .filter(environment => environment.projectId === project.id)
            .map(environment => ({
              id: environment.id,
              name: environment.name,
              status: environment.status,
              workspace: environment.workspacePath,
              agentCount: agents.filter(agent => agent.devEnvironmentId === environment.id).length
            }))
        }))
      }
    }
  },

  send_agent_message: {
    declaration: {
      name: 'send_agent_message',
      description:
        'Send a message to a coding agent session. The agent starts working immediately; this returns as soon as the turn has begun, so follow up with get_agent_transcript to see what happened.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          agentId: { type: Type.STRING, description: 'Agent session id or title. Omit for the most recently active one.' },
          message: { type: Type.STRING, description: 'What to tell the agent.' }
        },
        required: ['message']
      }
    },
    handler: async (args) => {
      const session = await resolveAgent(args.agentId)
      void acpManager.promptInBackground(session.id, [{ type: 'text', text: args.message }])
      return { id: session.id, title: session.title, delivered: true }
    }
  },

  get_agent_transcript: {
    declaration: {
      name: 'get_agent_transcript',
      description:
        'Read a condensed transcript of a coding agent session: its recent messages, tool calls, plan and errors. Use it to answer "what is it doing" questions.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          agentId: { type: Type.STRING, description: 'Agent session id or title. Omit for the most recently active one.' },
          limit: { type: Type.INTEGER, description: 'How many recent items to return (default 20).' }
        }
      }
    },
    handler: async (args) => {
      const session = await resolveAgent(args.agentId)
      const items = await transcriptDigest(session.id, Math.min(Number(args.limit) || 20, 60))
      return { id: session.id, title: session.title, status: session.status, items }
    }
  },

  cancel_agent_turn: {
    declaration: {
      name: 'cancel_agent_turn',
      description: 'Stop what a coding agent is currently doing. Its conversation is kept, only the running turn is aborted.',
      parameters: {
        type: Type.OBJECT,
        properties: { agentId: { type: Type.STRING, description: 'Agent session id or title.' } }
      }
    },
    handler: async (args) => {
      const session = await resolveAgent(args.agentId)
      await acpManager.cancel(session.id)
      return { id: session.id, title: session.title, cancelled: true }
    }
  },

  list_pending_permissions: {
    declaration: {
      name: 'list_pending_permissions',
      description:
        'List coding-agent permission requests that are waiting for a decision, with the options that can be chosen.',
      parameters: { type: Type.OBJECT, properties: {} }
    },
    handler: async () => {
      const pending = await listPermissions(undefined, true)
      const sessions = await listAgentSessions(true)
      return {
        permissions: pending.map(permission => ({
          permissionId: permission.id,
          agentId: permission.agentSessionId,
          agentTitle: sessions.find(s => s.id === permission.agentSessionId)?.title ?? 'unknown',
          request: permission.title,
          options: permission.options
        }))
      }
    }
  },

  answer_permission: {
    declaration: {
      name: 'answer_permission',
      description:
        'Answer a waiting permission request on behalf of the user. Always confirm with the user first, then pass the exact optionId from list_pending_permissions.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          permissionId: { type: Type.STRING, description: 'Id of the permission request.' },
          optionId: { type: Type.STRING, description: 'Exact optionId to select.' }
        },
        required: ['permissionId', 'optionId']
      }
    },
    handler: async (args) => {
      const pending = await listPermissions(undefined, true)
      const permission = pending.find(p => p.id === args.permissionId)
      if (!permission) throw new Error('That permission request is no longer waiting.')
      if (!permission.options.some(option => option.optionId === args.optionId)) {
        throw new Error(`Option "${args.optionId}" is not offered. Options: ${permission.options.map(o => o.optionId).join(', ')}`)
      }
      await acpManager.answerPermission(permission.agentSessionId, permission.id, args.optionId, 'voice-agent')
      return { answered: true, optionId: args.optionId }
    }
  },

  set_agent_mode: {
    declaration: {
      name: 'set_agent_mode',
      description:
        'Change a coding agent’s permission mode, e.g. "default" (ask every time), "acceptEdits", "plan", or "bypassPermissions".',
      parameters: {
        type: Type.OBJECT,
        properties: {
          agentId: { type: Type.STRING, description: 'Agent session id or title.' },
          modeId: { type: Type.STRING, description: 'Mode id to switch to.' }
        },
        required: ['modeId']
      }
    },
    handler: async (args) => {
      const session = await resolveAgent(args.agentId)
      await acpManager.setMode(session.id, args.modeId)
      return { id: session.id, title: session.title, mode: args.modeId }
    }
  },

  rename_agent_session: {
    declaration: {
      name: 'rename_agent_session',
      description: 'Rename a coding agent session so it is easier to refer to later.',
      parameters: {
        type: Type.OBJECT,
        properties: {
          agentId: { type: Type.STRING, description: 'Agent session id or current title.' },
          title: { type: Type.STRING, description: 'New title.' }
        },
        required: ['title']
      }
    },
    handler: async (args) => {
      const session = await resolveAgent(args.agentId)
      await updateAgentSession(session.id, { title: args.title })
      return { id: session.id, title: args.title }
    }
  },

  archive_agent_session: {
    declaration: {
      name: 'archive_agent_session',
      description: 'Shut down a coding agent session and hide it from the session list.',
      parameters: {
        type: Type.OBJECT,
        properties: { agentId: { type: Type.STRING, description: 'Agent session id or title.' } }
      }
    },
    handler: async (args) => {
      const session = await resolveAgent(args.agentId)
      acpManager.stop(session.id)
      await updateAgentSession(session.id, { archived: true, status: 'stopped' })
      return { id: session.id, archived: true }
    }
  },

  list_directories: {
    declaration: {
      name: 'list_directories',
      description:
        'List sub-directories of a path on this machine so you can pick a working directory for a new agent. Omit the path to list the default workspace.',
      parameters: {
        type: Type.OBJECT,
        properties: { path: { type: Type.STRING, description: 'Absolute directory path.' } }
      }
    },
    handler: async (args) => {
      const settings = await getSettings()
      const base = normalizeCwd(args.path || settings.defaultCwd)
      const entries = await readdir(base, { withFileTypes: true })
      const dirs: string[] = []
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue
        dirs.push(entry.name)
        if (dirs.length >= 60) break
      }
      return { path: base, directories: dirs }
    }
  },

  get_agent_status: {
    declaration: {
      name: 'get_agent_status',
      description: 'Get the current status of one coding agent session, including whether it is waiting on a decision.',
      parameters: {
        type: Type.OBJECT,
        properties: { agentId: { type: Type.STRING, description: 'Agent session id or title.' } }
      }
    },
    handler: async (args) => {
      const resolved = await resolveAgent(args.agentId)
      const session = await getAgentSession(resolved.id)
      const pending = await listPermissions(resolved.id, true)
      return {
        id: session?.id,
        title: session?.title,
        status: session?.status,
        mode: session?.modeId,
        cwd: session?.cwd,
        lastError: session?.lastError,
        summary: summarise(session?.summary ?? null, 500),
        pendingPermissions: pending.map(p => ({ permissionId: p.id, request: p.title, options: p.options }))
      }
    }
  }
}

export function voiceToolDeclarations(options: { autoTitle: boolean }): FunctionDeclaration[] {
  return Object.values(voiceTools)
    .map(tool => tool.declaration)
    .filter(declaration => options.autoTitle || declaration.name !== 'set_conversation_title')
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

export async function listChildDirectories(path: string): Promise<Array<{ name: string, path: string }>> {
  const entries = await readdir(path, { withFileTypes: true })
  return entries
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
    .map(entry => ({ name: entry.name, path: join(path, entry.name) }))
    .sort((a, b) => a.name.localeCompare(b.name))
}
