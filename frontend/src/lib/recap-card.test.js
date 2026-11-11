import { describe, expect, test } from 'vitest'
import { drawRecapCard } from './recap-card.js'
import { cardPalette, BRAND, SITE } from './card-draw.js'

// A canvas context that only records what was written.
function fakeCtx() {
  const texts = []
  const noop = () => {}
  return {
    texts,
    fillText: t => texts.push(String(t)), measureText: t => ({ width: String(t).length * 10 }),
    fillRect: noop, beginPath: noop, moveTo: noop, arcTo: noop, closePath: noop, fill: noop, save: noop, restore: noop, translate: noop, scale: noop,
  }
}
const words = { title: 'Your week', dates: '19–25 Oct', tiles: [{ label: 'workouts', value: '4' }, { label: 'Volume', value: '12,300 kg' }, { label: 'new bests', value: '2' }, { label: 'weeks in a row', value: '6' }], top: 'Most work: Chest, 14 sets' }

describe('the recap picture', () => {
  test('carries the title, the dates, the four tiles, the top muscle and the Gymly footer', () => {
    for (const [width, height] of [[1080, 1920], [1080, 1080]]) {
      const ctx = fakeCtx()
      drawRecapCard(ctx, words, { width, height, colors: cardPalette('dark') })
      expect(ctx.texts).toEqual(expect.arrayContaining(['Your week', '19–25 Oct', '4', 'workouts', '12,300 kg', 'Volume', '2', '6', 'Most work: Chest, 14 sets', 'Gymly', 'gymly.churntech.com']))
      expect(ctx.texts.join(' ')).not.toMatch(/openGym|opengym|^open$/m)
    }
    expect([BRAND, SITE]).toEqual(['Gymly', 'gymly.churntech.com'])
  })
  test('no top muscle, no line for it', () => {
    const ctx = fakeCtx()
    drawRecapCard(ctx, { ...words, top: null }, { width: 1080, height: 1080, colors: cardPalette('light', '#0a84ff') })
    expect(ctx.texts.some(s => s.startsWith('Most work'))).toBe(false)
  })
  test('the light look darkens a bright accent for text; a colour it cannot read falls back to green', () => {
    expect(cardPalette('light', '#30d158').accText).not.toBe('#30d158')
    expect(cardPalette('dark', '#30d158').accText).toBe('#30d158')
    expect(cardPalette('dark', 'nonsense').acc).toBe('#30d158')
  })
})
