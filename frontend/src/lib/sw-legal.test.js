// The Privacy Policy and Terms are static pages beside the app (public/privacy/, public/terms/).
// The worker's network-first branch answers a slow navigation with the cached shell after 3 s,
// which at /privacy would be the app's index.html with its relative assets resolving under the
// wrong path. Those two pages are left to the browser, so they always come from the server.
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const swSource = readFileSync(fileURLToPath(new URL('../../public/sw.js', import.meta.url)), 'utf8')

function loadServiceWorker() {
  const listeners = {}
  const cache = { match: () => Promise.resolve(undefined), put: () => Promise.resolve(), add: () => Promise.resolve() }
  const context = {
    self: { addEventListener: (type, cb) => { listeners[type] = cb }, skipWaiting: () => {}, clients: { claim: () => Promise.resolve() }, registration: {} },
    caches: { open: () => Promise.resolve(cache), keys: () => Promise.resolve([]), delete: () => Promise.resolve(true), match: cache.match },
    fetch: () => new Promise(() => {}),
    location: { origin: 'https://gym.example', href: 'https://gym.example/sw.js' },
    URL, setTimeout, clearTimeout, console,
  }
  vm.createContext(context)
  vm.runInContext(swSource, context)
  return listeners
}

const navigate = url => {
  const e = { request: { url, method: 'GET', mode: 'navigate' }, answered: false }
  e.respondWith = () => { e.answered = true }
  return e
}

describe('service worker and the legal pages', () => {
  const listeners = loadServiceWorker()

  it.each([
    'https://gym.example/privacy', 'https://gym.example/privacy/', 'https://gym.example/privacy/index.html',
    'https://gym.example/terms', 'https://gym.example/terms/', 'https://gym.example/gym/terms',
  ])('leaves %s to the network', url => {
    const e = navigate(url)
    listeners.fetch(e)
    expect(e.answered).toBe(false)
  })

  it.each(['https://gym.example/', 'https://gym.example/index.html', 'https://gym.example/privacy-notes.js'])(
    'still handles %s itself', url => {
      const e = navigate(url)
      listeners.fetch(e)
      expect(e.answered).toBe(true)
    })
})
