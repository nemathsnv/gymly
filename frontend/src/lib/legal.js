// Where the Privacy Policy and Terms of Service live. They are static pages (public/privacy/,
// public/terms/) that nginx serves at /privacy and /terms, outside the app, so they open without
// signing in and without JavaScript — what an OAuth provider's reviewer (Oura) and a search
// engine need. The text describes the hosted service at gymly.churntech.com.
//
// The web app links them next to itself: its own base, so a subpath install keeps its prefix.
// The phone build has no web server of its own behind the link (its files are inside the APK),
// so it points at the hosted pages. Read straight off the build flag rather than through
// lib/mobile.js, which would pull the Capacitor plugins into every screen that shows a link.
import { appBase } from './app-base.js'

export const LEGAL_ORIGIN = 'https://gymly.churntech.com'
export const LEGAL_PAGES = ['privacy', 'terms']

const BUILD_MOBILE = import.meta.env?.VITE_MOBILE === '1'

export function legalUrl(page, { mobile = BUILD_MOBILE, base } = {}) {
  if (!LEGAL_PAGES.includes(page)) throw new Error('Unknown legal page: ' + page)
  if (mobile) return `${LEGAL_ORIGIN}/${page}`
  return (base ?? appBase()).replace(/\/?$/, '/') + page
}
