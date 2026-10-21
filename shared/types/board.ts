import { z } from 'zod'

/**
 * The status board: the human's up-to-date view of one agent's work, kept by
 * the agent, beside its transcript. An assistant's board is the assistant's,
 * so it carries across handoffs; any other session has its own.
 *
 * Element kinds are presentational on purpose. An agent maps whatever it works
 * on onto a handful of shapes the UI knows how to render with quick actions,
 * and the markdown body of each covers the long tail.
 *
 * Three kinds of state, written by different hands and stored apart so neither
 * overwrites the other: `content` is the agent's, `response` and the user's
 * entries in `thread` are what the human submitted, and a `BoardDraft` is what
 * the human has not submitted yet.
 */

export const BOARD_LIMITS = {
  elements: 60,
  items: 40,
  options: 8,
  metrics: 12,
  groups: 16,
  title: 200,
  body: 4000,
  text: 500,
  headline: 300,
  reply: 4000,
  thread: 30
} as const

export const BOARD_ELEMENT_KINDS = ['question', 'checklist', 'decision', 'note', 'links', 'metrics'] as const
export type BoardElementKind = typeof BOARD_ELEMENT_KINDS[number]

export const BOARD_ITEM_STATUSES = ['todo', 'ongoing', 'done', 'blocked'] as const
export type BoardItemStatus = typeof BOARD_ITEM_STATUSES[number]

export const BOARD_NOTE_TONES = ['info', 'success', 'warning', 'error'] as const
export const BOARD_LINK_KINDS = ['url', 'file', 'branch', 'pr', 'commit', 'other'] as const
export const BOARD_GROUP_STATUSES = ['active', 'waiting', 'blocked', 'done'] as const
export type BoardGroupStatus = typeof BOARD_GROUP_STATUSES[number]
export const BOARD_GROUP_LINK_KINDS = ['agent', 'environment', 'branch', 'url'] as const

export const boardId = z.string().regex(
  /^[A-Za-z0-9][\w.:-]{0,63}$/,
  'an id is 1-64 letters, digits, "_", ".", ":" or "-", starting with a letter or digit'
)
export const boardGroupTitle = z.string().trim().min(1).max(80)

const text = (max: number) => z.string().trim().min(1).max(max)
const body = z.string().max(BOARD_LIMITS.body).nullable().optional()

function uniqueIds(items: Array<{ id: string }>, context: z.RefinementCtx) {
  const seen = new Set<string>()
  for (const item of items) {
    if (seen.has(item.id)) context.addIssue({ code: 'custom', message: `duplicate item id "${item.id}"` })
    seen.add(item.id)
  }
}

export const boardQuestionOption = z.object({
  id: boardId,
  label: text(BOARD_LIMITS.title),
  description: z.string().max(BOARD_LIMITS.text).optional()
}).strict()

export const boardChecklistItem = z.object({
  id: boardId,
  text: text(BOARD_LIMITS.text),
  status: z.enum(BOARD_ITEM_STATUSES).default('todo'),
  note: z.string().max(BOARD_LIMITS.text).optional()
}).strict()

export const boardLinkItem = z.object({
  id: boardId,
  label: text(BOARD_LIMITS.title),
  target: text(1000),
  kind: z.enum(BOARD_LINK_KINDS).default('url')
}).strict()

export const boardMetricItem = z.object({
  id: boardId,
  label: text(BOARD_LIMITS.title),
  value: z.union([z.number(), z.string().max(80)]),
  max: z.number().positive().optional(),
  unit: z.string().max(20).optional()
}).strict()

const base = { title: text(BOARD_LIMITS.title), body }

/** What the agent says: discriminated by `kind`. */
export const boardElementContent = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('question'),
    ...base,
    options: z.array(boardQuestionOption).max(BOARD_LIMITS.options).default([]).superRefine(uniqueIds),
    multiple: z.boolean().default(false),
    allowCustom: z.boolean().default(true)
  }).strict(),
  z.object({
    kind: z.literal('checklist'),
    ...base,
    items: z.array(boardChecklistItem).max(BOARD_LIMITS.items).default([]).superRefine(uniqueIds)
  }).strict(),
  z.object({
    kind: z.literal('decision'),
    ...base,
    alternatives: z.array(text(BOARD_LIMITS.title)).max(BOARD_LIMITS.options).optional()
  }).strict(),
  z.object({
    kind: z.literal('note'),
    ...base,
    tone: z.enum(BOARD_NOTE_TONES).default('info')
  }).strict(),
  z.object({
    kind: z.literal('links'),
    ...base,
    items: z.array(boardLinkItem).max(BOARD_LIMITS.items).default([]).superRefine(uniqueIds)
  }).strict(),
  z.object({
    kind: z.literal('metrics'),
    ...base,
    items: z.array(boardMetricItem).max(BOARD_LIMITS.metrics).default([]).superRefine(uniqueIds)
  }).strict()
])
export type BoardElementContent = z.infer<typeof boardElementContent>
export type BoardChecklistItem = z.infer<typeof boardChecklistItem>
export type BoardLinkItem = z.infer<typeof boardLinkItem>
export type BoardMetricItem = z.infer<typeof boardMetricItem>
export type BoardQuestionOption = z.infer<typeof boardQuestionOption>

/** What a group links to: the agents, environments and branches doing its work. */
export const boardGroupLink = z.object({
  kind: z.enum(BOARD_GROUP_LINK_KINDS),
  target: text(1000),
  label: z.string().max(BOARD_LIMITS.title).optional()
}).strict()
export type BoardGroupLink = z.infer<typeof boardGroupLink>

/**
 * A group: one workstream on the board. Elements name theirs by title. Its
 * summary and status are the line the human reads first.
 */
export interface BoardGroup {
  title: string
  summary?: string
  /** waiting: on the human. */
  status?: BoardGroupStatus
  links?: BoardGroupLink[]
}

/** What the human has submitted on an element. */
export interface BoardResponse {
  answer?: { options: string[], text?: string, at: string }
  acknowledgedAt?: string
  dismissedAt?: string
  /** Done checklist items the human has seen; they fold away. */
  acknowledgedItems?: string[]
}

export interface BoardThreadEntry {
  from: 'user' | 'agent'
  text: string
  at: string
}

export interface BoardElement {
  id: string
  /** A group title, or null for the top of the board. */
  group: string | null
  position: number
  content: BoardElementContent
  response: BoardResponse
  thread: BoardThreadEntry[]
  createdAt: string
  updatedAt: string
}

export interface Board {
  ownerId: string
  headline: string | null
  /** In order. */
  groups: BoardGroup[]
  /** Groups the human folded (true) or unfolded (false); otherwise a done group is folded. */
  folds: Record<string, boolean>
  elements: BoardElement[]
  /** When the agent last changed anything; against `seenAt`, whether there is something new. */
  agentChangedAt: string | null
  seenAt: string | null
}

/** What the human has changed on one element and not yet submitted. */
export const boardDraft = z.object({
  answer: z.object({
    options: z.array(boardId).max(BOARD_LIMITS.options).default([]),
    text: z.string().max(BOARD_LIMITS.reply).optional()
  }).strict().optional(),
  reply: z.string().max(BOARD_LIMITS.reply).optional(),
  acknowledge: z.boolean().optional(),
  acknowledgeItems: z.array(boardId).max(BOARD_LIMITS.items).optional(),
  dismiss: z.boolean().optional()
}).strict()
export type BoardDraft = z.infer<typeof boardDraft>

/* ------------------------------------------------------------------ */
/* the agent's edits                                                   */
/* ------------------------------------------------------------------ */

const anchor = { before: boardId.optional(), after: boardId.optional() }

/**
 * `put` carries the kind's own fields flat, beside the common ones, so an edit
 * costs only the fields it changes. They are checked once merged into the
 * element, against `boardElementContent`.
 */
export const boardOp = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('put'),
    id: boardId,
    kind: z.enum(BOARD_ELEMENT_KINDS).optional(),
    title: z.string().optional(),
    body: z.string().nullable().optional(),
    group: boardGroupTitle.nullable().optional(),
    ...anchor,
    options: z.array(z.any()).optional(),
    multiple: z.boolean().optional(),
    allowCustom: z.boolean().optional(),
    items: z.array(z.any()).optional(),
    alternatives: z.array(z.any()).optional(),
    tone: z.enum(BOARD_NOTE_TONES).optional(),
    reopen: z.boolean().optional()
  }).strict(),
  z.object({
    op: z.literal('items'),
    id: boardId,
    set: z.array(z.object({ id: boardId }).passthrough()).optional(),
    remove: z.array(boardId).optional()
  }).strict(),
  z.object({ op: z.literal('remove'), id: boardId }).strict(),
  z.object({
    op: z.literal('move'),
    id: boardId,
    group: boardGroupTitle.nullable().optional(),
    ...anchor
  }).strict(),
  z.object({
    op: z.literal('group'),
    title: boardGroupTitle,
    renameTo: boardGroupTitle.optional(),
    before: boardGroupTitle.optional(),
    after: boardGroupTitle.optional(),
    summary: z.string().trim().max(BOARD_LIMITS.headline).nullable().optional(),
    status: z.enum(BOARD_GROUP_STATUSES).nullable().optional(),
    links: z.array(boardGroupLink).max(BOARD_LIMITS.options).nullable().optional()
  }).strict(),
  z.object({ op: z.literal('remove_group'), title: boardGroupTitle }).strict(),
  z.object({ op: z.literal('reply'), id: boardId, text: text(BOARD_LIMITS.reply) }).strict(),
  z.object({ op: z.literal('headline'), text: z.string().trim().max(BOARD_LIMITS.headline).nullable() }).strict()
])
export type BoardOp = z.infer<typeof boardOp>
