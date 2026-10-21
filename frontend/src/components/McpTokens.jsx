// Settings → Account → "AI assistant access": the read-only tokens an MCP client (mcp/, remote
// mode) signs in with. The rules are the server's (api/mcp-access.js): read-only, one profile,
// 90 days, at most ten, revoked one by one here or all at once by "Sign out everywhere". This only
// shows them, makes one, and revokes one. A new token is shown once, in this sheet's own state,
// and is gone when the sheet closes: it is never put in the store, which syncs and persists.
import { useEffect, useState } from 'react'
import { useUI } from '../store/useUI.js'
import { t } from '../lib/i18n.js'
import { dateLocale } from '../lib/i18n-core.js'
import { api } from '../lib/api.js'
import { copyText } from '../lib/clipboard.js'
import { REPO } from '../lib/demo.js'
import { confirmSheet } from '../sheets.jsx'
import { Row, Button } from './ui.jsx'

const ui = () => useUI.getState()
const toast = m => ui().toast(m)
const errStyle = { color: 'var(--red)', marginTop: 10 }
const GUIDE = REPO + '/blob/main/docs/MCP.md'

const when = ms => {
  try { return new Date(ms).toLocaleDateString(dateLocale(), { day: 'numeric', month: 'short', year: 'numeric' }) }
  catch { return '' }
}
const meta = tk => [
  t('Added {0}', when(tk.created)),
  t('Expires {0}', when(tk.exp)),
  tk.lastUsed && t('Last used {0}', when(tk.lastUsed)),
  '…' + tk.hint
].filter(Boolean).join(' · ')

export function McpTokensRow() {
  return <Row icon="key" iconTint="var(--indigo)" title={t('AI assistant access')}
    subtitle={t('Let an AI assistant such as Claude read your training data.')} accessory="chevron"
    onClick={() => ui().openSheet(close => <McpTokensSheet close={close} />)} />
}

export function McpTokensSheet({ close }) {
  const [list, setList] = useState(null)      // { tokens, max }
  const [name, setName] = useState('')
  const [made, setMade] = useState(null)      // the one just created, token included — this sheet only
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  useEffect(() => { api('/api/account/mcp-tokens').then(setList).catch(e => setErr(e.message || t('Something went wrong'))) }, [])

  const create = async ev => {
    ev.preventDefault()
    if (busy) return
    setBusy(true); setErr(null)
    try {
      const r = await api('/api/account/mcp-tokens', { method: 'POST', body: JSON.stringify({ name: name.trim() }) })
      setMade(r)
      setName('')
      setList(l => ({ ...(l || { max: 10 }), tokens: [{ ...r, token: undefined }, ...((l && l.tokens) || [])] }))
    } catch (e) { setErr(e.message || t('Something went wrong')) }
    finally { setBusy(false) }
  }
  const revoke = tk => confirmSheet({
    title: t('Revoke this token?'), message: t('Anything that uses it loses access immediately.'),
    confirmText: t('Revoke'), danger: true,
    onConfirm: async () => {
      try {
        const r = await api('/api/account/mcp-tokens?id=' + encodeURIComponent(tk.id), { method: 'DELETE' })
        setList(l => ({ ...l, tokens: r.tokens }))
        if (made && made.id === tk.id) setMade(null)
        toast(t('Token revoked'))
      } catch (e) { toast(e.message || t('Something went wrong')) }
    }
  })
  const copy = async () => { if (made && await copyText(made.token)) toast(t('Copied')) }
  const full = list && list.tokens.length >= list.max

  return <>
    <h3>{t('AI assistant access')}</h3>
    <div className="muted small" style={{ marginBottom: 14 }}>
      {t('A token lets an AI assistant read this profile’s routines, workouts and progress over MCP. It cannot change anything, and it expires after 90 days. Signing out everywhere revokes every token.')}
    </div>

    {made && <>
      <div className="small" role="status" style={{ marginBottom: 8 }}>{t('Copy this token now: it is shown only once. Keep it in a file only you can read.')}</div>
      {/* Copied or read character by character: left to right in every language. */}
      <div className="card" dir="ltr" style={{ fontFamily: 'ui-monospace, monospace', fontSize: 13, wordBreak: 'break-all', padding: '12px 14px', userSelect: 'all' }}>{made.token}</div>
      <div style={{ height: 8 }} />
      <Button variant="primary" icon="copy" onClick={copy}>{t('Copy token')}</Button>
      <div style={{ height: 14 }} />
    </>}

    {!list ? (!err && <div className="muted small">…</div>) : <>
      {list.tokens.length > 0
        ? <div className="sect-b">
          {list.tokens.map(tk => <Row key={tk.id} icon="key" iconTint="var(--grey)" title={tk.name} subtitle={meta(tk)}
            accessory="chevron" onClick={() => revoke(tk)} />)}
        </div>
        : <div className="dim small">{t('No tokens yet.')}</div>}
      <div style={{ height: 14 }} />
      {!full && <form onSubmit={create} noValidate>
        <input className="input" placeholder={t('Name, e.g. Claude Code')} maxLength={60} value={name} onChange={e => setName(e.target.value)} />
        <div style={{ height: 8 }} />
        <Button type="submit" variant={made ? 'plain' : 'primary'} icon="plus" disabled={busy}>{t('Create token')}</Button>
      </form>}
    </>}
    {err && <div className="small" role="alert" style={errStyle}>{err}</div>}
    <div style={{ height: 8 }} />
    <Button variant="ghost" icon="link" onClick={() => window.open(GUIDE, '_blank', 'noopener')}>{t('Setup guide')}</Button>
    <Button variant="ghost" onClick={close}>{t('Done')}</Button>
  </>
}
