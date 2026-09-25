import { describe, expect, it } from 'vitest'

import {
  inServiceNetwork,
  parseListeningPorts,
  portHelperRunArgs,
  requestedPorts,
  scannableServices,
  serviceReferences,
  siblingFromInspect,
  type SiblingContainer
} from '../../server/lib/dev-env/service-ports'

/**
 * One port helper serves every service: it enters a service's network
 * namespace by PID, read fresh each time, so a restarted service needs
 * nothing replaced — the thing a helper per service could not do.
 */

function container(overrides: Partial<SiblingContainer> & { id: string }): SiblingContainer {
  return {
    name: overrides.id,
    running: true,
    pid: 4242,
    labels: { 'domo.env': 'env_1' },
    networkMode: 'stack_default',
    ...overrides
  }
}

describe('scannableServices', () => {
  it('keeps running services with a namespace of their own', () => {
    const services = scannableServices([
      container({ id: 'web' }),
      container({ id: 'stopped', running: false, pid: 0 }),
      container({ id: 'sidecar', networkMode: 'container:web' }),
      container({ id: 'hostnet', networkMode: 'host' }),
      container({ id: 'offline', networkMode: 'none' }),
      container({ id: 'helper', labels: { 'domo.role': 'port-helper' } })
    ])

    expect(services.map(service => service.id)).toEqual(['web'])
  })
})

describe('the port helper', () => {
  it('sees every PID and may enter a namespace, without being privileged', () => {
    const args = portHelperRunArgs('domo-dev-port-helper', 'node:22-bookworm-slim')

    expect(args).toEqual(expect.arrayContaining(['--pid', 'host', 'SYS_ADMIN', 'SYS_PTRACE', 'domo.role=port-helper']))
    expect(args).not.toContain('--privileged')
    // No environment label: it serves them all, so no environment's sweep may take it.
    expect(args.join(' ')).not.toContain('domo.env')
  })

  it('runs a command inside a service\'s network namespace', () => {
    expect(inServiceNetwork('h', 4242, ['cat', '/proc/net/tcp'])).toEqual(
      ['exec', 'h', 'nsenter', '-t', '4242', '-n', 'cat', '/proc/net/tcp']
    )
    expect(inServiceNetwork('h', 4242, ['node'], true).slice(0, 3)).toEqual(['exec', '--interactive', 'h'])
  })
})

describe('parseListeningPorts', () => {
  it('reads LISTEN sockets out of /proc/net/tcp and tcp6, and nothing else', () => {
    const proc = [
      '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
      '   0: 0100007F:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 1 1',
      '   1: 0100007F:0BB8 0100007F:D431 01 00000000:00000000 00:00000000 00000000     0        0 2 1',
      '  sl  local_address                         remote_address                        st tx_queue',
      '   0: 00000000000000000000000000000000:1F90 00000000000000000000000000000000:0000 0A 00000000:00000000'
    ].join('\n')

    // A loopback listener (127.0.0.1:3000) is exactly what the helper is for.
    expect([...parseListeningPorts(proc)]).toEqual([3000, 8080])
  })

  it('ignores Docker\'s embedded DNS resolver, which listens in every container on a user network', () => {
    const proc = '   0: 0B00007F:9B13 00000000:0000 0A 00000000:00000000 00:00000000 00000000 0 0 1 1\n'

    expect([...parseListeningPorts(proc)]).toEqual([])
    expect([...parseListeningPorts('LISTEN 0 4096 127.0.0.11:39699 0.0.0.0:*\n')]).toEqual([])
  })

  it('reads ss and netstat output', () => {
    expect([...parseListeningPorts('LISTEN 0 511 127.0.0.1:5173 0.0.0.0:*\n')]).toEqual([5173])
    expect([...parseListeningPorts('tcp 0 0 0.0.0.0:4000 0.0.0.0:* LISTEN\n')]).toEqual([4000])
  })
})

describe('requestedPorts and siblingFromInspect', () => {
  it('reads what the proxy wrote down, and tolerates anything else', () => {
    expect(requestedPorts({ 'domo.ports': '[{"containerPort":80,"protocol":"tcp","hostPort":8080}]' }))
      .toEqual([{ containerPort: 80, protocol: 'tcp', hostPort: 8080 }])
    expect(requestedPorts({ 'domo.ports': 'nope' })).toEqual([])
    expect(requestedPorts({})).toEqual([])
  })

  it('takes the fields the scanner needs out of docker inspect', () => {
    expect(siblingFromInspect({
      Id: 'abc',
      Name: '/stack-web-1',
      State: { Running: true, Pid: 4242 },
      Config: { Labels: { a: 'b' } },
      HostConfig: { NetworkMode: 'stack_default' }
    })).toEqual({
      id: 'abc', name: 'stack-web-1', running: true, pid: 4242, labels: { a: 'b' }, networkMode: 'stack_default'
    })
  })

  it('names a service the way the agent named it, without the environment\'s prefix', () => {
    expect(siblingFromInspect({ Id: 'abc', Name: '/env_abc-stack-web-1' }, 'env_abc').name).toBe('stack-web-1')
    // A random name carries no prefix, and is kept as it is.
    expect(siblingFromInspect({ Id: 'abc', Name: '/bold_gauss' }, 'env_abc').name).toBe('bold_gauss')
    // …and is found again from a row by either spelling.
    expect(serviceReferences('env_abc', 'stack-web-1')).toEqual(['env_abc-stack-web-1', 'stack-web-1'])
  })
})
