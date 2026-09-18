import { createHash } from 'node:crypto'

import { beforeEach, describe, expect, it, vi } from 'vitest'

const query = vi.fn()
vi.mock('../../server/lib/db', () => ({ query }))

const {
  DEFAULTS,
  DEFAULT_SYSTEM_INSTRUCTION,
  PREVIOUS_DEFAULT_SYSTEM_INSTRUCTIONS,
  getSettings
} = await import('../../server/lib/settings')

function stored(rows: Record<string, unknown>) {
  query.mockResolvedValue(Object.entries(rows).map(([key, value]) => ({ key, value: { v: value } })))
}

function sha(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

describe('getSettings', () => {
  beforeEach(() => {
    query.mockReset()
    stored({})
  })

  it('returns the defaults for a fresh install', async () => {
    await expect(getSettings()).resolves.toEqual(DEFAULTS)
  })

  it('lets stored values win over the defaults', async () => {
    stored({ voiceName: 'Charon', autoApprovePermissions: true })

    const settings = await getSettings()

    expect(settings.voiceName).toBe('Charon')
    expect(settings.autoApprovePermissions).toBe(true)
    expect(settings.liveModel).toBe(DEFAULTS.liveModel)
  })

  it('reads values that were stored unwrapped', async () => {
    // Older rows hold the bare value instead of `{ v: … }`.
    query.mockResolvedValue([{ key: 'voiceName', value: 'Kore' }])

    await expect(getSettings()).resolves.toMatchObject({ voiceName: 'Kore' })
  })

  it('keeps a system instruction the user actually wrote', async () => {
    stored({ systemInstruction: 'Be terse. Speak Spanish.' })

    await expect(getSettings()).resolves.toMatchObject({ systemInstruction: 'Be terse. Speak Spanish.' })
  })

  it('keeps the current default when it is what is stored', async () => {
    stored({ systemInstruction: DEFAULT_SYSTEM_INSTRUCTION })

    await expect(getSettings()).resolves.toMatchObject({ systemInstruction: DEFAULT_SYSTEM_INSTRUCTION })
  })

  /**
   * The settings page saves the whole form, so most installs have a past
   * default stored verbatim. Each one has to be recognised or that install
   * would be stuck on a prompt nobody chose.
   */
  it.each(PREVIOUS_DEFAULT_SYSTEM_INSTRUCTIONS.map((value, index) => [index, value]))(
    'upgrades an install still carrying past default #%i',
    async (_index, previous) => {
      stored({ systemInstruction: previous })

      await expect(getSettings()).resolves.toMatchObject({ systemInstruction: DEFAULT_SYSTEM_INSTRUCTION })
    }
  )

  it('does not recognise a past default that was edited', async () => {
    stored({ systemInstruction: `${PREVIOUS_DEFAULT_SYSTEM_INSTRUCTIONS[0]!}\n- And always say please.` })

    await expect(getSettings()).resolves.not.toMatchObject({ systemInstruction: DEFAULT_SYSTEM_INSTRUCTION })
  })
})

/**
 * Every default that ever shipped has to stay in the list byte for byte.
 * Hashes, not copies of the text: an in-place edit of a past default (the
 * mistake CLAUDE.md warns about) changes one, and appending a new one only
 * appends. When you change `DEFAULT_SYSTEM_INSTRUCTION`, append the old text to
 * `PREVIOUS_DEFAULT_SYSTEM_INSTRUCTIONS` and update these hashes.
 */
describe('system instruction history', () => {
  it('still contains every default that ever shipped, unedited', () => {
    expect(PREVIOUS_DEFAULT_SYSTEM_INSTRUCTIONS.map(sha)).toEqual([
      'a8d75c79202f41d480a57607df8ab3f6722305440e2728bfa17f912c8593250f',
      '2b53d4bc3ffd9fd562102c081050debcc1ef55cb7696e1c6ab77467cdbc3c170'
    ])
  })

  it('has appended the outgoing default whenever the current one changed', () => {
    expect(sha(DEFAULT_SYSTEM_INSTRUCTION)).toBe(
      '8e8fd2cfe8d30c377100dfb6a4aad366265f01c08bd697d4d6ef9ecfc9cc3d4c'
    )
  })

  it('never lists the current default as a past one', () => {
    expect(PREVIOUS_DEFAULT_SYSTEM_INSTRUCTIONS).not.toContain(DEFAULT_SYSTEM_INSTRUCTION)
    expect(new Set(PREVIOUS_DEFAULT_SYSTEM_INSTRUCTIONS).size).toBe(PREVIOUS_DEFAULT_SYSTEM_INSTRUCTIONS.length)
  })
})
