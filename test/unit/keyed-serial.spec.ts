import { describe, expect, it } from 'vitest'

import { keyedSerial } from '../../server/lib/keyed-serial'

const tick = () => new Promise(resolve => setTimeout(resolve, 0))

describe('keyedSerial', () => {
  it('runs calls for one key one at a time, in order, past a failure', async () => {
    const serial = keyedSerial()
    const log: string[] = []
    let release!: () => void
    const first = serial('a', async () => {
      log.push('first:start')
      await new Promise<void>(resolve => { release = resolve })
      log.push('first:end')
      throw new Error('boom')
    })
    const second = serial('a', async () => { log.push('second'); return 2 })
    await tick()
    expect(log).toEqual(['first:start'])
    release()
    await expect(first).rejects.toThrow('boom')
    await expect(second).resolves.toBe(2)
    expect(log).toEqual(['first:start', 'first:end', 'second'])
  })

  it('does not hold one key behind another', async () => {
    const serial = keyedSerial()
    const never = serial('a', () => new Promise(() => {}))
    await expect(serial('b', async () => 'b')).resolves.toBe('b')
    void never
  })
})
