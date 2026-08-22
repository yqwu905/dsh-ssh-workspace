import { describe, expect, it } from 'vitest'
import { remoteWorkspaceTitle } from '../src/workspaces.js'

describe('remoteWorkspaceTitle', () => {
  it('includes the server name and remote folder name by default', () => {
    expect(remoteWorkspaceTitle('A800', '/srv/projects/shared')).toBe('A800 / shared')
    expect(remoteWorkspaceTitle('Ascend 54', '/home/tester/shared')).toBe('Ascend 54 / shared')
  })

  it('keeps a configured title while qualifying it with the server name', () => {
    expect(remoteWorkspaceTitle('A800', '/srv/projects/api', 'Production API'))
      .toBe('A800 / Production API')
  })

  it('falls back to the folder name for a blank configured title', () => {
    expect(remoteWorkspaceTitle('A800', '/srv/projects/api', '  ')).toBe('A800 / api')
  })

  it('uses the remote path when it has no basename', () => {
    expect(remoteWorkspaceTitle('A800', '/')).toBe('A800 / /')
  })
})
