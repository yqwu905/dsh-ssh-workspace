/**
 * Scripted Anthropic-Messages-compatible endpoint for end-to-end tests: the
 * n-th assistant turn of a conversation replays `steps[n]` (a tool call or a
 * final text). Requests without tools (titles etc.) get a short text reply.
 */

import { createServer } from 'node:http'

/**
 * @typedef {{ tool: string, input: Record<string, unknown> } | { text: string }} Step
 * @param {(request: any) => Step[]} script
 */
export async function startMockLlm(script) {
  /** @type {any[]} */
  const requests = []
  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    let body = {}
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
    } catch {
      // Malformed bodies get the default text reply.
    }
    requests.push(body)
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    const sse = (payload) => res.write(`event: ${payload.type}\ndata: ${JSON.stringify(payload)}\n\n`)
    sse({ type: 'message_start', message: { id: `m${requests.length}`, type: 'message', role: 'assistant', model: 'mock-model', content: [], usage: { input_tokens: 3, output_tokens: 0 } } })
    const messages = Array.isArray(body.messages) ? body.messages : []
    const turn = messages.filter(m => m.role === 'assistant').length
    const steps = Array.isArray(body.tools) && body.tools.length > 0 ? script(body) : []
    const step = steps[turn] ?? { text: Array.isArray(body.tools) && body.tools.length > 0 ? 'done' : 'Mock title' }
    if ('tool' in step) {
      sse({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `call-${requests.length}`, name: step.tool, input: {} } })
      sse({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(step.input) } })
      sse({ type: 'content_block_stop', index: 0 })
      sse({ type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 5 } })
    } else {
      sse({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
      sse({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: step.text } })
      sse({ type: 'content_block_stop', index: 0 })
      sse({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } })
    }
    sse({ type: 'message_stop' })
    res.end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise(resolve => server.close(resolve)),
  }
}

/**
 * Text of every tool_result block in a request, in order.
 * @param {any} request
 */
export function toolResults(request) {
  const out = []
  for (const message of request?.messages ?? []) {
    if (!Array.isArray(message.content)) continue
    for (const block of message.content) {
      if (block.type !== 'tool_result') continue
      const content = Array.isArray(block.content) ? block.content.map(c => c.text ?? '').join('') : String(block.content ?? '')
      out.push({ id: block.tool_use_id, error: block.is_error === true, content })
    }
  }
  return out
}
