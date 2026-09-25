import { createHash } from 'node:crypto'

import { resourcePrefix, run } from './docker'
import { RUNTIME_IMAGE } from './runtime-volume'
import { portHelperRunArgs } from './service-ports'

/**
 * The one port helper: a long-lived container in the host's PID namespace that
 * enters other containers' network namespaces by PID (see `service-ports.ts`).
 * The Ports panel reads and forwards services' ports through it, and the DooD
 * proxy runs each environment's publishing relay and sets up its
 * `host.docker.internal` redirect through it (`server/lib/dood/network.ts`).
 *
 * Its image is `RUNTIME_IMAGE` plus `iptables`, built once and named by a hash
 * of what went into it, the same way the runtime volume is: the redirect is an
 * iptables rule in the environment's namespace, and neither the runtime image
 * nor a project's image can be relied on to carry iptables.
 */

const DOCKERFILE = [
  `FROM ${RUNTIME_IMAGE}`,
  'RUN apt-get update && apt-get install -y --no-install-recommends iptables && rm -rf /var/lib/apt/lists/*',
  ''
].join('\n')

/** The helper, named by install so two Domos on one daemon do not share it. */
export function portHelperName(): string {
  return `${resourcePrefix()}port-helper`
}

export function portHelperImage(): string {
  return `${resourcePrefix()}port-helper:${createHash('sha256').update(DOCKERFILE).digest('hex').slice(0, 12)}`
}

let imageReady: Promise<string> | null = null

/**
 * Build the helper image if it is not there. A build needs the network (apt),
 * so one that fails leaves the helper on the plain runtime image: ports still
 * work, and only the `host.docker.internal` redirect is missing — which
 * `network.ts` warns about when it cannot apply it.
 */
function ensureHelperImage(): Promise<string> {
  imageReady ??= (async () => {
    const image = portHelperImage()
    const found = await run('docker', ['image', 'inspect', '--format', '{{.Id}}', image], { allowFailure: true })
    if (found.stdout) return image
    try {
      await run('docker', ['build', '--quiet', '--tag', image, '-'], { input: DOCKERFILE })
      return image
    } catch (error) {
      console.warn(
        `[ports] could not build the port helper image (${error instanceof Error ? error.message : error}); `
        + 'using the runtime image, so host.docker.internal will not reach loopback-only servers in environments.'
      )
      imageReady = null
      return RUNTIME_IMAGE
    }
  })()
  return imageReady
}

let helperReady: Promise<string> | null = null
/** Set once a check has seen the helper running; a caller in a hurry trusts it rather than paying for a check. */
let helperKnown: string | null = null

/**
 * Start the port helper if it is not running, once at a time. A helper on
 * another image — an older Domo's, one without iptables — is replaced; that
 * kills every relay running in it, which their owners notice and restart.
 */
export function ensurePortHelper(): Promise<string> {
  helperReady ??= (async () => {
    const name = portHelperName()
    const image = await ensureHelperImage()
    const found = await run('docker', [
      'inspect', '--format', '{{.State.Running}} {{.Config.Image}}', name
    ], { allowFailure: true })
    const [running, current] = found.stdout.split(' ')
    if (found.stdout && current !== image) {
      await run('docker', ['rm', '--force', name], { allowFailure: true })
    } else if (running === 'true') {
      return name
    } else if (running === 'false') {
      await run('docker', ['start', name])
      return name
    }
    await run('docker', portHelperRunArgs(name, image)).catch((error) => {
      // Perhaps the image went away under us: look for it again next time.
      imageReady = null
      throw error
    })
    return name
  })().then((name) => {
    helperKnown = name
    return name
  }).finally(() => { helperReady = null })
  return helperReady
}

/** The helper's name without a check when one has already seen it running. */
export async function knownPortHelper(): Promise<string> {
  return helperKnown ?? ensurePortHelper()
}
