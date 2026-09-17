import { newId, nowIso, query, queryOne } from './db'
import { bus } from './bus'
import { getSettings } from './settings'
import type {
  AgentEvent,
  AgentSession,
  AgentSessionStatus,
  DevEnvironment,
  McpServer,
  PendingPermission,
  Project,
  VoiceMessage,
  VoiceSession
} from '../../shared/types'

/* ------------------------------------------------------------------ */
/* row mappers                                                         */
/* ------------------------------------------------------------------ */

function mapVoiceSession(r: any): VoiceSession {
  return {
    id: r.id,
    title: r.title,
    status: r.status,
    model: r.model,
    voice: r.voice,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastActivityAt: r.last_activity_at,
    archived: r.archived
  }
}

function mapVoiceMessage(r: any): VoiceMessage {
  return {
    id: r.id,
    sessionId: r.session_id,
    seq: Number(r.seq),
    role: r.role,
    text: r.text,
    toolName: r.tool_name,
    meta: r.meta,
    createdAt: r.created_at
  }
}

function mapAgentSession(r: any): AgentSession {
  return {
    id: r.id,
    voiceSessionId: r.voice_session_id,
    adapter: r.adapter,
    acpSessionId: r.acp_session_id,
    title: r.title,
    cwd: r.cwd,
    devEnvironmentId: r.dev_environment_id ?? null,
    status: r.status,
    modeId: r.mode_id,
    modes: r.modes,
    lastError: r.last_error,
    summary: r.summary,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastActivityAt: r.last_activity_at,
    archived: r.archived
  }
}

function mapProject(r: any): Project {
  return {
    id: r.id,
    name: r.name,
    repoPath: r.repo_path,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }
}

function mapDevEnvironment(r: any): DevEnvironment {
  return {
    id: r.id,
    projectId: r.project_id,
    name: r.name,
    containerName: r.container_name,
    workspacePath: r.workspace_path,
    status: r.status,
    lastError: r.last_error ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }
}

function mapAgentEvent(r: any): AgentEvent {
  return {
    id: r.id,
    agentSessionId: r.agent_session_id,
    seq: Number(r.seq),
    type: r.type,
    payload: r.payload,
    createdAt: r.created_at
  }
}

function mapPermission(r: any): PendingPermission {
  return {
    id: r.id,
    agentSessionId: r.agent_session_id,
    toolCallId: r.tool_call_id,
    title: r.title,
    options: r.options,
    toolCall: r.tool_call,
    createdAt: r.created_at,
    resolvedAt: r.resolved_at,
    resolvedOptionId: r.resolved_option_id,
    resolvedBy: r.resolved_by
  }
}

function mapMcp(r: any): McpServer {
  return {
    id: r.id,
    name: r.name,
    transport: r.transport,
    command: r.command,
    args: r.args ?? [],
    env: r.env ?? {},
    url: r.url,
    headers: r.headers ?? {},
    enabled: r.enabled,
    scope: r.scope,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }
}

/* ------------------------------------------------------------------ */
/* projects and isolated development environments                     */
/* ------------------------------------------------------------------ */

export async function listProjects(): Promise<Project[]> {
  return (await query('select * from projects order by name asc')).map(mapProject)
}

export async function getProject(id: string): Promise<Project | null> {
  const row = await queryOne('select * from projects where id = $1', [id])
  return row ? mapProject(row) : null
}

export async function createProject(input: { name: string, repoPath: string }): Promise<Project> {
  const now = nowIso()
  const row = await queryOne(
    `insert into projects (id, name, repo_path, created_at, updated_at)
     values ($1, $2, $3, $4, $4) returning *`,
    [newId('prj'), input.name, input.repoPath, now]
  )
  bus.publish({ type: 'project-changed' })
  return mapProject(row)
}

export async function deleteProject(id: string): Promise<void> {
  await query('delete from projects where id = $1', [id])
  bus.publish({ type: 'project-changed' })
}

export async function listDevEnvironments(projectId?: string): Promise<DevEnvironment[]> {
  const rows = projectId
    ? await query('select * from dev_environments where project_id = $1 order by created_at desc', [projectId])
    : await query('select * from dev_environments order by created_at desc')
  return rows.map(mapDevEnvironment)
}

export async function getDevEnvironment(id: string): Promise<DevEnvironment | null> {
  const row = await queryOne('select * from dev_environments where id = $1', [id])
  return row ? mapDevEnvironment(row) : null
}

export async function createDevEnvironmentRow(input: {
  id?: string
  projectId: string
  name: string
  containerName: string
  workspacePath: string
}): Promise<DevEnvironment> {
  const now = nowIso()
  const row = await queryOne(
    `insert into dev_environments
       (id, project_id, name, container_name, workspace_path, status, created_at, updated_at)
     values ($1, $2, $3, $4, $5, 'creating', $6, $6) returning *`,
    [input.id ?? newId('env'), input.projectId, input.name, input.containerName, input.workspacePath, now]
  )
  const environment = mapDevEnvironment(row)
  bus.publish({ type: 'dev-environment-changed', devEnvironmentId: environment.id })
  return environment
}

export async function updateDevEnvironment(
  id: string,
  patch: Partial<Pick<DevEnvironment, 'name' | 'status' | 'lastError'>>
): Promise<DevEnvironment | null> {
  const sets = ['updated_at = $2']
  const params: any[] = [id, nowIso()]
  const push = (column: string, value: any) => {
    params.push(value)
    sets.push(`${column} = $${params.length}`)
  }
  if (patch.name !== undefined) push('name', patch.name)
  if (patch.status !== undefined) push('status', patch.status)
  if (patch.lastError !== undefined) push('last_error', patch.lastError)
  const row = await queryOne(`update dev_environments set ${sets.join(', ')} where id = $1 returning *`, params)
  if (!row) return null
  const environment = mapDevEnvironment(row)
  bus.publish({ type: 'dev-environment-changed', devEnvironmentId: id })
  return environment
}

export async function deleteDevEnvironmentRow(id: string): Promise<void> {
  await query('delete from dev_environments where id = $1', [id])
  bus.publish({ type: 'dev-environment-changed', devEnvironmentId: id })
}

/* ------------------------------------------------------------------ */
/* voice sessions                                                      */
/* ------------------------------------------------------------------ */

export async function listVoiceSessions(includeArchived = false): Promise<VoiceSession[]> {
  const rows = await query(
    `select * from voice_sessions ${includeArchived ? '' : 'where archived = false'}
     order by coalesce(last_activity_at, created_at) desc`
  )
  return rows.map(mapVoiceSession)
}

export async function getVoiceSession(id: string): Promise<VoiceSession | null> {
  const row = await queryOne('select * from voice_sessions where id = $1', [id])
  return row ? mapVoiceSession(row) : null
}

export async function createVoiceSession(input: { title?: string } = {}): Promise<VoiceSession> {
  const settings = await getSettings()
  const now = nowIso()
  const id = newId('vs')
  const row = await queryOne(
    `insert into voice_sessions (id, title, status, model, voice, created_at, updated_at)
     values ($1, $2, 'idle', $3, $4, $5, $5) returning *`,
    [id, input.title?.trim() || 'New conversation', settings.liveModel, settings.voiceName, now]
  )
  bus.publish({ type: 'voice-list-changed' })
  return mapVoiceSession(row)
}

export async function updateVoiceSession(
  id: string,
  patch: Partial<Pick<VoiceSession, 'title' | 'status' | 'archived' | 'model' | 'voice'>> & {
    lastActivityAt?: string
    resumptionHandle?: string | null
  }
): Promise<VoiceSession | null> {
  const sets: string[] = ['updated_at = $2']
  const params: any[] = [id, nowIso()]
  const push = (col: string, value: any) => {
    params.push(value)
    sets.push(`${col} = $${params.length}`)
  }
  if (patch.title !== undefined) push('title', patch.title)
  if (patch.status !== undefined) push('status', patch.status)
  if (patch.archived !== undefined) push('archived', patch.archived)
  if (patch.model !== undefined) push('model', patch.model)
  if (patch.voice !== undefined) push('voice', patch.voice)
  if (patch.lastActivityAt !== undefined) push('last_activity_at', patch.lastActivityAt)
  if (patch.resumptionHandle !== undefined) push('resumption_handle', patch.resumptionHandle)

  const row = await queryOne(
    `update voice_sessions set ${sets.join(', ')} where id = $1 returning *`,
    params
  )
  if (!row) return null
  bus.publish({ type: 'voice-session-changed', sessionId: id })
  bus.publish({ type: 'voice-list-changed' })
  return mapVoiceSession(row)
}

export async function getResumptionHandle(id: string): Promise<string | null> {
  const row = await queryOne<{ resumption_handle: string | null }>(
    'select resumption_handle from voice_sessions where id = $1',
    [id]
  )
  return row?.resumption_handle ?? null
}

export async function deleteVoiceSession(id: string): Promise<void> {
  await query('delete from voice_sessions where id = $1', [id])
  bus.publish({ type: 'voice-list-changed' })
}

export async function listVoiceMessages(sessionId: string, limit = 500): Promise<VoiceMessage[]> {
  const rows = await query(
    `select * from (
       select * from voice_messages where session_id = $1 order by seq desc limit $2
     ) t order by seq asc`,
    [sessionId, limit]
  )
  return rows.map(mapVoiceMessage)
}

export async function appendVoiceMessage(input: {
  sessionId: string
  role: VoiceMessage['role']
  text: string
  toolName?: string | null
  meta?: Record<string, unknown> | null
}): Promise<VoiceMessage> {
  const now = nowIso()
  const row = await queryOne(
    `insert into voice_messages (id, session_id, role, text, tool_name, meta, created_at)
     values ($1, $2, $3, $4, $5, $6::jsonb, $7)
     returning *`,
    [
      newId('vm'),
      input.sessionId,
      input.role,
      input.text,
      input.toolName ?? null,
      JSON.stringify(input.meta ?? null),
      now
    ]
  )
  const message = mapVoiceMessage(row)
  await query('update voice_sessions set last_activity_at = $2, updated_at = $2 where id = $1', [
    input.sessionId,
    now
  ])
  bus.publish({ type: 'voice-message', sessionId: input.sessionId, message })
  return message
}

/* ------------------------------------------------------------------ */
/* agent sessions                                                      */
/* ------------------------------------------------------------------ */

export async function listAgentSessions(includeArchived = false): Promise<AgentSession[]> {
  const rows = await query(
    `select * from agent_sessions ${includeArchived ? '' : 'where archived = false'}
     order by coalesce(last_activity_at, created_at) desc`
  )
  return rows.map(mapAgentSession)
}

export async function getAgentSession(id: string): Promise<AgentSession | null> {
  const row = await queryOne('select * from agent_sessions where id = $1', [id])
  return row ? mapAgentSession(row) : null
}

export async function createAgentSession(input: {
  title: string
  cwd: string
  voiceSessionId?: string | null
  modeId?: string | null
  devEnvironmentId?: string | null
}): Promise<AgentSession> {
  const now = nowIso()
  const row = await queryOne(
    `insert into agent_sessions
       (id, voice_session_id, adapter, title, cwd, dev_environment_id, status, mode_id, created_at, updated_at)
     values ($1, $2, 'claude-code', $3, $4, $5, 'starting', $6, $7, $7) returning *`,
    [newId('ag'), input.voiceSessionId ?? null, input.title, input.cwd, input.devEnvironmentId ?? null, input.modeId ?? null, now]
  )
  bus.publish({ type: 'agent-list-changed' })
  return mapAgentSession(row)
}

export async function updateAgentSession(
  id: string,
  patch: Partial<{
    title: string
    cwd: string
    status: AgentSessionStatus
    acpSessionId: string | null
    modeId: string | null
    modes: any
    lastError: string | null
    summary: string | null
    archived: boolean
    touch: boolean
  }>
): Promise<AgentSession | null> {
  const sets: string[] = ['updated_at = $2']
  const params: any[] = [id, nowIso()]
  const push = (col: string, value: any) => {
    params.push(value)
    sets.push(`${col} = $${params.length}`)
  }
  if (patch.title !== undefined) push('title', patch.title)
  if (patch.cwd !== undefined) push('cwd', patch.cwd)
  if (patch.status !== undefined) push('status', patch.status)
  if (patch.acpSessionId !== undefined) push('acp_session_id', patch.acpSessionId)
  if (patch.modeId !== undefined) push('mode_id', patch.modeId)
  if (patch.modes !== undefined) {
    params.push(JSON.stringify(patch.modes))
    sets.push(`modes = $${params.length}::jsonb`)
  }
  if (patch.lastError !== undefined) push('last_error', patch.lastError)
  if (patch.summary !== undefined) push('summary', patch.summary)
  if (patch.archived !== undefined) push('archived', patch.archived)
  if (patch.touch) sets.push('last_activity_at = $2')

  const row = await queryOne(
    `update agent_sessions set ${sets.join(', ')} where id = $1 returning *`,
    params
  )
  if (!row) return null
  bus.publish({ type: 'agent-changed', agentSessionId: id })
  bus.publish({ type: 'agent-list-changed' })
  return mapAgentSession(row)
}

export async function deleteAgentSession(id: string): Promise<void> {
  await query('delete from agent_sessions where id = $1', [id])
  bus.publish({ type: 'agent-list-changed' })
}

export async function listAgentEvents(
  agentSessionId: string,
  since = 0,
  limit = 2000
): Promise<AgentEvent[]> {
  const rows = await query(
    `select * from agent_events where agent_session_id = $1 and seq > $2
     order by seq asc limit $3`,
    [agentSessionId, since, limit]
  )
  return rows.map(mapAgentEvent)
}

export async function appendAgentEvent(
  agentSessionId: string,
  type: string,
  payload: any
): Promise<AgentEvent> {
  const row = await queryOne(
    `insert into agent_events (id, agent_session_id, type, payload, created_at)
     values ($1, $2, $3, $4::jsonb, $5)
     returning *`,
    [newId('ev'), agentSessionId, type, JSON.stringify(payload ?? null), nowIso()]
  )
  const event = mapAgentEvent(row)
  bus.publish({ type: 'agent-event', agentSessionId, event })
  return event
}

/* ------------------------------------------------------------------ */
/* permissions                                                         */
/* ------------------------------------------------------------------ */

export async function createPermission(input: {
  agentSessionId: string
  toolCallId: string | null
  title: string
  options: PendingPermission['options']
  toolCall: any
}): Promise<PendingPermission> {
  const row = await queryOne(
    `insert into agent_permissions
       (id, agent_session_id, tool_call_id, title, options, tool_call, created_at)
     values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7) returning *`,
    [
      newId('pm'),
      input.agentSessionId,
      input.toolCallId,
      input.title,
      JSON.stringify(input.options),
      JSON.stringify(input.toolCall ?? null),
      nowIso()
    ]
  )
  const permission = mapPermission(row)
  bus.publish({ type: 'permission-changed', agentSessionId: input.agentSessionId, permission })
  return permission
}

export async function resolvePermissionRow(
  id: string,
  optionId: string | null,
  by: PendingPermission['resolvedBy']
): Promise<PendingPermission | null> {
  const row = await queryOne(
    `update agent_permissions set resolved_at = $2, resolved_option_id = $3, resolved_by = $4
     where id = $1 and resolved_at is null returning *`,
    [id, nowIso(), optionId, by]
  )
  if (!row) return null
  const permission = mapPermission(row)
  bus.publish({ type: 'permission-changed', agentSessionId: permission.agentSessionId, permission })
  return permission
}

export async function listPermissions(
  agentSessionId?: string,
  pendingOnly = true
): Promise<PendingPermission[]> {
  const where: string[] = []
  const params: any[] = []
  if (agentSessionId) {
    params.push(agentSessionId)
    where.push(`agent_session_id = $${params.length}`)
  }
  if (pendingOnly) where.push('resolved_at is null')
  const rows = await query(
    `select * from agent_permissions ${where.length ? `where ${where.join(' and ')}` : ''}
     order by created_at asc`,
    params
  )
  return rows.map(mapPermission)
}

/* ------------------------------------------------------------------ */
/* mcp servers                                                         */
/* ------------------------------------------------------------------ */

export async function listMcpServers(): Promise<McpServer[]> {
  const rows = await query('select * from mcp_servers order by name asc')
  return rows.map(mapMcp)
}

export async function createMcpServer(input: Partial<McpServer> & { name: string, transport: McpServer['transport'] }): Promise<McpServer> {
  const now = nowIso()
  const row = await queryOne(
    `insert into mcp_servers (id, name, transport, command, args, env, url, headers, enabled, scope, created_at, updated_at)
     values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7, $8::jsonb, $9, $10, $11, $11) returning *`,
    [
      newId('mcp'),
      input.name,
      input.transport,
      input.command ?? null,
      JSON.stringify(input.args ?? []),
      JSON.stringify(input.env ?? {}),
      input.url ?? null,
      JSON.stringify(input.headers ?? {}),
      input.enabled ?? true,
      input.scope ?? 'both',
      now
    ]
  )
  bus.publish({ type: 'mcp-changed' })
  return mapMcp(row)
}

export async function updateMcpServer(id: string, patch: Partial<McpServer>): Promise<McpServer | null> {
  const sets: string[] = ['updated_at = $2']
  const params: any[] = [id, nowIso()]
  const push = (col: string, value: any, cast = '') => {
    params.push(value)
    sets.push(`${col} = $${params.length}${cast}`)
  }
  if (patch.name !== undefined) push('name', patch.name)
  if (patch.transport !== undefined) push('transport', patch.transport)
  if (patch.command !== undefined) push('command', patch.command)
  if (patch.args !== undefined) push('args', JSON.stringify(patch.args), '::jsonb')
  if (patch.env !== undefined) push('env', JSON.stringify(patch.env), '::jsonb')
  if (patch.url !== undefined) push('url', patch.url)
  if (patch.headers !== undefined) push('headers', JSON.stringify(patch.headers), '::jsonb')
  if (patch.enabled !== undefined) push('enabled', patch.enabled)
  if (patch.scope !== undefined) push('scope', patch.scope)

  const row = await queryOne(`update mcp_servers set ${sets.join(', ')} where id = $1 returning *`, params)
  if (!row) return null
  bus.publish({ type: 'mcp-changed' })
  return mapMcp(row)
}

export async function deleteMcpServer(id: string): Promise<void> {
  await query('delete from mcp_servers where id = $1', [id])
  bus.publish({ type: 'mcp-changed' })
}
