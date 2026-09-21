import { describe, expect, it } from 'vitest'

import { run } from '../../server/lib/dev-env/docker'

/**
 * `run()` is the only way Domo shells out. It spawns without a shell, so the
 * argument array is handed to the process verbatim — that is what makes a
 * container name or a file path with spaces in it safe.
 */
describe('run', () => {
  it('passes arguments through verbatim, one process argument each', async () => {
    const output = await run(process.execPath, [
      '-e',
      'process.stdout.write(JSON.stringify(process.argv.slice(1)))',
      'two words',
      '$(echo pwned)',
      'semi;colon'
    ])

    expect(JSON.parse(output.stdout)).toEqual(['two words', '$(echo pwned)', 'semi;colon'])
  })

  it('trims trailing whitespace by default, and keeps it on request', async () => {
    const args = ['-e', 'process.stdout.write("value\\n\\n")']

    await expect(run(process.execPath, args)).resolves.toMatchObject({ stdout: 'value' })
    await expect(run(process.execPath, args, { trimOutput: false })).resolves.toMatchObject({ stdout: 'value\n\n' })
  })

  it('feeds stdin to the process', async () => {
    const output = await run(
      process.execPath,
      ['-e', 'process.stdin.pipe(process.stdout)'],
      { input: 'piped content' }
    )

    expect(output.stdout).toBe('piped content')
  })

  it('rejects with the program, the sub-command and stderr when it fails', async () => {
    await expect(run(process.execPath, ['-e', 'console.error("boom"); process.exit(3)']))
      .rejects.toThrow(/^node -e failed: boom$/)
  })

  it('falls back to the exit code when the process said nothing', async () => {
    await expect(run(process.execPath, ['-e', 'process.exit(3)'])).rejects.toThrow(/exit 3/)
  })

  it('returns the output of a failed process when failure is allowed', async () => {
    const output = await run(
      process.execPath,
      ['-e', 'process.stdout.write("partial"); process.exit(1)'],
      { allowFailure: true }
    )

    expect(output.stdout).toBe('partial')
  })

  it('rejects instead of hanging when the program does not exist', async () => {
    await expect(run('domo-no-such-program', ['--version'])).rejects.toThrow(/ENOENT/)
  })

  it('runs in the directory it was given', async () => {
    const output = await run(process.execPath, ['-e', 'process.stdout.write(process.cwd())'], { cwd: '/tmp' })

    expect(output.stdout).toMatch(/tmp$/)
  })
})
