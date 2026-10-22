/** Enumerate concrete user Host aliases without executing Match/ProxyCommand or opening keys. */
import { glob, readFile, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

export const SSH_ALIAS = /^[a-zA-Z0-9][a-zA-Z0-9_.@-]{0,120}$/u
export interface ConfigHost { host: string; source: string }
export interface ConfigHosts { hosts: ConfigHost[]; warnings: string[] }

/** OpenSSH quotes, escapes, comments and key=value syntax; no shell expansion. */
export function configWords(line: string): string[] {
  const words: string[] = []
  let word = '', quoted = false, escaped = false, started = false
  for (const character of line) {
    if (escaped) { word += character; escaped = false; started = true; continue }
    if (character === '\\') { escaped = true; continue }
    if (character === '"') { quoted = !quoted; started = true; continue }
    if (!quoted && character === '#') break
    if (!quoted && (/\s/u.test(character) || (character === '=' && (words.length === 0 || (words.length === 1 && !started))))) {
      if (started) { words.push(word); word = ''; started = false }
    } else { word += character; started = true }
  }
  if (quoted || escaped) throw new Error('Unterminated quote or escape')
  if (started) words.push(word)
  return words
}

export async function discoverConfigHosts(home = homedir()): Promise<ConfigHosts> {
  const root = join(home, '.ssh')
  const hosts = new Map<string, ConfigHost>(), visited = new Set<string>(), warnings: string[] = []
  let bytes = 0
  async function visit(file: string, depth: number): Promise<void> {
    if (depth > 16 || visited.size >= 128) { warnings.push('SSH Include limit reached (16 levels / 128 files).'); return }
    let canonical: string, contents: string
    try {
      canonical = await realpath(file)
      if (visited.has(canonical)) return
      visited.add(canonical)
      const info = await stat(canonical)
      if (!info.isFile() || (bytes += info.size) > 1024 * 1024) { warnings.push(`SSH config size limit: ${file}`); return }
      contents = await readFile(canonical, 'utf8')
    } catch (error) {
      if (file === join(root, 'config') && (error as NodeJS.ErrnoException).code === 'ENOENT') return
      warnings.push(`Cannot read SSH config: ${file}`); return
    }
    for (const line of contents.split(/\r?\n/u)) {
      let words: string[]
      try { words = configWords(line) } catch { warnings.push(`Invalid SSH config quoting in ${file}`); continue }
      const [key, ...values] = words
      if (key?.toLowerCase() === 'host') {
        for (const host of values) {
          // Patterns and negations are defaults/exclusions, never connectable server entries.
          if (SSH_ALIAS.test(host) && !hosts.has(host) && hosts.size < 2000) hosts.set(host, { host, source: file })
        }
      } else if (key?.toLowerCase() === 'include') {
        for (let pattern of values) {
          pattern = pattern.replace(/\$\{([a-zA-Z_][a-zA-Z0-9_]*)\}/gu, (_match, name: string) => process.env[name] ?? '${' + name + '}')
          pattern = pattern.replaceAll('%d', home).replaceAll('%%', '%')
          if (pattern.startsWith('~/')) pattern = join(home, pattern.slice(2))
          if (pattern.startsWith('~') || /[%$\0\r\n{}]/u.test(pattern)) { warnings.push(`Unsupported SSH Include expansion in ${file}`); continue }
          // Relative user Include paths are relative to ~/.ssh, even inside nested files.
          pattern = isAbsolute(pattern) ? pattern : resolve(root, pattern)
          try {
            const paths: string[] = []
            for await (const path of glob(pattern)) { paths.push(path); if (paths.length >= 128) break }
            for (const path of paths.sort()) await visit(path, depth + 1)
          } catch { warnings.push(`Cannot expand SSH Include in ${file}`) }
        }
      }
    }
  }
  await visit(join(root, 'config'), 0)
  return { hosts: [...hosts.values()].sort((a, b) => a.host.localeCompare(b.host)), warnings: [...new Set(warnings)] }
}
