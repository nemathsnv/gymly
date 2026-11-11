// Settings → Account → "Webhooks": the profile's outbound webhooks (api/integrations). Ported from
// upstream openGym's Settings → Integrations (b397ab84b), the webhook sheets only: Gymly keeps no
// Integrations directory, so the webhooks are one row next to "AI assistant access", shown only
// where the server offers them (lib/webhooks.js webhooksOffered).
//
// Add (the URL checked here, then by the server; the signing secret shown once, in this sheet's
// own state and never in the store, which syncs and persists), events per webhook, pause, last
// delivery, last error with Retry, a test event, the activity log and disconnect.
import { useCallback, useEffect, useState } from 'react'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { t } from '../lib/i18n.js'
import { api } from '../lib/api.js'
import { DEMO, REPO } from '../lib/demo.js'
import { fmtAgo } from '../lib/format.js'
import { copyText } from '../lib/clipboard.js'
import { WEBHOOK_EVENTS, PILL, webhooksOffered, lanAllowed, webhookStatus, webhooksOf, webhookMax, webhookUrlProblem, toggleEvent } from '../lib/webhooks.js'
import { confirmSheet } from '../sheets.jsx'
import Icon from './Icon.jsx'
import { Section, Row, Switch, Button, TextField } from './ui.jsx'

export const INTEGRATIONS_DOCS = REPO + '/blob/main/docs/INTEGRATIONS.md'

const ui = () => useUI.getState()
const toast = m => ui().toast?.(m)
const sheet = render => ui().openSheet(render)
const errText = (e, fallback) => (e && e.message && !/^HTTP \d+$/.test(e.message) ? e.message : fallback)

/** The row on the Account page; nothing at all where the server does not offer webhooks. */
export function WebhooksRow() {
  const user = useStore(s => s.user)
  const config = useStore(s => s.config)
  if (!webhooksOffered(config, { user, demo: DEMO })) return null
  return <Row icon="webhook" iconTint="var(--indigo)" title={t('Webhooks')}
    subtitle={t('Tell Home Assistant, n8n or ntfy when you finish a workout.')} accessory="chevron"
    onClick={() => openWebhooks({ lan: lanAllowed(config) })} />
}

export function openWebhooks(ctx = {}) {
  sheet(close => <WebhookList close={close} {...ctx} />)
}

function Pill({ status }) {
  return <span className={'intg-pill ' + status}>{t(PILL[status])}</span>
}

/** The server's webhooks for this profile: loaded on open, and again after every change. */
function useWebhooks() {
  const [data, setData] = useState(null)
  const [error, setError] = useState(false)
  const load = useCallback(() => api('/api/integrations')
    .then(d => { setData(d && Array.isArray(d.connections) ? d : { providers: [], connections: [] }); setError(false); return d })
    .catch(() => { setError(true); return null }), [])
  useEffect(() => { load() }, [load])
  return { data, error, load }
}

export function WebhookList({ close, lan = false }) {
  const { data, error, load } = useWebhooks()
  const list = webhooksOf(data)
  const max = webhookMax(data)
  const go = f => () => { close(); f() }
  return <>
    <h3 className="intg-h"><Icon name="webhook" /> {t('Webhooks')}</h3>
    <div className="muted small intg-lead">{t('Your server sends a signed message to each of these when something happens.')}</div>
    {error && <Section><Row icon="warning" iconTint="var(--orange)" title={t('Could not reach your server')} subtitle={t('Tap to try again')} onClick={() => load()} /></Section>}
    {!data && !error && <div className="muted small">…</div>}
    {list.length > 0 && <Section>
      {list.map(c => <Row key={c.id} icon="webhook" iconTint="var(--indigo)" title={c.label}
        subtitle={<><span className="intg-url">{c.info?.url}</span> <Pill status={webhookStatus(c)} /></>} accessory="chevron"
        onClick={go(() => webhookSheet(c, { lan }))} />)}
    </Section>}
    {data && list.length < max && <Button variant={list.length ? 'tinted' : 'primary'} icon="plus" onClick={go(() => addWebhookSheet({ lan }))}>{t('Add a webhook')}</Button>}
    <div style={{ height: 8 }} />
    <Button variant="plain" icon="link" onClick={() => window.open(INTEGRATIONS_DOCS, '_blank', 'noopener')}>{t('What gets sent')}</Button>
    <Button variant="ghost" onClick={close}>{t('Done')}</Button>
  </>
}

export function addWebhookSheet(ctx = {}) {
  sheet(close => <AddWebhook close={close} {...ctx} />)
}

function EventSwitches({ events, onToggle, disabled }) {
  return WEBHOOK_EVENTS.map(ev => <Row key={ev.id} icon={ev.icon} iconTint={ev.tint} title={t(ev.label)}>
    <Switch aria-label={t(ev.label)} checked={events.includes(ev.id)} disabled={disabled} onChange={v => onToggle(ev.id, v)} />
  </Row>)
}

export function AddWebhook({ close, lan = false }) {
  const [url, setUrl] = useState('')
  const [label, setLabel] = useState('')
  const [events, setEvents] = useState(['workout.finished'])
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState(null)
  const [secret, setSecret] = useState(null)
  const toggle = (id, v) => setEvents(cur => (v ? WEBHOOK_EVENTS.map(e => e.id).filter(x => x === id || cur.includes(x)) : cur.filter(x => x !== id)))
  const add = async () => {
    const p = webhookUrlProblem(url, { lan })
    if (p) { setProblem(t(p)); return }
    if (!events.length) { setProblem(t('Pick at least one thing to send.')); return }
    setBusy(true); setProblem(null)
    try {
      const r = await api('/api/integrations/connect', { method: 'POST', body: JSON.stringify({ provider: 'webhook', url: url.trim(), label: label.trim(), events }) })
      setSecret(r?.reveal?.secret || '')
    } catch (e) {
      setProblem(e?.code === 'url' || e?.status === 400 ? t('Your server said no to that URL: {0}', errText(e, t('it is not one it calls.'))) : errText(e, t('Something went wrong')))
    }
    setBusy(false)
  }
  if (secret != null) return <>
    <h3 className="intg-h"><Icon name="checkCircle" /> {t('Webhook added')}</h3>
    <div className="muted small intg-lead">{t('This is its signing secret. You will see it only now, so paste it into your tool if it checks signatures.')}</div>
    {/* Copied or read character by character: left to right in every language. */}
    <div className="intg-secret" dir="ltr" aria-label={t('Signing secret')}>{secret}</div>
    <Button variant="tinted" icon="copy" onClick={async () => { if (await copyText(secret)) toast(t('Copied')) }}>{t('Copy secret')}</Button>
    <div style={{ height: 8 }} />
    <Button variant="primary" onClick={() => { close(); openWebhooks({ lan }) }}>{t('Done')}</Button>
  </>
  return <>
    <h3 className="intg-h"><Icon name="webhook" /> {t('Add a webhook')}</h3>
    <div className="muted small intg-lead">{lan
      ? t('Paste the URL from Home Assistant, n8n, ntfy or similar. Your home network works too.')
      : t('Paste the HTTPS URL from Home Assistant, n8n, ntfy or similar.')}</div>
    <TextField placeholder="https://…" value={url} onChange={e => { setUrl(e.target.value); setProblem(null) }} inputMode="url" autoComplete="off" autoCapitalize="off" spellCheck={false}
      aria-label={t('Webhook URL')} maxLength={2048} dir="ltr" />
    <div style={{ height: 10 }} />
    <TextField placeholder={t('Name (optional)')} value={label} onChange={e => setLabel(e.target.value)} maxLength={60} aria-label={t('Name')} />
    {problem && <div className="intg-problem" role="alert">{problem}</div>}
    <div style={{ height: 14 }} />
    <Section title={t('Send when')}>
      <EventSwitches events={events} onToggle={toggle} disabled={busy} />
    </Section>
    <Button variant="primary" disabled={busy} onClick={add}>{busy ? t('Adding…') : t('Add webhook')}</Button>
    <div style={{ height: 8 }} />
    <Button variant="ghost" onClick={() => { close(); openWebhooks({ lan }) }}>{t('Cancel')}</Button>
  </>
}

export function webhookSheet(conn, ctx = {}) {
  sheet(close => <WebhookDetail close={close} conn={conn} {...ctx} />)
}

export function WebhookDetail({ close, conn: initial, lan = false }) {
  const [c, setC] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [log, setLog] = useState(null)
  const loadLog = () => api('/api/integrations/log?id=' + encodeURIComponent(c.id)).then(r => setLog(r?.log || [])).catch(() => setLog([]))
  const call = async (path, body, after) => {
    setBusy(true)
    try {
      const r = await api(path, { method: 'POST', body: JSON.stringify({ id: c.id, ...body }) })
      if (r?.connection) setC(r.connection)
      after?.(r)
      if (log) loadLog()
    } catch (e) { toast(errText(e, t('Something went wrong'))) }
    setBusy(false)
  }
  const toggle = (id, v) => {
    const next = toggleEvent(c.events, id, v)
    if (!next) { toast(t('Pick at least one thing to send.')); return }
    call('/api/integrations/update', { events: next })
  }
  const test = () => call('/api/integrations/test', {}, r => toast(r?.ok ? t('Test event delivered') : t('Test failed: {0}', r?.msg || '')))
  const retry = () => call('/api/integrations/retry', {}, r => toast(r?.requeued ? t('Sending again') : t('Nothing waiting to send')))
  const disconnect = () => confirmSheet({
    title: t('Disconnect this webhook?'),
    message: t('Your server forgets the URL and its secret, and stops sending. Nothing changes on the other side.'),
    confirmText: t('Disconnect'), danger: true,
    onConfirm: () => call('/api/integrations/disconnect', {}, () => { close(); toast(t('Webhook removed')); openWebhooks({ lan }) }),
  })
  const trouble = c.status === 'attention'
  return <>
    <h3 className="intg-h"><Icon name="webhook" /> {c.label}</h3>
    <div className="intg-url intg-lead" dir="ltr">{c.info?.url}</div>
    <div className="intg-sheet-pill"><Pill status={webhookStatus(c)} /></div>
    <Section title={t('Send when')}>
      <EventSwitches events={c.events || []} onToggle={toggle} disabled={busy} />
    </Section>
    <Section>
      <Row icon="play" iconTint="var(--green)" title={t('Sending')} subtitle={c.paused ? t('Paused. Nothing is sent until you switch it back on.') : null}>
        <Switch aria-label={t('Sending')} checked={!c.paused} disabled={busy} onChange={v => call('/api/integrations/update', { paused: !v })} />
      </Row>
      <Row icon="clock" iconTint="var(--blue)" title={t('Last sync')} value={c.lastOk ? fmtAgo(c.lastOk) : t('Not yet')} />
      {c.lastError && <Row icon="warning" iconTint={trouble ? 'var(--orange)' : 'var(--grey)'} title={<span className="intg-line">{c.lastError.msg}</span>}
        subtitle={c.lastError.at ? fmtAgo(c.lastError.at) : null}>
        {(trouble || c.failed > 0) && <button className="btn xs tinted" disabled={busy} onClick={retry}>{t('Retry')}</button>}
      </Row>}
    </Section>
    <Button variant="tinted" icon="bolt" disabled={busy} onClick={test}>{t('Send test event')}</Button>
    <div style={{ height: 8 }} />
    <Button variant="plain" onClick={() => (log ? setLog(null) : loadLog())}>{log ? t('Hide activity') : t('Show activity')}</Button>
    {log && <Section title={t('Activity')}>
      {log.length ? log.slice(0, 50).map((e, i) => <Row key={i} icon={e.ok ? 'checkCircle' : 'warning'} iconTint={e.ok ? 'var(--green)' : 'var(--orange)'}
        title={<span className="intg-line">{eventName(e.ev)}{e.status ? ' · ' + e.status : ''}</span>} subtitle={[fmtAgo(e.at), e.msg].filter(Boolean).join(' · ')} />)
        : <Row title={<span className="intg-line">{t('Nothing yet')}</span>} />}
    </Section>}
    <div style={{ height: 8 }} />
    <Button variant="danger" disabled={busy} onClick={disconnect}>{t('Disconnect')}</Button>
    <Button variant="ghost" onClick={() => { close(); openWebhooks({ lan }) }}>{t('Done')}</Button>
  </>
}

function eventName(ev) {
  const known = WEBHOOK_EVENTS.find(e => e.id === ev)
  if (known) return t(known.label)
  if (ev === 'test') return t('Test event')
  if (ev === 'connected') return t('Added')
  return ev
}
