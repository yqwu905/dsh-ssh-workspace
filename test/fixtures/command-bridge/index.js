// Test-only plugin: lets a scripted model run slash commands for its own
// agent, so `/ssh` is exercised inside a real runtime without a UI adapter.
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'fleet-test-command-bridge'
export const inject = ['tools', 'commands']

export function apply(ctx) {
  ctx.tools.register(defineTool({
    name: 'test_slash',
    description: 'Run one slash command for this agent (test fixture).',
    parameters: { line: { type: 'string', required: true, description: 'Slash command line.' } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args, exec) {
      const execution = await ctx.commands.execute(exec.agent, args.line, [], exec.signal)
      if (execution === undefined) return `unknown command: ${args.line}`
      return `[${execution.result.kind}] ${execution.result.text ?? ''}`
    },
  }))
}
