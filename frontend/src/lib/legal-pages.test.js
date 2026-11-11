// The Privacy Policy and Terms of Service are static pages (public/privacy/index.html,
// public/terms/index.html) that nginx serves at /privacy and /terms, readable without signing in.
// They are the URLs registered with OAuth providers (Oura), so what is checked here is what a
// reviewer, a screen reader and the Content-Security-Policy each need from them, plus the few
// statements the Oura API Agreement requires them to keep making.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseHTML } from 'linkedom'
import { describe, expect, it } from 'vitest'

const read = p => readFileSync(fileURLToPath(new URL(`../../public/${p}`, import.meta.url)), 'utf8')
const PAGES = {
  privacy: { file: 'privacy/index.html', title: 'Privacy Policy · Gymly', h1: 'Privacy Policy' },
  terms: { file: 'terms/index.html', title: 'Terms of Service · Gymly', h1: 'Terms of Service' },
}
const html = Object.fromEntries(Object.entries(PAGES).map(([k, p]) => [k, read(p.file)]))
const doc = Object.fromEntries(Object.entries(html).map(([k, h]) => [k, parseHTML(h).document]))
const text = k => doc[k].querySelector('main').textContent.replace(/\s+/g, ' ')
const CONTACT = 'nemathsnv@gmail.com'

describe.each(Object.keys(PAGES))('%s page', page => {
  const d = doc[page]
  const meta = PAGES[page]

  it('is a complete document: language, title, description, viewport and canonical address', () => {
    expect(html[page].startsWith('<!DOCTYPE html>')).toBe(true)
    expect(d.documentElement.getAttribute('lang')).toBe('en')
    expect(d.querySelector('title').textContent).toBe(meta.title)
    expect(d.querySelector('meta[name="description"]').getAttribute('content').length).toBeGreaterThan(50)
    expect(d.querySelector('meta[name="viewport"]').getAttribute('content')).toContain('width=device-width')
    // Zoom must stay possible on a page meant to be read (the app shell disables it; this must not).
    expect(d.querySelector('meta[name="viewport"]').getAttribute('content')).not.toMatch(/user-scalable=no|maximum-scale=1/)
    expect(d.querySelector('link[rel="canonical"]').getAttribute('href')).toBe(`https://gymly.churntech.com/${page}`)
  })

  it('runs no script at all, so the CSP (scripts from this origin and one hashed inline) has nothing to block', () => {
    expect(d.querySelectorAll('script')).toHaveLength(0)
    expect(html[page]).not.toMatch(/\son[a-z]+=/i)
  })

  it('has one h1 and headings that never skip a level', () => {
    const hs = [...d.querySelectorAll('h1,h2,h3,h4,h5,h6')]
    expect(hs.filter(h => h.tagName === 'H1').map(h => h.textContent)).toEqual([meta.h1])
    let prev = 0
    for (const h of hs) {
      const lvl = +h.tagName[1]
      expect(lvl - prev, `"${h.textContent}" jumps from h${prev}`).toBeLessThanOrEqual(1)
      prev = lvl
    }
  })

  it('has landmarks, a skip link that lands, and a nav marking the current page', () => {
    expect(d.querySelectorAll('main')).toHaveLength(1)
    expect(d.querySelector('header')).toBeTruthy()
    expect(d.querySelector('footer')).toBeTruthy()
    expect(d.querySelector('a.skip').getAttribute('href')).toBe('#main')
    expect(d.querySelector('main').id).toBe('main')
    for (const a of d.querySelectorAll('[aria-current="page"]')) expect(a.getAttribute('href')).toBe(`/${page}`)
    expect(d.querySelectorAll('[aria-current="page"]').length).toBeGreaterThan(0)
  })

  it('every in-page link has a target, and ids are unique', () => {
    const ids = [...d.querySelectorAll('[id]')].map(e => e.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const a of d.querySelectorAll('a[href^="#"]')) expect(ids, a.getAttribute('href')).toContain(a.getAttribute('href').slice(1))
    // Every section is labelled by its own heading, and the table of contents reaches every section.
    const sections = [...d.querySelectorAll('main section')]
    expect(sections.length).toBeGreaterThan(10)
    const toc = [...d.querySelectorAll('.toc a')].map(a => a.getAttribute('href').slice(1))
    for (const s of sections) {
      expect(d.getElementById(s.getAttribute('aria-labelledby'))?.tagName).toBe('H2')
      expect(toc).toContain(s.id)
    }
  })

  it('links the other page and the app, with root paths that match the registered URLs', () => {
    const hrefs = [...d.querySelectorAll('a')].map(a => a.getAttribute('href'))
    expect(hrefs).toContain('/privacy')
    expect(hrefs).toContain('/terms')
    expect(hrefs).toContain('/')
    // cross-page anchors point at sections that exist on the other page
    for (const href of hrefs.filter(h => /^\/(privacy|terms)#/.test(h))) {
      const [path, id] = href.slice(1).split('#')
      expect(doc[path].getElementById(id), href).toBeTruthy()
    }
  })

  it('gives a contact address and a last-updated date, and carries no unfinished text', () => {
    expect(d.querySelector(`a[href="mailto:${CONTACT}"]`)).toBeTruthy()
    // Cloudflare's Email Obfuscation (on for gymly.churntech.com) rewrites every address it finds
    // into "[email protected]" plus a decoder script: a reader or reviewer without JavaScript then
    // has no address at all. It leaves the text between these two markers alone.
    const mailtos = html[page].match(/<a href="mailto:[^"]+">[^<]*<\/a>/g)
    expect(mailtos.length).toBeGreaterThan(0)
    for (const a of mailtos) expect(html[page]).toContain(`<!--email_off-->${a}<!--/email_off-->`)
    expect(d.querySelector('.meta time').getAttribute('datetime')).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(text(page)).not.toMatch(/\b(TODO|TBD|FIXME|lorem ipsum)\b|\[[A-Z ]+\]/i)
  })

  it('describes the Oura integration as optional and read-only, and Gymly as not affiliated with Oura', () => {
    expect(text(page)).toMatch(/read-only/i)
    expect(text(page)).toMatch(/optional/i)
    expect(text(page)).not.toMatch(/not available yet|planned/i)
    expect(text(page)).toMatch(/not affiliated with, endorsed by or sponsored by Oura/)
  })
})

describe('legal pages, together', () => {
  it('share one stylesheet, word for word, so the two never drift apart', () => {
    const style = h => h.match(/<!-- legal-style:start[\s\S]*?<!-- legal-style:end -->/)?.[0]
    expect(style(html.privacy)).toBeTruthy()
    expect(style(html.privacy)).toBe(style(html.terms))
  })

  it('are answered 200 at /privacy and /terms by nginx itself, not via a 301 to the trailing slash', () => {
    const conf = readFileSync(fileURLToPath(new URL('../../../web/nginx.conf.template', import.meta.url)), 'utf8')
    const block = conf.match(/location ~ \^\\Q\$\{BASE_PATH\}\\E\/\(privacy\|terms\)\/\?\$ \{([\s\S]*?)\n {4}\}/)?.[1]
    expect(block, 'the /privacy|/terms location').toBeTruthy()
    expect(block).toMatch(/try_files \/\$1\/index\.html =404;/)
    // An add_header in a location replaces the inherited set: the security headers must be repeated.
    for (const h of ['X-Frame-Options', 'X-Content-Type-Options', 'Referrer-Policy', 'Content-Security-Policy']) expect(block).toContain(`add_header ${h} `)
    // …and the files it names are the ones the build ships.
    for (const p of ['privacy', 'terms']) expect(read(`${p}/index.html`)).toContain('<main id="main">')
  })

  it('follow the reader\'s light or dark setting, like the app', () => {
    expect(html.privacy).toContain('@media (prefers-color-scheme:light)')
    expect(doc.privacy.querySelector('meta[name="color-scheme"]').getAttribute('content')).toBe('dark light')
  })
})

/* What the Oura API and MCP Agreement (effective 8 June 2026) requires of these pages. If one of
   these fails, the text no longer says what the registration relies on — change it deliberately. */
describe('Oura API Agreement statements', () => {
  const privacy = text('privacy')
  const terms = text('terms')

  it('privacy: Oura data never reaches an AI model, the Coach or an assistant (§4(d), §6(g))', () => {
    expect(privacy).toMatch(/is never sent to an AI model or AI service/)
    expect(privacy).toMatch(/never used to train, fine-tune or evaluate AI/)
  })

  it('privacy: no sale, sharing or advertising use of Oura data (§4(a)(vi)-(vii))', () => {
    expect(privacy).toMatch(/never sold, rented or licensed/)
    expect(privacy).toMatch(/never used for advertising, marketing or targeting/)
  })

  it('privacy: how to revoke, that revocation is immediate, and deletion within 72 hours (§5(a), §5(f))', () => {
    expect(privacy).toMatch(/revoke Gymly.s access from your Oura account/)
    expect(privacy).toMatch(/Revoking takes effect immediately/)
    expect(privacy).toMatch(/within 72 hours/)
  })

  it('privacy: Oura data is not stored — memory only, minutes, never in sync, exports or backups (§3(m), §4(c))', () => {
    expect(privacy).toMatch(/kept in the server.s memory for up to 10 minutes/)
    expect(privacy).toMatch(/never written to Gymly.s database or files/)
    expect(privacy).toMatch(/not part of your synced data, exports or backups/)
    // and every Oura scope the server asks for by default is named (api/oura/oauth.js DEFAULT_SCOPES)
    for (const kind of ['sleep', 'readiness', 'activity', 'stress', 'SpO2', 'heart health', 'heart rate', 'workouts']) expect(privacy).toContain(kind)
    expect(privacy).toMatch(/does not ask for your Oura email address or personal information/)
  })

  it('privacy: Oura and Gymly are independent controllers (§15(e))', () => {
    expect(privacy).toMatch(/separate, independent controllers/)
  })

  it('terms: disclaims warranties and excludes indirect damages on behalf of third-party providers (§5(i))', () => {
    expect(terms).toMatch(/merchantability, fitness for a particular purpose and non-infringement/)
    expect(terms).toMatch(/consequential, special, punitive or indirect damages/)
  })

  it('terms: no charge for Oura data (§4(a)(xiii)) and a wellness-only health disclaimer', () => {
    expect(terms).toMatch(/will not charge you for access to Oura data/)
    expect(terms).toMatch(/not a medical device/)
  })
})
