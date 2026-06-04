import { describe, it, expect } from 'vitest'
import { findAvailablePort, isPortListening } from './process'
import net from 'net'

function listenOn(host: string, port: number = 0): Promise<{ server: net.Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(port, host, () => {
      const addr = server.address()
      if (addr && typeof addr === 'object') {
        resolve({ server, port: addr.port })
      } else {
        reject(new Error('listen returned no address'))
      }
    })
  })
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()))
}

describe('findAvailablePort', () => {
  it('finds an available port in the given range', async () => {
    const port = await findAvailablePort('127.0.0.1', 49200, 49300)

    expect(port).toBeGreaterThanOrEqual(49200)
    expect(port).toBeLessThanOrEqual(49300)
  })

  it('skips ports in the excludePorts set', async () => {
    const firstPort = await findAvailablePort('127.0.0.1', 49200, 49300)

    const excluded = new Set([firstPort])
    const result = await findAvailablePort('127.0.0.1', firstPort, 49300, excluded)

    expect(result).not.toBe(firstPort)
    expect(result).toBeGreaterThanOrEqual(firstPort + 1)
  })

  it('skips multiple excluded ports', async () => {
    const base = 49300
    const excluded = new Set([base, base + 1, base + 2])
    const result = await findAvailablePort('127.0.0.1', base, base + 100, excluded)

    expect(excluded.has(result)).toBe(false)
    expect(result).toBeGreaterThanOrEqual(base + 3)
  })

  it('rejects when all ports in range are excluded', async () => {
    const base = 49400
    const excluded = new Set([base, base + 1, base + 2])

    await expect(
      findAvailablePort('127.0.0.1', base, base + 2, excluded)
    ).rejects.toThrow('No available ports found')
  })

  it('skips a port that is actually in use', async () => {
    const base = 49500
    // Bind a port to simulate it being in use
    const server = net.createServer()
    await new Promise<void>((resolve) => {
      server.listen(base, '127.0.0.1', () => resolve())
    })

    try {
      const result = await findAvailablePort('127.0.0.1', base, base + 100)
      expect(result).toBeGreaterThan(base)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })

  // Regression for #806: when a port is reported "free" by a flawed
  // single-bind probe but is actually owned by a process listening on a
  // wildcard or different-family interface, the old logic returned the busy
  // port. `findAvailablePort` must walk past *every* busy port in sequence,
  // not just the first one.
  it('skips multiple sequentially-busy ports', async () => {
    const base = 49600
    const { server: s1, port: p1 } = await listenOn('127.0.0.1', base)
    let s2: net.Server | undefined
    try {
      const r1 = await listenOn('127.0.0.1', p1 + 1)
      s2 = r1.server
      const result = await findAvailablePort('127.0.0.1', p1, p1 + 100)
      expect(result).toBeGreaterThanOrEqual(p1 + 2)
    } finally {
      if (s2) await closeServer(s2)
      await closeServer(s1)
    }
  })

  // Wildcard `0.0.0.0` listener: the original isPortListening only bound on
  // the requested host (127.0.0.1), which on some platforms succeeds even
  // when a peer owns the port via 0.0.0.0. The connect+multi-host bind
  // probe must catch it via the connect leg (the listener is reachable on
  // loopback) regardless of the platform's specific bind semantics.
  it('skips a port occupied by a wildcard 0.0.0.0 listener', async () => {
    const { server, port } = await listenOn('0.0.0.0')
    try {
      const result = await findAvailablePort('127.0.0.1', port, port + 100)
      expect(result).toBeGreaterThan(port)
    } finally {
      await closeServer(server)
    }
  })
})

describe('isPortListening', () => {
  it('returns true for a port bound on the same host', async () => {
    const { server, port } = await listenOn('127.0.0.1')
    try {
      expect(await isPortListening(port, '127.0.0.1')).toBe(true)
    } finally {
      await closeServer(server)
    }
  })

  it('returns true for a port bound on the wildcard interface', async () => {
    const { server, port } = await listenOn('0.0.0.0')
    try {
      expect(await isPortListening(port, '127.0.0.1')).toBe(true)
    } finally {
      await closeServer(server)
    }
  })

  it('returns false for a port that nothing owns', async () => {
    // Allocate-then-release to find a port that is genuinely free.
    const { server, port } = await listenOn('127.0.0.1')
    await closeServer(server)
    expect(await isPortListening(port, '127.0.0.1')).toBe(false)
  })
})
