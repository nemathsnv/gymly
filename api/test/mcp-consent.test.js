/* mcp-remote/consent.js: the pages run under their own CSP (scripts and styles by nonce only),
   so nothing on them may need an inline style attribute or handler — a browser blocks those and
   the page then renders or behaves differently than tested. And everything a client chose is
   shown as text. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { consentPage, signInPage, errorPage, pageHeaders } from '../mcp-remote/consent.js';

const nonce = 'TESTNONCE';
const request = {
  client: { client_name: '<img src=x onerror=alert(1)>Evil "app"', verified: false },
  redirectUri: 'https://evil.example/cb?x=<b>', scopes: ['gymly:read', 'gymly:write']
};
const pages = [
  consentPage({ id: 'req"id', request, user: { name: '<script>me</script>' }, nonce }),
  signInPage({ nonce, appUrl: 'https://gym.example/' }),
  errorPage('expired', nonce), errorPage('nonsense', nonce)
];

test('no inline style attributes or event handlers; every script and style carries the nonce', () => {
  for (const html of pages) {
    // Attributes of real tags only: escaped client text may spell anything.
    for (const tag of html.match(/<[a-z][^>]*>/gi) || []) {
      assert.doesNotMatch(tag, /\sstyle=/, tag);
      assert.doesNotMatch(tag, /\son[a-z]+=/i, tag);
    }
    for (const tag of html.match(/<(script|style)\b[^>]*>/g) || []) assert.match(tag, new RegExp(`nonce="${nonce}"`), tag);
  }
});

test('client-chosen text is escaped, unverified clients are labelled', () => {
  const html = pages[0];
  assert.ok(!html.includes('<img'), 'client name is text');
  assert.ok(!html.includes('<script>me'), 'user name is text');
  assert.match(html, /\(unverified\)/);
  assert.match(html, /value="req&quot;id"/);
  assert.match(html, /evil\.example/);
});

test('headers: CSP with nonce, no framing, no caching; form-action allows the client\'s origin only', () => {
  const h = pageHeaders(nonce, 'https://chatgpt.com/connector_platform_oauth_redirect');
  assert.match(h['Content-Security-Policy'], /script-src 'nonce-TESTNONCE'/);
  assert.match(h['Content-Security-Policy'], /frame-ancestors 'none'/);
  assert.match(h['Content-Security-Policy'], /form-action 'self' https:\/\/chatgpt\.com;/);
  assert.equal(h['X-Frame-Options'], 'DENY');
  assert.equal(h['Cache-Control'], 'no-store');
  assert.match(pageHeaders(nonce)['Content-Security-Policy'], /form-action 'self';/);
});

test('the habit log has its own line, only when asked for, and it starts unticked', () => {
  const page = scopes => consentPage({ id: 'r', request: { ...request, scopes }, user: { name: 'Me' }, nonce });
  const plain = page(['gymly:read', 'gymly:write']);
  assert.doesNotMatch(plain, /name="allow_habits"/);
  // Not asked for: the screen says habits stay out, alongside the rest it never sees.
  assert.match(plain, /AI Coach settings or habits, and cannot sign in as you/);

  const asked = page(['gymly:read', 'gymly:write', 'gymly:habits:read']);
  const box = asked.match(/<input[^>]*name="allow_habits"[^>]*>/g);
  assert.equal(box?.length, 1);
  assert.doesNotMatch(box[0], /checked/);
  assert.match(asked, /Also read your habits/);
  assert.match(asked, /notes you write on a day are never shared/);
  // Write keeps its own box, ticked as before.
  assert.match(asked.match(/<input[^>]*name="allow_write"[^>]*>/)[0], /checked/);
});
