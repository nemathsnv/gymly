/* The three pages a person sees while connecting an assistant: sign in, consent, and "that did
 * not work". Served by the API itself (GET /api/oauth/authorize), on Gymly's own origin, so the
 * session cookie the app already sets is the one that decides who is connecting, and a passkey
 * sign-in on this page is the app's own ceremony (/api/login/options and /api/login/verify).
 *
 * Plain server-rendered HTML with one inline script and one inline style, both under a per-response
 * nonce; nothing is loaded from anywhere. Everything a client chose (its name, its redirect URI) is
 * escaped and shown as text. The page cannot be framed (frame-ancestors 'none', and nginx adds
 * X-Frame-Options), so the Allow button cannot be clickjacked. */
import crypto from 'node:crypto';
import { describeRedirect } from './oauth.js';

const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// Chrome holds the redirect after a form POST to form-action too, so the client's own address
// has to be allowed there; everything else stays 'self'.
function formActionFor(redirectUri) {
  if (!redirectUri) return '';
  try {
    const u = new URL(redirectUri);
    if (u.protocol === 'https:' || u.protocol === 'http:') return ' ' + u.origin;
    return ' ' + u.protocol;
  } catch { return ''; }
}

export function pageHeaders(nonce, redirectUri) {
  return {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Pragma': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    // 'same-origin', not 'no-referrer': with no referrer at all the consent form posts Origin: null.
    'Referrer-Policy': 'same-origin',
    'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self' data:; form-action 'self'${formActionFor(redirectUri)}; frame-ancestors 'none'; base-uri 'none'`
  };
}
export const newNonce = () => crypto.randomBytes(16).toString('base64');

const STYLE = `
:root{color-scheme:light dark;--bg:#f6f7f9;--card:#fff;--fg:#111;--dim:#5b6170;--line:#dfe2e8;--acc:#1f9d4c;--warn:#b42318}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--card:#181b21;--fg:#f2f3f5;--dim:#a2a8b5;--line:#2a2f38;--acc:#30d158;--warn:#ff6b5e}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
main{max-width:460px;margin:0 auto;padding:32px 16px}.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:22px}
h1{font-size:20px;margin:0 0 6px}p{margin:8px 0}.dim{color:var(--dim);font-size:14px}.warn{color:var(--warn)}
ul{padding-left:20px;margin:8px 0}li{margin:4px 0}label{display:flex;gap:10px;align-items:flex-start;margin:12px 0;cursor:pointer}
input[type=checkbox]{margin-top:4px;width:18px;height:18px}.row{display:flex;gap:10px;margin-top:18px}
button,a.btn{flex:1;font:inherit;padding:11px 14px;border-radius:10px;border:1px solid var(--line);background:transparent;color:var(--fg);cursor:pointer;text-align:center;text-decoration:none}
p.foot{text-align:center}button.primary{background:var(--acc);border-color:var(--acc);color:#fff;font-weight:600}code{font-size:13px;word-break:break-all}
`;

function shell(title, body, nonce, script = '') {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)}</title><style nonce="${nonce}">${STYLE}</style></head>
<body><main><div class="card">${body}</div><p class="dim foot">Gymly</p></main>${script ? `<script nonce="${nonce}">${script}</script>` : ''}</body></html>`;
}

/** The consent screen. `id` is the single-use request id; the form posts back to the same URL. */
export function consentPage({ id, request, user, nonce }) {
  const c = request.client;
  const name = c.verified ? `<b>${esc(c.client_name)}</b>` : `<b>“${esc(c.client_name)}”</b> <span class="warn">(unverified)</span>`;
  const intro = c.verified ? `${name} wants to connect to your Gymly profile.` : `An app calling itself ${name} wants to connect to your Gymly profile. Gymly cannot confirm who made it.`;
  const writeAsked = request.scopes.includes('gymly:write');
  const body = `<h1>Connect an assistant</h1>
<p>${intro}</p>
<p class="dim">Signed in as <b>${esc(user.name)}</b>. After you answer, you go back to <b>${esc(describeRedirect(request.redirectUri))}</b>.</p>
<form method="post" action="/api/oauth/authorize">
<input type="hidden" name="request_id" value="${esc(id)}">
<p><b>It will be able to:</b></p>
<ul><li>Read your routines, week plan, workouts, body weight and progress.</li></ul>
${writeAsked ? `<label><input type="checkbox" name="allow_write" value="1" checked><span>Change your routines and log workouts.<br><span class="dim">Every change is shown to you in the chat before it is made, and can be undone. Removing exercises or routines asks for a stronger confirmation.</span></span></label>` : ''}
<p class="dim">It will never see your passkeys, password, gym cards or AI Coach settings, and cannot sign in as you. You can disconnect it at any time in Settings → AI assistant access, and “Sign out everywhere” disconnects it too.</p>
<div class="row"><button type="submit" name="decision" value="deny">Cancel</button><button class="primary" type="submit" name="decision" value="allow">Allow</button></div>
</form>`;
  return shell('Connect an assistant · Gymly', body, nonce);
}

/** Not signed in: a passkey sign-in on this page, then the page reloads into the consent screen. */
export function signInPage({ nonce, appUrl }) {
  const body = `<h1>Sign in to Gymly</h1>
<p>An assistant asked to connect to your Gymly profile. Sign in first to see what it asks for.</p>
<div class="row"><button class="primary" id="pk" type="button">Sign in with a passkey</button></div>
<p class="dim" id="msg" role="status"></p>
<p class="dim">Or <a href="${esc(appUrl)}" target="_blank" rel="noopener">sign in in the Gymly app</a>, then <a href="" id="again">reload this page</a>.</p>`;
  const script = `
const b64u = b => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');
const fromB64u = s => Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/') + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0));
const msg = t => { document.getElementById('msg').textContent = t; };
document.getElementById('again').addEventListener('click', e => { e.preventDefault(); location.reload(); });
document.getElementById('pk').addEventListener('click', async () => {
  try {
    if (!window.PublicKeyCredential) { msg('This browser has no passkey support.'); return; }
    msg('Waiting for your passkey…');
    const post = (u, b) => fetch(u, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
    const o = await (await post('/api/login/options', {})).json();
    const opt = o.options;
    const publicKey = { ...opt, challenge: fromB64u(opt.challenge), allowCredentials: (opt.allowCredentials || []).map(c => ({ ...c, id: fromB64u(c.id) })) };
    const cred = await navigator.credentials.get({ publicKey });
    const r = cred.response;
    const credential = { id: cred.id, rawId: b64u(cred.rawId), type: cred.type, authenticatorAttachment: cred.authenticatorAttachment || undefined,
      clientExtensionResults: cred.getClientExtensionResults ? cred.getClientExtensionResults() : {},
      response: { clientDataJSON: b64u(r.clientDataJSON), authenticatorData: b64u(r.authenticatorData), signature: b64u(r.signature), userHandle: r.userHandle ? b64u(r.userHandle) : undefined } };
    const v = await post('/api/login/verify', { cid: o.cid, credential });
    if (!v.ok) { const e = await v.json().catch(() => ({})); msg(e.error || 'Sign-in failed.'); return; }
    location.reload();
  } catch (e) { msg(e && e.name === 'NotAllowedError' ? 'Sign-in was cancelled.' : 'Sign-in failed: ' + (e && e.message || e)); }
});`;
  return shell('Sign in · Gymly', body, nonce, script);
}

const REASONS = {
  unknown_client: ['Unknown app', 'The app that sent you here is not known to Gymly, or its registration has expired. Start the connection again from the app.'],
  bad_redirect: ['Unknown return address', 'The app asked to be answered at an address it never registered, so Gymly will not send anything there.'],
  bad_request: ['Malformed request', 'The connection request is malformed. Start the connection again from the app.'],
  expired: ['This request has expired', 'This connection request was already answered or has expired. Start the connection again from the app.'],
  not_available: ['Not available for this profile', 'Connecting assistants is not enabled for this Gymly profile. Ask the person who runs this Gymly server.'],
  disabled: ['Not available', 'This Gymly server does not accept assistant connections.']
};
export function errorPage(reason, nonce) {
  const [title, text] = REASONS[reason] || REASONS.bad_request;
  return shell(title + ' · Gymly', `<h1>${esc(title)}</h1><p>${esc(text)}</p>`, nonce);
}
