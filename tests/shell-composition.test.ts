import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('mixed shell composition', () => {
  it('keeps Bash at the root and mounts Windows PowerShell in isolated local realms', async () => {
    const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')

    expect(patch).toContain([
      '- id: bash-sandbox',
      "  name: '@deepseek-ai/dsh-bash-sandbox'",
      '  disabled: false',
    ].join('\n'))
    expect(patch).toContain([
      '    - id: subprocess-pwsh-local',
      "      name: 'dsh-ssh-workspace/local-pwsh-subprocess'",
      "      disabled: !!js process.platform !== 'win32'",
      '      isolate:',
      '        subprocess: dsh-ssh-local-pwsh',
    ].join('\n'))
    expect(patch).toContain([
      '- id: pwsh-sandbox',
      "  disabled: !!js process.platform !== 'win32'",
      '  isolate:',
      '    shell: dsh-ssh-local-pwsh',
      '    subprocess: dsh-ssh-local-pwsh',
      '    settings: dsh-ssh-local-pwsh',
    ].join('\n'))
    expect(patch).toContain([
      '- id: tool-pwsh',
      "  disabled: !!js process.platform !== 'win32'",
      '  isolate:',
      '    shell: dsh-ssh-local-pwsh',
    ].join('\n'))
    expect(patch).not.toMatch(/- id: (?:pwsh-sandbox|tool-pwsh)\n  disabled: true/u)
  })
})
