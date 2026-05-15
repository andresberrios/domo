/**
 * Zod schemas + inferred TS types for the slice of coastd's HTTP API Domo
 * uses. Mirrors `coast-core/src/protocol/` and `coast-core/src/types/`
 * (Coast's Rust types, exported via `ts-rs`). We validate every coastd
 * response against these schemas at the boundary so type drift across
 * Coast versions surfaces as a structured error, not a runtime crash deep
 * in Vue.
 *
 * If/when Coast publishes their `ts-rs`-generated TypeScript bindings as
 * an npm package or we vendor them into this repo, replace these schemas
 * with imports — the runtime client layer in `client.ts` will keep working.
 */
import { z } from 'zod'

export const InstanceStatus = z.enum([
  'enqueued',
  'provisioning',
  'assigning',
  'unassigning',
  'starting',
  'stopping',
  'running',
  'stopped',
  'checked_out',
  'idle',
])
export type InstanceStatus = z.infer<typeof InstanceStatus>

export const RuntimeType = z.enum(['dind', 'sysbox', 'podman'])
export type RuntimeType = z.infer<typeof RuntimeType>

export const PortMapping = z.object({
  logical_name: z.string(),
  canonical_port: z.number().int(),
  dynamic_port: z.number().int(),
  is_primary: z.boolean().default(false),
})
export type PortMapping = z.infer<typeof PortMapping>

export const InstanceSummary = z.object({
  name: z.string(),
  project: z.string(),
  status: InstanceStatus,
  branch: z.string().nullable(),
  runtime: RuntimeType,
  checked_out: z.boolean(),
  project_root: z.string().nullable().optional(),
  worktree: z.string().nullable().optional(),
  build_id: z.string().nullable().optional(),
}).passthrough()
export type InstanceSummary = z.infer<typeof InstanceSummary>

export const KnownProject = z.object({
  name: z.string(),
  project_root: z.string().nullable().optional(),
  archived: z.boolean().default(false),
}).passthrough()
export type KnownProject = z.infer<typeof KnownProject>

export const LsResponse = z.object({
  instances: z.array(InstanceSummary),
  known_projects: z.array(KnownProject).default([]),
}).passthrough()
export type LsResponse = z.infer<typeof LsResponse>

export const PortsResponse = z.object({
  name: z.string(),
  ports: z.array(PortMapping),
  message: z.string().nullable().optional(),
  subdomain_host: z.string().nullable().optional(),
}).passthrough()
export type PortsResponse = z.infer<typeof PortsResponse>

export const ServiceStatus = z.object({
  name: z.string(),
  status: z.string(),
  ports: z.string(),
  image: z.string(),
  kind: z.string().nullable().optional(),
}).passthrough()
export type ServiceStatus = z.infer<typeof ServiceStatus>

export const PsResponse = z.object({
  name: z.string(),
  services: z.array(ServiceStatus),
}).passthrough()
export type PsResponse = z.infer<typeof PsResponse>

export const LookupInstance = z.object({
  name: z.string(),
  status: InstanceStatus,
  checked_out: z.boolean().default(false),
  branch: z.string().nullable().optional(),
  primary_url: z.string().nullable().optional(),
  ports: z.array(PortMapping).default([]),
}).passthrough()
export type LookupInstance = z.infer<typeof LookupInstance>

export const LookupResponse = z.object({
  project: z.string(),
  worktree: z.string().nullable().optional(),
  project_root: z.string().nullable().optional(),
  instances: z.array(LookupInstance),
}).passthrough()
export type LookupResponse = z.infer<typeof LookupResponse>

/**
 * `event` tag for the WebSocket /events stream. Mirrors `CoastEvent` in
 * `coast-core/src/protocol/events.rs`. Kept as a discriminated union so
 * callers can `switch (e.event)`.
 */
export const CoastEvent = z.discriminatedUnion('event', [
  z.object({ event: z.literal('instance.created'), name: z.string(), project: z.string(), remote_host: z.string().nullish() }),
  z.object({ event: z.literal('instance.removed'), name: z.string(), project: z.string() }),
  z.object({ event: z.literal('instance.started'), name: z.string(), project: z.string(), remote_host: z.string().nullish() }),
  z.object({ event: z.literal('instance.stopped'), name: z.string(), project: z.string() }),
  z.object({ event: z.literal('instance.assigned'), name: z.string(), project: z.string(), worktree: z.string() }),
  z.object({ event: z.literal('instance.unassigned'), name: z.string(), project: z.string(), worktree: z.string() }),
  z.object({ event: z.literal('instance.checked_out'), name: z.string().nullable(), project: z.string() }),
  z.object({ event: z.literal('instance.status_changed'), name: z.string(), project: z.string(), status: z.string() }),
  z.object({ event: z.literal('instance.services_restarted'), name: z.string(), project: z.string() }),
  z.object({ event: z.literal('build.started'), project: z.string() }),
  z.object({ event: z.literal('build.completed'), project: z.string() }),
  z.object({ event: z.literal('build.failed'), project: z.string(), error: z.string() }),
  z.object({ event: z.literal('build.removing'), project: z.string(), build_ids: z.array(z.string()).default([]) }),
  z.object({ event: z.literal('build.removed'), project: z.string(), build_ids: z.array(z.string()).default([]) }),
  z.object({ event: z.literal('project.archived'), project: z.string() }),
  z.object({ event: z.literal('project.unarchived'), project: z.string() }),
  z.object({ event: z.literal('project.git_changed'), project: z.string() }),
  z.object({ event: z.literal('service.stopping'), name: z.string(), project: z.string(), service: z.string() }),
  z.object({ event: z.literal('service.stopped'), name: z.string(), project: z.string(), service: z.string() }),
  z.object({ event: z.literal('service.starting'), name: z.string(), project: z.string(), service: z.string() }),
  z.object({ event: z.literal('service.started'), name: z.string(), project: z.string(), service: z.string() }),
  z.object({ event: z.literal('service.restarting'), name: z.string(), project: z.string(), service: z.string() }),
  z.object({ event: z.literal('service.restarted'), name: z.string(), project: z.string(), service: z.string() }),
  z.object({ event: z.literal('service.removing'), name: z.string(), project: z.string(), service: z.string() }),
  z.object({ event: z.literal('service.removed'), name: z.string(), project: z.string(), service: z.string() }),
  z.object({ event: z.literal('service.error'), name: z.string(), project: z.string(), service: z.string(), error: z.string() }),
  z.object({ event: z.literal('port.primary_changed'), name: z.string(), project: z.string(), service: z.string().nullable() }),
  z.object({ event: z.literal('port.health_changed'), name: z.string(), project: z.string() }),
  z.object({ event: z.literal('docker.status_changed'), connected: z.boolean() }),
])
export type CoastEvent = z.infer<typeof CoastEvent>

export const BuildProgressEvent = z.object({
  // Shape varies (steps, items, percent…). We keep it loose at the boundary
  // and let the chat-UI consume it as opaque progress for now; the SSE
  // contract is `event: progress | complete | error`.
}).passthrough()
export type BuildProgressEvent = z.infer<typeof BuildProgressEvent>
