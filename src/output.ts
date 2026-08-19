import type { SubprocessOutputRead, SubprocessOutputReader } from '@deepseek-ai/dsh-subprocess'

/** Bounded byte tail with the subprocess seam's offset-based, non-consuming read contract. */
export class TailOutputReader implements SubprocessOutputReader {
  private tail = Buffer.alloc(0)
  private totalBytes = 0

  constructor(readonly maxBytes: number) {
    if (!Number.isFinite(maxBytes) || maxBytes <= 0) {
      throw new Error('dsh-ssh-workspace: output maxBytes must be a positive finite number')
    }
  }

  push(chunk: Buffer | string): void {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    this.totalBytes += bytes.length
    this.tail = Buffer.concat([this.tail, bytes])
    if (this.tail.length > this.maxBytes) this.tail = this.tail.subarray(this.tail.length - this.maxBytes)
  }

  readFrom(fromByte: number): SubprocessOutputRead {
    const requested = Number.isFinite(fromByte) && fromByte >= 0 ? Math.floor(fromByte) : 0
    const retainedFrom = this.totalBytes - this.tail.length
    const lossy = requested < retainedFrom
    const localOffset = lossy ? 0 : Math.min(this.tail.length, Math.max(0, requested - retainedFrom))
    return {
      text: this.tail.subarray(localOffset).toString('utf8'),
      nextOffset: this.totalBytes,
      lossy,
    }
  }
}
