import { describe, it, expect } from 'vitest'
import { findAvailablePort } from './process'
import net from 'net'

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
})
