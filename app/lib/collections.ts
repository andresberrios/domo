import { createCollection } from '@tanstack/db'
import { electricCollectionOptions } from '@tanstack/electric-db-collection'
import type { Row } from '@electric-sql/client'

/**
 * TanStack DB collections backed by ElectricSQL shapes.
 *
 * Postgres is written by the Nitro server; Electric tails the WAL and streams
 * shape changes through our `/api/shape` proxy; TanStack DB keeps the client
 * store in sync and drives every live query in the UI. Nothing here polls.
 */

function shapeUrl(): string {
  const origin = typeof window === 'undefined' ? 'http://localhost:3000' : window.location.origin
  return new URL('/api/shape', origin).href
}

const cache = new Map<string, any>()

interface ShapeDef {
  table: string
  where?: string
  params?: string[]
}

function collection(key: string, def: ShapeDef): any {
  const existing = cache.get(key)
  if (existing) return existing

  const created = createCollection(
    electricCollectionOptions({
      id: key,
      shapeOptions: {
        url: shapeUrl(),
        params: {
          table: def.table,
          ...(def.where ? { where: def.where } : {}),
          ...(def.params ? { params: def.params } : {})
        }
      },
      getKey: (row: Row) => row.id as string
    })
  )
  cache.set(key, created)
  return created
}

export const voiceSessionsCollection = () => collection('voice_sessions', { table: 'voice_sessions' })
export const agentSessionsCollection = () => collection('agent_sessions', { table: 'agent_sessions' })
export const mcpServersCollection = () => collection('mcp_servers', { table: 'mcp_servers' })
export const permissionsCollection = () => collection('agent_permissions', { table: 'agent_permissions' })
export const projectsCollection = () => collection('projects', { table: 'projects' })
export const devEnvironmentsCollection = () => collection('dev_environments', { table: 'dev_environments' })

/** Per-session shapes keep the client store small on long-running sessions. */
export const agentEventsCollection = (agentSessionId: string) =>
  collection(`agent_events:${agentSessionId}`, {
    table: 'agent_events',
    where: 'agent_session_id = $1',
    params: [agentSessionId]
  })

export const agentInboxCollection = (agentSessionId: string) =>
  collection(`agent_inbox:${agentSessionId}`, {
    table: 'agent_inbox',
    where: 'agent_session_id = $1',
    params: [agentSessionId]
  })

export const voiceMessagesCollection = (voiceSessionId: string) =>
  collection(`voice_messages:${voiceSessionId}`, {
    table: 'voice_messages',
    where: 'session_id = $1',
    params: [voiceSessionId]
  })
