// What a shared picture of Gymly has in common: the two formats, the light and dark looks and the
// name in the footer. Pure drawing, no DOM: the week and month recap (lib/recap-card.js) paints
// with it, and lib/share-image.js gets the picture out of the app. No exercise picture or clip is
// ever drawn on a card (the licence keeps those inside the app, NOTICE.md).
//
// Ported from openGym (19e0164db, as of 4ba2a9757), the smallest part of it the recap needs:
// the footer says "Gymly" in the accent, as the workout card's does (lib/workout-card.js), and
// the colour helpers are the workout card's own.
import { parseColor, mixColor } from './workout-card.js'

// 9:16 for Stories and Reels, 1:1 for a feed or a chat.
export const FORMATS = { story: { width: 1080, height: 1920 }, square: { width: 1080, height: 1080 } }
export const FORMAT_IDS = Object.keys(FORMATS)
export const STYLE_IDS = ['dark', 'light']
export const BRAND = 'Gymly'
export const SITE = 'gymly.churntech.com'

/**
 * The colours of a card, the app's own (index.css) in a fixed light or dark look, whatever the
 * app shows right now. `acc` is the accent, as a hex or rgb colour; on light paper a bright accent
 * is too faint to read as text, so text in the accent (`accText`) is the accent darkened there.
 */
export function cardPalette(style, acc = '#30d158') {
  const light = style === 'light'
  const a = parseColor(acc) ? acc : '#30d158'
  return light
    ? { bg: '#f2f2f7', surface: '#ffffff', tile: '#f2f2f7', label: '#000000', label2: '#6c6c70', acc: a, accText: mixColor(a, '#000000', 0.62), sep: '#e5e5ea', light: true }
    : { bg: '#000000', surface: '#1c1c1e', tile: '#2c2c2e', label: '#ffffff', label2: '#98989f', acc: a, accText: a, sep: '#38383a', light: false }
}

/**
 * The footer every card ends with: "Gymly" in the accent, and the site at the other end. `y` is
 * the text's baseline. Drawn left to right whatever the language: it is a name, and a name does
 * not mirror.
 */
export function drawBrand(ctx, { x, y, width, colors, family, size = 40 }) {
  ctx.direction = 'ltr'
  ctx.textAlign = 'left'
  ctx.font = `800 ${size}px ${family}`
  ctx.fillStyle = colors.accText || colors.acc
  ctx.fillText(BRAND, x, y)
  ctx.font = `600 ${Math.round(size * 0.72)}px ${family}`
  ctx.fillStyle = colors.label2
  ctx.textAlign = 'right'
  ctx.fillText(SITE, x + width, y)
  ctx.textAlign = 'left'
}

export function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2))
  ctx.beginPath()
  ctx.moveTo(x + rr, y)
  ctx.arcTo(x + w, y, x + w, y + h, rr)
  ctx.arcTo(x + w, y + h, x, y + h, rr)
  ctx.arcTo(x, y + h, x, y, rr)
  ctx.arcTo(x, y, x + w, y, rr)
  ctx.closePath()
}
