import { useLiveQuery } from '@tanstack/vue-db'
import {
  agentEventsCollection,
  agentSessionsCollection,
  devEnvironmentsCollection,
  mcpServersCollection,
  permissionsCollection,
  projectsCollection,
  voiceMessagesCollection,
  voiceSessionsCollection
} from '~/lib/collections'
import type {
  AgentEvent,
  AgentSession,
  DevEnvironment,
  McpServer,
  PendingPermission,
  Project,
  VoiceMessage,
  VoiceSession
} from '~~/shared/types'

/* Electric hands rows back exactly as Postgres stores them (snake_case), so
 * each hook maps once, here, and the rest of the app sees domain objects. */

function asNumber(value: unknown): number {
  return typeof value === 'bigint' ? Number(value) : Number(value ?? 0)
}

function byRecency(a: { lastActivityAt: string | null, createdAt: string }, b: typeof a) {
  return (b.lastActivityAt ?? b.createdAt).localeCompare(a.lastActivityAt ?? a.createdAt)
}

export function useVoiceSessions() {
  const { data, isReady } = useLiveQuery(q => q.from({ session: voiceSessionsCollection() }))

  const sessions = computed<VoiceSession[]>(() =>
    (data.value ?? [])
      .map((row: any) => ({
        id: row.id,
        title: row.title,
        titleSource: row.title_source ?? 'auto',
        status: row.status,
        model: row.model,
        voice: row.voice,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        lastActivityAt: row.last_activity_at ?? null,
        archived: !!row.archived
      }))
      .filter(session => !session.archived)
      .sort(byRecency)
  )

  return { sessions, isReady }
}

export function useAgentSessions() {
  const { data, isReady } = useLiveQuery(q => q.from({ agent: agentSessionsCollection() }))

  const sessions = computed<AgentSession[]>(() =>
    (data.value ?? [])
      .map((row: any) => ({
        id: row.id,
        voiceSessionId: row.voice_session_id ?? null,
        adapter: row.adapter === 'codex' ? 'codex' as const : 'claude-code' as const,
        acpSessionId: row.acp_session_id ?? null,
        title: row.title,
        cwd: row.cwd,
        devEnvironmentId: row.dev_environment_id ?? null,
        status: row.status,
        modeId: row.mode_id ?? null,
        modes: row.modes ?? null,
        model: row.model ?? null,
        lastError: row.last_error ?? null,
        summary: row.summary ?? null,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        lastActivityAt: row.last_activity_at ?? null,
        archived: !!row.archived
      }))
      .filter(session => !session.archived)
      .sort(byRecency)
  )

  return { sessions, isReady }
}

export function useProjects() {
  const { data, isReady } = useLiveQuery(q => q.from({ project: projectsCollection() }))
  const projects = computed<Project[]>(() =>
    (data.value ?? []).map((row: any) => ({
      id: row.id,
      name: row.name,
      repoPath: row.repo_path,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    })).sort((a, b) => a.name.localeCompare(b.name))
  )
  return { projects, isReady }
}

export function useDevEnvironments() {
  const { data, isReady } = useLiveQuery(q => q.from({ environment: devEnvironmentsCollection() }))
  const environments = computed<DevEnvironment[]>(() =>
    (data.value ?? []).map((row: any) => ({
      id: row.id,
      projectId: row.project_id,
      name: row.name,
      containerName: row.container_name,
      containerId: row.container_id ?? null,
      workspacePath: row.workspace_path,
      configSource: row.config_source ?? 'default',
      configPath: row.config_path ?? null,
      remoteUser: row.remote_user ?? null,
      status: row.status,
      lastError: row.last_error ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    })).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  )
  return { environments, isReady }
}

export function useAgentEvents(agentSessionId: MaybeRefOrGetter<string | null | undefined>) {
  const { data, isReady } = useLiveQuery(
    (q) => {
      const id = toValue(agentSessionId)
      if (!id) return undefined
      return q.from({ event: agentEventsCollection(id) })
    },
    [() => toValue(agentSessionId)]
  )

  const events = computed<AgentEvent[]>(() =>
    (data.value ?? [])
      .map((row: any) => ({
        id: row.id,
        agentSessionId: row.agent_session_id,
        seq: asNumber(row.seq),
        type: row.type,
        payload: row.payload,
        createdAt: row.created_at
      }))
      .sort((a, b) => a.seq - b.seq)
  )

  return { events, isReady }
}

export function useVoiceMessages(voiceSessionId: MaybeRefOrGetter<string | null | undefined>) {
  const { data, isReady } = useLiveQuery(
    (q) => {
      const id = toValue(voiceSessionId)
      if (!id) return undefined
      return q.from({ message: voiceMessagesCollection(id) })
    },
    [() => toValue(voiceSessionId)]
  )

  const messages = computed<VoiceMessage[]>(() =>
    (data.value ?? [])
      .map((row: any) => ({
        id: row.id,
        sessionId: row.session_id,
        seq: asNumber(row.seq),
        role: row.role,
        text: row.text ?? '',
        toolName: row.tool_name ?? null,
        meta: row.meta ?? null,
        createdAt: row.created_at
      }))
      .sort((a, b) => a.seq - b.seq)
  )

  return { messages, isReady }
}

export function usePermissions(agentSessionId?: MaybeRefOrGetter<string | null | undefined>) {
  const { data, isReady } = useLiveQuery(q => q.from({ permission: permissionsCollection() }))

  const permissions = computed<PendingPermission[]>(() => {
    const filterId = agentSessionId ? toValue(agentSessionId) : null
    return (data.value ?? [])
      .map((row: any) => ({
        id: row.id,
        agentSessionId: row.agent_session_id,
        toolCallId: row.tool_call_id ?? null,
        title: row.title,
        options: row.options ?? [],
        toolCall: row.tool_call,
        createdAt: row.created_at,
        resolvedAt: row.resolved_at ?? null,
        resolvedOptionId: row.resolved_option_id ?? null,
        resolvedBy: row.resolved_by ?? null
      }))
      .filter(permission => !filterId || permission.agentSessionId === filterId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  })

  const pending = computed(() => permissions.value.filter(permission => !permission.resolvedAt))

  return { permissions, pending, isReady }
}

export function useMcpServers() {
  const { data, isReady } = useLiveQuery(q => q.from({ server: mcpServersCollection() }))

  const servers = computed<McpServer[]>(() =>
    (data.value ?? [])
      .map((row: any) => ({
        id: row.id,
        name: row.name,
        transport: row.transport,
        command: row.command ?? null,
        args: row.args ?? [],
        env: row.env ?? {},
        url: row.url ?? null,
        headers: row.headers ?? {},
        enabled: !!row.enabled,
        scope: row.scope,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
  )

  return { servers, isReady }
}
