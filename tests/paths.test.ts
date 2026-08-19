import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WorkspacePathMapper } from '../src/paths.js'

describe('WorkspacePathMapper', () => {
  const mapper = new WorkspacePathMapper('/srv/projects', '/tmp/dsh-ssh-anchors/server')

  it('maps relative and absolute remote paths into one execution world', () => {
    expect(mapper.toRemote('app', '/srv/projects')).toBe('/srv/projects/app')
    expect(mapper.toRemote('/srv/projects/app/src')).toBe('/srv/projects/app/src')
  })

  it('maps deterministic host anchors both ways', () => {
    const anchor = resolve('/tmp/dsh-ssh-anchors/server/app/src')
    expect(mapper.toRemote(anchor)).toBe('/srv/projects/app/src')
    expect(mapper.toAnchor('/srv/projects/app/src')).toBe(anchor)
  })

  it('rejects both remote and anchor escapes', () => {
    expect(() => mapper.toRemote('/etc')).toThrow(/outside configured root/u)
    expect(() => mapper.toRemote('../escape', '/srv/projects/app')).not.toThrow()
    expect(() => mapper.toRemote('../../escape', '/srv/projects/app')).toThrow(/outside configured root/u)
  })
})
