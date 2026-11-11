import { describe, expect, it } from 'vitest'
import { LEGAL_ORIGIN, LEGAL_PAGES, legalUrl } from './legal.js'

describe('legalUrl', () => {
  it('on the web, sits next to the app, so /privacy and /terms are what nginx serves', () => {
    expect(legalUrl('privacy', { mobile: false, base: '/' })).toBe('/privacy')
    expect(legalUrl('terms', { mobile: false, base: '/' })).toBe('/terms')
  })

  it('keeps a subpath install inside its prefix, with or without the trailing slash', () => {
    expect(legalUrl('privacy', { mobile: false, base: '/gym/' })).toBe('/gym/privacy')
    expect(legalUrl('terms', { mobile: false, base: '/gym' })).toBe('/gym/terms')
  })

  it('reads the base off the page by default', () => {
    // vitest runs in node here: no location, so appBase falls back to the root
    expect(legalUrl('privacy', { mobile: false })).toBe('/privacy')
  })

  it('in the phone app, points at the hosted pages: the APK has no server behind a relative link', () => {
    expect(legalUrl('privacy', { mobile: true })).toBe('https://gymly.churntech.com/privacy')
    expect(legalUrl('terms', { mobile: true })).toBe('https://gymly.churntech.com/terms')
    expect(LEGAL_ORIGIN).toBe('https://gymly.churntech.com')
  })

  it('knows exactly the two pages that exist and refuses anything else', () => {
    expect(LEGAL_PAGES).toEqual(['privacy', 'terms'])
    expect(() => legalUrl('imprint', { mobile: false, base: '/' })).toThrow(/Unknown legal page/)
  })
})
