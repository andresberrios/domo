import { getDb, newId, nowIso, query, queryOne } from './db'
import { bus } from './bus'
import { getSettings } from './settings'
import type {
  AgentEvent,
  AgentInboxMessage,
  AgentStreamType,
  AgentAdapter,
  AgentSession,
  AgentSessionStatus,
  AgentSubscription,
  AgentUsage,
  CronJob,
  CronRun,
  DevEnvironment,
  DevEnvironmentPort,
  McpServer,
  MessageDelivery,
  MessageOrigin,
  PendingPermission,
  Project,
  UsageLimit,
  UsageLimitSource,
  UsageProvider,
  UsageProviderId,
  UsageProviderState,
  VoiceMessage,
  VoiceSession,
  VoiceUsage
} from '../../shared/types'

/* ------------------------------------------------------------------ */
/* row mappers                                                         */
/* ------------------------------------------------------------------ */

function mapVoiceSession(r: any): VoiceSession {
  return {
    id: r.id,
    title: r.title,
    titleSource: r.title_source ?? 'auto',
    status: r.status,
    model: r.model,
    voice: r.voice,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastActivityAt: r.last_activity_at,
    archived: r.archived,
    summary: r.summary ?? null,
    summaryThroughSeq: r.summary_through_seq === null || r.summary_through_seq === undefined
      ? null
      : Number(r.summary_through_seq),
    summaryUpdatedAt: r.summary_updated_at ?? null,
    usage: r.usage ?? null
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
    adapter: r.adapter === 'codex' ? 'codex' : 'claude-code',
    acpSessionId: r.acp_session_id,
    title: r.title,
    cwd: r.cwd,
    devEnvironmentId: r.dev_environment_id ?? null,
    status: r.status,
    modeId: r.mode_id,
    modes: r.modes,
    model: r.model ?? null,
    config: r.config ?? null,
    configOptions: r.config_options ?? null,
    lastError: r.last_error,
    summary: r.summary,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastActivityAt: r.last_activity_at,
    archived: r.archived,
    usage: r.usage ?? null
  }
}

function mapUsageLimit(r: any): UsageLimit {
  return {
    provider: r.provider,
    limitId: r.limit_id,
    label: r.label,
    usedPercent: r.used_percent === null ? null : Number(r.used_percent),
    resetsAt: r.resets_at ?? null,
    windowMinutes: r.window_minutes === null ? null : Number(r.window_minutes),
    status: r.status ?? null,
    amountUsed: r.amount_used === null ? null : Number(r.amount_used),
    amountLimit: r.amount_limit === null ? null : Number(r.amount_limit),
    currency: r.currency ?? null,
    source: r.source,
    updatedAt: r.updated_at
  }
}

function mapUsageProvider(r: any): UsageProvider {
  return {
    provider: r.provider,
    state: r.state,
    message: r.message ?? null,
    checkedAt: r.checked_at
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
    containerId: r.container_id ?? null,
    workspacePath: r.workspace_path,
    configSource: r.config_source ?? 'default',
    configPath: r.config_path ?? null,
    remoteUser: r.remote_user ?? null,
    status: r.status,
    lastError: r.last_error ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }
}

function mapDevEnvironmentPort(r: any): DevEnvironmentPort {
  const appProtocol = r.app_protocol ?? null
  const hostPort = r.host_port == null ? null : Number(r.host_port)
  return {
    id: r.id,
    devEnvironmentId: r.dev_environment_id,
    innerPort: Number(r.inner_port),
    protocol: r.protocol,
    appProtocol,
    label: r.label ?? null,
    source: r.source,
    hostPort,
    listening: !!r.listening,
    forwarded: !!r.forwarded,
    url: hostPort && r.protocol === 'tcp'
      ? `${appProtocol === 'https' ? 'https' : 'http'}://127.0.0.1:${hostPort}`
      : null
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

function mapInboxMessage(r: any): AgentInboxMessage {
  return {
    id: r.id,
    agentSessionId: r.agent_session_id,
    seq: Number(r.seq),
    content: r.content ?? [],
    delivery: r.delivery,
    origin: r.origin,
    createdAt: r.created_at,
    deliveredAt: r.delivered_at ?? null
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

function mapCronJob(r: any): CronJob {
  return {
    id: r.id,
    agentSessionId: r.agent_session_id,
    name: r.name,
    prompt: r.prompt,
    scheduleType: r.schedule_type,
    cronExpression: r.cron_expression ?? null,
    timezone: r.timezone,
    runAt: r.run_at ?? null,
    enabled: !!r.enabled,
    delivery: r.delivery,
    nextRunAt: r.next_run_at ?? null,
    lastRunAt: r.last_run_at ?? null,
    lastStatus: r.last_status ?? null,
    lastError: r.last_error ?? null,
    runCount: Number(r.run_count),
    createdBy: r.created_by,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }
}

function mapCronRun(r: any): CronRun {
  return {
    id: r.id,
    cronJobId: r.cron_job_id,
    scheduledFor: r.scheduled_for,
    startedAt: r.started_at,
    finishedAt: r.finished_at ?? null,
    status: r.status,
    outcome: r.outcome ?? null,
    error: r.error ?? null
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

export async function updateProject(id: string, patch: { name: string }): Promise<Project | null> {
  const row = await queryOne(
    'update projects set name = $2, updated_at = $3 where id = $1 returning *',
    [id, patch.name, nowIso()]
  )
  if (!row) return null
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
  configSource?: DevEnvironment['configSource']
  configPath?: string | null
  remoteUser?: string | null
}): Promise<DevEnvironment> {
  const now = nowIso()
  const row = await queryOne(
    `insert into dev_environments
       (id, project_id, name, container_name, workspace_path,
        config_source, config_path, remote_user, status, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, 'creating', $9, $9) returning *`,
    [input.id ?? newId('env'), input.projectId, input.name, input.containerName, input.workspacePath,
      input.configSource ?? 'default', input.configPath ?? null, input.remoteUser ?? null, now]
  )
  const environment = mapDevEnvironment(row)
  bus.publish({ type: 'dev-environment-changed', devEnvironmentId: environment.id })
  return environment
}

export async function updateDevEnvironment(
  id: string,
  patch: Partial<Pick<DevEnvironment,
    'name' | 'status' | 'lastError' | 'containerName' | 'containerId'
    | 'workspacePath' | 'configSource' | 'configPath' | 'remoteUser'>>
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
  if (patch.containerName !== undefined) push('container_name', patch.containerName)
  if (patch.containerId !== undefined) push('container_id', patch.containerId)
  if (patch.workspacePath !== undefined) push('workspace_path', patch.workspacePath)
  if (patch.configSource !== undefined) push('config_source', patch.configSource)
  if (patch.configPath !== undefined) push('config_path', patch.configPath)
  if (patch.remoteUser !== undefined) push('remote_user', patch.remoteUser)
  const row = await queryOne(`update dev_environments set ${sets.join(', ')} where id = $1 returning *`, params)
  if (!row) return null
  const environment = mapDevEnvironment(row)
  bus.publish({ type: 'dev-environment-changed', devEnvironmentId: id })
  return environment
}

export async function listDevEnvironmentPorts(environmentId: string): Promise<DevEnvironmentPort[]> {
  const rows = await query(
    `select * from dev_environment_ports where dev_environment_id = $1
     order by inner_port, protocol`,
    [environmentId]
  )
  return rows.map(mapDevEnvironmentPort)
}

export async function upsertDevEnvironmentPort(input: {
  environmentId: string
  innerPort: number
  protocol: DevEnvironmentPort['protocol']
  appProtocol?: DevEnvironmentPort['appProtocol']
  label?: string | null
  source: DevEnvironmentPort['source']
  hostPort?: number | null
  listening?: boolean
  forwarded?: boolean
}): Promise<DevEnvironmentPort> {
  const now = nowIso()
  const row = await queryOne(
    `insert into dev_environment_ports
       (id, dev_environment_id, inner_port, protocol, app_protocol, label, source,
        host_port, listening, forwarded, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11)
     on conflict (dev_environment_id, inner_port, protocol) do update set
       app_protocol = coalesce(excluded.app_protocol, dev_environment_ports.app_protocol),
       label = coalesce(excluded.label, dev_environment_ports.label),
       source = case when dev_environment_ports.source = 'declared' then 'declared' else excluded.source end,
       host_port = coalesce(excluded.host_port, dev_environment_ports.host_port),
       listening = excluded.listening,
       forwarded = case when excluded.forwarded then true else dev_environment_ports.forwarded end,
       updated_at = excluded.updated_at
     returning *`,
    [newId('port'), input.environmentId, input.innerPort, input.protocol,
      input.appProtocol ?? null, input.label ?? null, input.source, input.hostPort ?? null,
      input.listening ?? false, input.forwarded ?? false, now]
  )
  return mapDevEnvironmentPort(row)
}

export async function updateDevEnvironmentPort(
  environmentId: string,
  innerPort: number,
  patch: { hostPort?: number | null, listening?: boolean, forwarded?: boolean },
  protocol: DevEnvironmentPort['protocol'] = 'tcp'
): Promise<DevEnvironmentPort | null> {
  const sets = ['updated_at = $4']
  const params: any[] = [environmentId, innerPort, protocol, nowIso()]
  const push = (column: string, value: any) => {
    params.push(value)
    sets.push(`${column} = $${params.length}`)
  }
  if (patch.hostPort !== undefined) push('host_port', patch.hostPort)
  if (patch.listening !== undefined) push('listening', patch.listening)
  if (patch.forwarded !== undefined) push('forwarded', patch.forwarded)
  const row = await queryOne(
    `update dev_environment_ports set ${sets.join(', ')}
     where dev_environment_id = $1 and inner_port = $2 and protocol = $3 returning *`,
    params
  )
  return row ? mapDevEnvironmentPort(row) : null
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
  const title = input.title?.trim()
  const row = await queryOne(
    `insert into voice_sessions (id, title, title_source, status, model, voice, created_at, updated_at)
     values ($1, $2, $3, 'idle', $4, $5, $6, $6) returning *`,
    [id, title || 'New conversation', title ? 'user' : 'auto', settings.liveModel, settings.voiceName, now]
  )
  bus.publish({ type: 'voice-list-changed' })
  return mapVoiceSession(row)
}

export async function updateVoiceSession(
  id: string,
  patch: Partial<Pick<VoiceSession, 'title' | 'titleSource' | 'status' | 'archived' | 'model' | 'voice'>> & {
    lastActivityAt?: string
    resumptionHandle?: string | null
    resumptionFingerprint?: string | null
  }
): Promise<VoiceSession | null> {
  const sets: string[] = ['updated_at = $2']
  const params: any[] = [id, nowIso()]
  const push = (col: string, value: any) => {
    params.push(value)
    sets.push(`${col} = $${params.length}`)
  }
  if (patch.title !== undefined) push('title', patch.title)
  if (patch.titleSource !== undefined) push('title_source', patch.titleSource)
  if (patch.status !== undefined) push('status', patch.status)
  if (patch.archived !== undefined) push('archived', patch.archived)
  if (patch.model !== undefined) push('model', patch.model)
  if (patch.voice !== undefined) push('voice', patch.voice)
  if (patch.lastActivityAt !== undefined) push('last_activity_at', patch.lastActivityAt)
  if (patch.resumptionHandle !== undefined) push('resumption_handle', patch.resumptionHandle)
  if (patch.resumptionFingerprint !== undefined) push('resumption_fingerprint', patch.resumptionFingerprint)

  const row = await queryOne(
    `update voice_sessions set ${sets.join(', ')} where id = $1 returning *`,
    params
  )
  if (!row) return null
  bus.publish({ type: 'voice-session-changed', sessionId: id })
  bus.publish({ type: 'voice-list-changed' })
  return mapVoiceSession(row)
}

/**
 * Store a generated title, unless the user named the conversation in the
 * meantime: a rename always wins over a title that was still being written.
 */
export async function setAutoTitle(id: string, title: string): Promise<VoiceSession | null> {
  const row = await queryOne(
    `update voice_sessions set title = $2, updated_at = $3
     where id = $1 and title_source = 'auto' returning *`,
    [id, title, nowIso()]
  )
  if (!row) return null
  bus.publish({ type: 'voice-session-changed', sessionId: id })
  bus.publish({ type: 'voice-list-changed' })
  return mapVoiceSession(row)
}

/**
 * Store a fold of the conversation's own history.
 *
 * Guarded on the seq it advances past, so a summary can only ever move
 * forward: two folds racing (a connect and the turn that triggered one) end
 * with the further of the two, and the other is dropped rather than rewinding
 * the row to cover fewer messages than it already did.
 *
 * Only `voice-session-changed` is published: a summary changes nothing about
 * where the conversation sits in the sidebar, and the row reaches the browser
 * through Electric either way.
 */
export async function saveConversationSummary(
  id: string,
  input: { summary: string, throughSeq: number }
): Promise<VoiceSession | null> {
  const now = nowIso()
  const row = await queryOne(
    `update voice_sessions
        set summary = $2, summary_through_seq = $3, summary_updated_at = $4, updated_at = $4
      where id = $1 and coalesce(summary_through_seq, 0) < $3
      returning *`,
    [id, input.summary, input.throughSeq, now]
  )
  if (!row) return null
  bus.publish({ type: 'voice-session-changed', sessionId: id })
  return mapVoiceSession(row)
}

/** The handle to resume with, and the fingerprint of the setup that issued it. */
export async function getResumptionHandle(id: string): Promise<{ handle: string | null, fingerprint: string | null }> {
  const row = await queryOne<{ resumption_handle: string | null, resumption_fingerprint: string | null }>(
    'select resumption_handle, resumption_fingerprint from voice_sessions where id = $1',
    [id]
  )
  return { handle: row?.resumption_handle ?? null, fingerprint: row?.resumption_fingerprint ?? null }
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

/**
 * The messages after a seq, oldest first — the fold's own query.
 *
 * `listVoiceMessages` answers with the *newest* rows, which is what a connect
 * wants and the opposite of what compaction does: a fold has to start exactly
 * at the boundary the last one left, or it would claim to cover messages it
 * never saw. With a backlog bigger than `limit` this simply folds the oldest
 * chunk and leaves the rest for the next fold.
 */
export async function listVoiceMessagesAfter(
  sessionId: string,
  afterSeq: number,
  limit = 200
): Promise<VoiceMessage[]> {
  const rows = await query(
    `select * from voice_messages
      where session_id = $1 and seq > $2
      order by seq asc limit $3`,
    [sessionId, afterSeq, limit]
  )
  return rows.map(mapVoiceMessage)
}

/** How many messages no summary covers — including ones outside a tail window. */
export async function countVoiceMessagesAfter(sessionId: string, afterSeq: number): Promise<number> {
  const row = await queryOne<{ count: number }>(
    'select count(*)::int as count from voice_messages where session_id = $1 and seq > $2',
    [sessionId, afterSeq]
  )
  return row?.count ?? 0
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
  adapter: AgentAdapter
  title: string
  cwd: string
  voiceSessionId?: string | null
  modeId?: string | null
  model?: string | null
  devEnvironmentId?: string | null
}): Promise<AgentSession> {
  const now = nowIso()
  const row = await queryOne(
    `insert into agent_sessions
       (id, voice_session_id, adapter, title, cwd, dev_environment_id, status, mode_id, model, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, 'starting', $7, $8, $9, $9) returning *`,
    [
      newId('ag'), input.voiceSessionId ?? null, input.adapter, input.title, input.cwd,
      input.devEnvironmentId ?? null, input.modeId ?? null, input.model ?? null, now
    ]
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
    model: string | null
    config: Record<string, string> | null
    configOptions: any
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
  if (patch.model !== undefined) push('model', patch.model)
  if (patch.config !== undefined) {
    params.push(JSON.stringify(patch.config))
    sets.push(`config = $${params.length}::jsonb`)
  }
  if (patch.configOptions !== undefined) {
    params.push(JSON.stringify(patch.configOptions))
    sets.push(`config_options = $${params.length}::jsonb`)
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

/**
 * Streaming text is one row per message block, not one per delta.
 *
 * The block is opened on its first delta — that claims the `seq` which fixes
 * its place in the transcript, and puts the text in front of a reader that
 * connects mid-turn — and then grows in place until `closeAgentStream` marks it
 * final. Every other event type is still appended once and never touched again.
 */
export async function openAgentStream(
  agentSessionId: string,
  type: AgentStreamType,
  text: string
): Promise<AgentEvent> {
  return appendAgentEvent(agentSessionId, type, { text, streaming: true })
}

/** Rewrite an open block's text. `seq`, `id` and `created_at` stay put. */
export async function writeAgentStream(
  id: string,
  text: string,
  streaming: boolean
): Promise<AgentEvent | null> {
  const row = await queryOne(
    'update agent_events set payload = $2::jsonb where id = $1 returning *',
    [id, JSON.stringify({ text, streaming })]
  )
  if (!row) return null
  const event = mapAgentEvent(row)
  bus.publish({ type: 'agent-event', agentSessionId: event.agentSessionId, event })
  return event
}

/**
 * The text of the agent's most recent message block.
 *
 * What a subscriber is told about a peer, so it has to be the *last* thing the
 * agent said rather than the whole log: one indexed row, not two thousand.
 */
export async function latestAgentMessage(agentSessionId: string): Promise<string> {
  const row = await queryOne<{ text: string | null }>(
    `select payload->>'text' as text from agent_events
      where agent_session_id = $1 and type = 'agent_message'
      order by seq desc limit 1`,
    [agentSessionId]
  )
  return row?.text ?? ''
}

/* ------------------------------------------------------------------ */
/* usage: session context, and account-wide plan limits                */
/* ------------------------------------------------------------------ */

/**
 * Record how full a coding session's context window is.
 *
 * Deliberately narrow: it writes `usage` and nothing else. `last_activity_at`
 * is a correctness signal the voice agent picks agents by, and a reading is not
 * activity — an idle adapter still reports one. `updated_at` is left alone for
 * the same reason, and no `agent-changed` goes on the bus: the browser already
 * has the row through Electric, and the voice runtime treats that event as
 * "something happened worth mentioning".
 */
export async function setAgentUsage(id: string, usage: AgentUsage): Promise<void> {
  await query('update agent_sessions set usage = $2::jsonb where id = $1', [id, JSON.stringify(usage)])
}

/** The same, for a voice conversation. Ordering in the sidebar is untouched. */
export async function setVoiceUsage(id: string, usage: VoiceUsage): Promise<void> {
  await query('update voice_sessions set usage = $2::jsonb where id = $1', [id, JSON.stringify(usage)])
}

export async function listUsageLimits(provider?: UsageProviderId): Promise<UsageLimit[]> {
  const rows = provider
    ? await query('select * from usage_limits where provider = $1 order by provider, limit_id', [provider])
    : await query('select * from usage_limits order by provider, limit_id')
  return rows.map(mapUsageLimit)
}

export async function listUsageProviders(): Promise<UsageProvider[]> {
  return (await query('select * from usage_providers order by provider')).map(mapUsageProvider)
}

/** Everything about a limit except who said so and when. */
type UsageLimitValue = Omit<UsageLimit, 'provider' | 'updatedAt'>

function sameLimit(row: UsageLimit, next: UsageLimitValue): boolean {
  return row.label === next.label
    && row.usedPercent === next.usedPercent
    && row.resetsAt === next.resetsAt
    && row.windowMinutes === next.windowMinutes
    && row.status === next.status
    && row.amountUsed === next.amountUsed
    && row.amountLimit === next.amountLimit
    && row.currency === next.currency
    && row.source === next.source
}

/**
 * How good each source's answer is, so a live-but-sparse reading cannot
 * clobber a complete one that is still fresh. See `SOURCE_PREFERENCE_MS`.
 */
const SOURCE_RANK: Record<UsageLimitSource, number> = {
  endpoint: 3,
  'app-server': 3,
  headers: 2,
  'session-event': 1
}

/**
 * How long a better source's reading is protected from a worse one.
 *
 * Claude's usage endpoint answers about once an hour (measured: a second call
 * inside the window is a 429 with `retry-after: 3591`), so for most of that
 * hour the freshest thing available is what rode in on a working agent. It
 * should take over — but not in the minutes right after a poll, when the
 * complete answer is still current and the event only names one window.
 */
const SOURCE_PREFERENCE_MS = 15 * 60_000

/**
 * Write a provider's limits, touching only the rows that actually changed.
 *
 * `replace` is the difference between a poll and a session event. A poll
 * describes the whole account, so a window it no longer reports is gone and its
 * row goes with it. A session event names one or two windows and knows nothing
 * about the rest, so it must never remove anything.
 *
 * Every row here is streamed to the browser with `REPLICA IDENTITY FULL`, so an
 * unchanged row that is rewritten anyway costs a full round trip for nothing —
 * hence the comparison before the update rather than a blind upsert.
 */
export async function writeUsageLimits(
  provider: UsageProviderId,
  limits: UsageLimitValue[],
  options: { replace: boolean } = { replace: true }
): Promise<void> {
  const now = nowIso()
  const existing = new Map((await listUsageLimits(provider)).map(row => [row.limitId, row]))
  let changed = false

  for (const limit of limits) {
    const current = existing.get(limit.limitId)
    if (current) {
      if (sameLimit(current, limit)) continue
      // A sparser source only wins once the better one has gone stale.
      if (SOURCE_RANK[limit.source] < SOURCE_RANK[current.source]
        && Date.now() - Date.parse(current.updatedAt) < SOURCE_PREFERENCE_MS) continue
    }
    changed = true
    await query(
      `insert into usage_limits
         (provider, limit_id, label, used_percent, resets_at, window_minutes, status,
          amount_used, amount_limit, currency, source, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       on conflict (provider, limit_id) do update set
         label = excluded.label,
         used_percent = excluded.used_percent,
         resets_at = excluded.resets_at,
         window_minutes = excluded.window_minutes,
         status = excluded.status,
         amount_used = excluded.amount_used,
         amount_limit = excluded.amount_limit,
         currency = excluded.currency,
         source = excluded.source,
         updated_at = excluded.updated_at`,
      [
        provider, limit.limitId, limit.label, limit.usedPercent, limit.resetsAt,
        limit.windowMinutes, limit.status, limit.amountUsed, limit.amountLimit,
        limit.currency, limit.source, now
      ]
    )
  }

  if (options.replace) {
    const keep = limits.map(limit => limit.limitId)
    const removed = await query(
      `delete from usage_limits where provider = $1 and not (limit_id = any($2::text[])) returning limit_id`,
      [provider, keep]
    )
    if (removed.length) changed = true
  }

  if (changed) bus.publish({ type: 'usage-limits-changed', provider })
}

/**
 * Record whether a provider's poll worked.
 *
 * Written on every attempt so "as of" is honest, but only when something about
 * it changed — the same `ok` reported every hour is not news, and this row is
 * synced like all the others.
 */
export async function setUsageProviderState(
  provider: UsageProviderId,
  state: UsageProviderState,
  message: string | null = null
): Promise<void> {
  const current = await queryOne<{ state: string, message: string | null }>(
    'select state, message from usage_providers where provider = $1',
    [provider]
  )
  if (current && current.state === state && (current.message ?? null) === message) return
  await query(
    `insert into usage_providers (provider, state, message, checked_at)
     values ($1, $2, $3, $4)
     on conflict (provider) do update set
       state = excluded.state, message = excluded.message, checked_at = excluded.checked_at`,
    [provider, state, message, nowIso()]
  )
  bus.publish({ type: 'usage-limits-changed', provider })
}

/* ------------------------------------------------------------------ */
/* scheduled agent prompts                                            */
/* ------------------------------------------------------------------ */

type StoredCronInput = Pick<CronJob,
  'agentSessionId' | 'name' | 'prompt' | 'scheduleType' | 'cronExpression'
  | 'timezone' | 'runAt' | 'enabled' | 'delivery' | 'nextRunAt' | 'createdBy'>

export async function listCronJobs(agentSessionId?: string): Promise<CronJob[]> {
  const rows = await query(
    `select * from cron_jobs ${agentSessionId ? 'where agent_session_id = $1' : ''}
     order by coalesce(next_run_at, '9999') asc, created_at desc`,
    agentSessionId ? [agentSessionId] : []
  )
  return rows.map(mapCronJob)
}

export async function getCronJob(id: string): Promise<CronJob | null> {
  const row = await queryOne('select * from cron_jobs where id = $1', [id])
  return row ? mapCronJob(row) : null
}

export async function createCronJob(input: StoredCronInput): Promise<CronJob> {
  const now = nowIso()
  const row = await queryOne(
    `insert into cron_jobs
       (id, agent_session_id, name, prompt, schedule_type, cron_expression, timezone,
        run_at, enabled, delivery, next_run_at, created_by, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $13)
     returning *`,
    [newId('cron'), input.agentSessionId, input.name, input.prompt, input.scheduleType,
      input.cronExpression, input.timezone, input.runAt, input.enabled, input.delivery,
      input.nextRunAt, input.createdBy, now]
  )
  const job = mapCronJob(row)
  bus.publish({ type: 'cron-job-changed', cronJobId: job.id })
  return job
}

export async function replaceCronJob(id: string, input: StoredCronInput): Promise<CronJob | null> {
  const row = await queryOne(
    `update cron_jobs set
       agent_session_id = $2, name = $3, prompt = $4, schedule_type = $5,
       cron_expression = $6, timezone = $7, run_at = $8, enabled = $9,
       delivery = $10, next_run_at = $11, updated_at = $12
     where id = $1 returning *`,
    [id, input.agentSessionId, input.name, input.prompt, input.scheduleType,
      input.cronExpression, input.timezone, input.runAt, input.enabled,
      input.delivery, input.nextRunAt, nowIso()]
  )
  if (!row) return null
  const job = mapCronJob(row)
  bus.publish({ type: 'cron-job-changed', cronJobId: id })
  return job
}

export async function deleteCronJob(id: string): Promise<void> {
  await query('delete from cron_jobs where id = $1', [id])
  bus.publish({ type: 'cron-job-changed', cronJobId: id })
}

export async function listDueCronJobs(now = nowIso(), limit = 25): Promise<CronJob[]> {
  const rows = await query(
    `select * from cron_jobs
      where enabled = true and next_run_at is not null and next_run_at <= $1
      order by next_run_at asc limit $2`,
    [now, limit]
  )
  return rows.map(mapCronJob)
}

/** Atomically claim one scheduled instant and move the job's due pointer. */
export async function claimCronJob(
  id: string,
  scheduledFor: string,
  nextRunAt: string | null
): Promise<CronRun | null> {
  const db = await getDb()
  const client = await db.connect()
  try {
    await client.query('begin')
    const now = nowIso()
    const updated = await client.query(
      `update cron_jobs set
         next_run_at = $3,
         enabled = case when schedule_type = 'once' then false else enabled end,
         last_run_at = $2, last_status = 'running', last_error = null,
         run_count = run_count + 1, updated_at = $4
       where id = $1 and enabled = true and next_run_at = $2
       returning *`,
      [id, scheduledFor, nextRunAt, now]
    )
    if (!updated.rowCount) {
      await client.query('rollback')
      return null
    }
    const runResult = await client.query(
      `insert into cron_runs (id, cron_job_id, scheduled_for, started_at, status)
       values ($1, $2, $3, $4, 'running') returning *`,
      [newId('crun'), id, scheduledFor, now]
    )
    await client.query('commit')
    bus.publish({ type: 'cron-job-changed', cronJobId: id })
    return mapCronRun(runResult.rows[0])
  } catch (error) {
    await client.query('rollback').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

/** Disable a due job whose schedule cannot produce another occurrence. */
export async function failCronJobSchedule(
  id: string,
  scheduledFor: string,
  error: string
): Promise<boolean> {
  const row = await queryOne(
    `update cron_jobs set enabled = false, next_run_at = null,
       last_status = 'failed', last_error = $3, updated_at = $4
     where id = $1 and enabled = true and next_run_at = $2
     returning id`,
    [id, scheduledFor, error, nowIso()]
  )
  if (!row) return false
  bus.publish({ type: 'cron-job-changed', cronJobId: id })
  return true
}

export async function finishCronRun(
  runId: string,
  status: 'delivered' | 'failed',
  detail: string
): Promise<void> {
  const row = await queryOne<{ cron_job_id: string }>(
    `update cron_runs set finished_at = $2, status = $3,
       outcome = case when $3 = 'delivered' then $4 else null end,
       error = case when $3 = 'failed' then $4 else null end
     where id = $1 returning cron_job_id`,
    [runId, nowIso(), status, detail]
  )
  if (!row) return
  await query(
    `update cron_jobs set last_status = $2, last_error = $3, updated_at = $4 where id = $1`,
    [row.cron_job_id, status, status === 'failed' ? detail : null, nowIso()]
  )
  bus.publish({ type: 'cron-job-changed', cronJobId: row.cron_job_id })
}

export async function listCronRuns(cronJobId: string, limit = 50): Promise<CronRun[]> {
  return (await query(
    'select * from cron_runs where cron_job_id = $1 order by started_at desc limit $2',
    [cronJobId, limit]
  )).map(mapCronRun)
}

/* ------------------------------------------------------------------ */
/* the agent inbox                                                     */
/* ------------------------------------------------------------------ */

/** Park a message until the agent's turn ends. */
export async function enqueueInboxMessage(input: {
  agentSessionId: string
  content: any[]
  delivery: MessageDelivery
  origin: MessageOrigin
}): Promise<AgentInboxMessage> {
  const row = await queryOne(
    `insert into agent_inbox (id, agent_session_id, content, delivery, origin, created_at)
     values ($1, $2, $3::jsonb, $4, $5, $6) returning *`,
    [newId('in'), input.agentSessionId, JSON.stringify(input.content), input.delivery, input.origin, nowIso()]
  )
  const message = mapInboxMessage(row)
  bus.publish({ type: 'agent-inbox-changed', agentSessionId: input.agentSessionId, message })
  return message
}

export async function listInboxMessages(
  agentSessionId: string,
  pendingOnly = true
): Promise<AgentInboxMessage[]> {
  const rows = await query(
    `select * from agent_inbox where agent_session_id = $1
      ${pendingOnly ? 'and delivered_at is null' : ''} order by seq asc`,
    [agentSessionId]
  )
  return rows.map(mapInboxMessage)
}

/**
 * Take everything that is waiting, marking it delivered in the same statement.
 *
 * One statement so two drains — a turn ending while the adapter reattaches, say
 * — can never hand the same message over twice. The claim happens before the
 * prompt, so a turn that fails to start loses the messages rather than
 * replaying them forever; the failure is recorded as an `error` event on the
 * session.
 *
 * All of them rather than the oldest one: everything that piled up during a
 * turn is one thing to answer, and the caller hands the batch over as a single
 * prompt. `returning` says nothing about order, so the rows are sorted by `seq`
 * here — the caller's whole job depends on it.
 */
export async function claimInboxMessages(agentSessionId: string): Promise<AgentInboxMessage[]> {
  const rows = await query(
    `update agent_inbox set delivered_at = $2
      where id in (
        select id from agent_inbox
         where agent_session_id = $1 and delivered_at is null
         order by seq asc
         for update skip locked
      )
      returning *`,
    [agentSessionId, nowIso()]
  )
  const messages = rows.map(mapInboxMessage).sort((a, b) => a.seq - b.seq)
  // One event per row, as when they were enqueued: the panel is showing rows.
  for (const message of messages) {
    bus.publish({ type: 'agent-inbox-changed', agentSessionId, message })
  }
  return messages
}

/** Drop a message that is still waiting. Returns false if it already went out. */
export async function deleteInboxMessage(id: string): Promise<AgentInboxMessage | null> {
  const row = await queryOne(
    'delete from agent_inbox where id = $1 and delivered_at is null returning *',
    [id]
  )
  if (!row) return null
  const message = mapInboxMessage(row)
  bus.publish({ type: 'agent-inbox-changed', agentSessionId: message.agentSessionId, message })
  return message
}

/* ------------------------------------------------------------------ */
/* subscriptions between agents                                        */
/* ------------------------------------------------------------------ */

export async function addAgentSubscription(subscriberId: string, targetId: string): Promise<void> {
  await query(
    `insert into agent_subscriptions (subscriber_id, target_id, created_at)
     values ($1, $2, $3) on conflict do nothing`,
    [subscriberId, targetId, nowIso()]
  )
}

export async function removeAgentSubscription(subscriberId: string, targetId: string): Promise<boolean> {
  const rows = await query(
    'delete from agent_subscriptions where subscriber_id = $1 and target_id = $2 returning subscriber_id',
    [subscriberId, targetId]
  )
  return rows.length > 0
}

/** Every agent somebody is following, so the notifier can skip the rest. */
export async function listAllSubscriptionTargets(): Promise<string[]> {
  const rows = await query<{ target_id: string }>('select distinct target_id from agent_subscriptions')
  return rows.map(row => row.target_id)
}

/** Who has asked to hear about this agent. */
export async function listAgentSubscribers(targetId: string): Promise<string[]> {
  const rows = await query<{ subscriber_id: string }>(
    'select subscriber_id from agent_subscriptions where target_id = $1 order by created_at asc',
    [targetId]
  )
  return rows.map(row => row.subscriber_id)
}

/** What this agent has asked to hear about. */
export async function listAgentSubscriptions(subscriberId: string): Promise<AgentSubscription[]> {
  const rows = await query(
    'select * from agent_subscriptions where subscriber_id = $1 order by created_at asc',
    [subscriberId]
  )
  return rows.map(row => ({
    subscriberId: row.subscriber_id,
    targetId: row.target_id,
    createdAt: row.created_at
  }))
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
