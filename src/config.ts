/** Validated browser/file inputs. No private key material is accepted by this plugin. */
import { z } from 'zod'
import { posix } from 'node:path'

const clean = z.string().min(1).max(4096).refine(value => !/[\0\r\n]/u.test(value), 'NUL and line breaks are not allowed')
export const absoluteRemotePath = clean.refine(value => value.startsWith('/'), 'Use an absolute remote POSIX path')
  .transform(value => posix.normalize(value))
export const recordId = z.string().uuid()
export const helperLaunch = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('executable') }).strict(),
  z.object({ kind: z.literal('node-script'), node: absoluteRemotePath,
    bootstrapPath: absoluteRemotePath.optional(), bootstrapHash: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  }).strict().refine(value => (value.bootstrapPath === undefined) === (value.bootstrapHash === undefined), 'bootstrap path and digest must be paired'),
])
/** A reverse forward is private to the remote loopback interface. */
export const tunnelInput = z.object({
  remotePort: z.number().int().min(1024).max(65535),
  host: z.enum(['127.0.0.1', 'localhost', '::1']).default('127.0.0.1'),
  port: z.number().int().min(1).max(65535),
}).strict()
export const serverInput = z.object({
  id: recordId.optional(),
  label: clean.max(120),
  host: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.@-]{0,120}$/u, 'Use an existing OpenSSH Host alias'),
  // Missing mode + existing helper is the v0.1 manual configuration; new records default to auto.
  helperMode: z.enum(['auto', 'manual']).optional(),
  helper: absoluteRemotePath.optional(),
  helperHash: z.string().regex(/^[a-f0-9]{64}$/u, 'Expected lowercase SHA-256').optional(),
  launch: helperLaunch.optional(),
  tunnels: z.array(tunnelInput).max(16).default([]).refine(items => new Set(items.map(item => item.remotePort)).size === items.length, 'Reverse tunnel ports must be unique'),
  executableMap: z.record(clean, clean).default({}),
  hostExecutables: z.array(clean).max(100).default([]),
}).strict().superRefine((server, context) => {
  const mode = server.helperMode ?? (server.helper ? 'manual' : 'auto')
  if (mode === 'manual' && (!server.helper || !server.helperHash || !server.launch)) {
    context.addIssue({ code: 'custom', message: 'Manual helper mode requires helper, helperHash and launch' })
  }
})
export const workspaceInput = z.object({ serverId: recordId, remotePath: absoluteRemotePath, title: clean.max(120) }).strict()
export type ServerInput = z.infer<typeof serverInput>
export type ServerRecord = Omit<ServerInput, 'id'> & { id: string }
export type WorkspaceInput = z.infer<typeof workspaceInput>
export const workspaceRecord = workspaceInput.extend({ id: recordId, mountPath: clean, workspaceId: z.string().optional() }).strict()
export type WorkspaceRecord = z.infer<typeof workspaceRecord>
export const persistedState = z.object({
  version: z.literal(1),
  servers: z.array(serverInput.safeExtend({ id: recordId })).max(100),
  workspaces: z.array(workspaceRecord).max(1000),
  retiredMounts: z.array(workspaceRecord).default([]),
}).strict().superRefine((state, context) => {
  const serverIds = new Set(state.servers.map(server => server.id))
  if (serverIds.size !== state.servers.length) context.addIssue({code: 'custom', message: 'Duplicate server id'})
  const allMounts = [...state.workspaces, ...state.retiredMounts]
  if (new Set(allMounts.map(workspace => workspace.id)).size !== allMounts.length) context.addIssue({code: 'custom', message: 'Duplicate live or retired workspace id'})
  for (const workspace of state.workspaces) if (!serverIds.has(workspace.serverId)) context.addIssue({code: 'custom', message: 'Workspace references a missing server'})
})
