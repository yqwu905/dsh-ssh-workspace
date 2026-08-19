import { describe, expect, it } from 'vitest'
import { TailOutputReader } from '../src/output.js'

describe('TailOutputReader', () => {
  it('supports independent offsets without consuming output', () => {
    const reader = new TailOutputReader(16)
    reader.push('alpha')
    expect(reader.readFrom(0)).toMatchObject({ text: 'alpha', nextOffset: 5, lossy: false })
    expect(reader.readFrom(0)).toMatchObject({ text: 'alpha', nextOffset: 5, lossy: false })
    reader.push('-beta')
    expect(reader.readFrom(5)).toMatchObject({ text: '-beta', nextOffset: 10, lossy: false })
  })

  it('reports a gap when an offset falls out of the retained byte tail', () => {
    const reader = new TailOutputReader(5)
    reader.push('0123456789')
    expect(reader.readFrom(0)).toMatchObject({ text: '56789', nextOffset: 10, lossy: true })
    expect(reader.readFrom(7)).toMatchObject({ text: '789', nextOffset: 10, lossy: false })
  })
})
