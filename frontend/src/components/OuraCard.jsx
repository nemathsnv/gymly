import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { t } from '../lib/i18n.js'
import { fmtDate } from '../lib/format.js'
import { Section, Row } from './ui.jsx'
import { confirmSheet } from '../sheets.jsx'
import { useUI } from '../store/useUI.js'
import { ouraStatus, ouraConnectUrl, ouraSync, ouraDisconnect, ouraDiagnostics, connectResultMessage, overviewErrorMessage } from '../lib/oura-api.js'

// Names of the data types, as the person shared them on Oura's screen.
export const OURA_TYPES = {
  daily_readiness: 'Readiness', daily_sleep: 'Sleep score', sleep: 'Sleep details (HRV, heart rate)', daily_activity: 'Activity',
  daily_stress: 'Stress', daily_spo2: 'SpO2', daily_cardiovascular_age: 'Cardiovascular age', vO2_max: 'VO2 max',
  workout: 'Workouts', heartrate: 'Heart rate (last 7 days)',
}
const STATUS_WORD = { ok: 'shared', 'not-shared': 'not shared', 'rate-limited': 'Oura busy', error: 'error' }

/** Check connection: per data type whether it arrives — never a value. */
function DiagnosticsSheet({ close }) {
  const [d, setD] = useState(null)
  const [err, setErr] = useState(null)
  useEffect(() => { ouraDiagnostics(true).then(setD, setErr) }, [])
  return <div data-oura-diagnostics>
    <h3 style={{ marginBottom: 6 }}>{t('Oura connection check')}</h3>
    {!d && !err && <div className="muted">{t('Checking with Oura…')}</div>}
    {err && <div className="muted">{overviewErrorMessage(err, t)}</div>}
    {d && <>
      <div className="small dim" style={{ marginBottom: 8 }}>
        {t('Token refresh: {0}', d.refresh === 'ok' ? t('works') : d.refresh || '–')}
        {d.syncError ? ' · ' + t('Sync: {0}', d.syncError) : ''}
      </div>
      {Object.entries(OURA_TYPES).map(([k, label]) => {
        const r = d.types?.[k]
        const ok = r?.status === 'ok'
        return <div key={k} data-type={k} className="row between" style={{ padding: '6px 0', borderTop: '.5px solid var(--sep)' }}>
          <span>{t(label)}</span>
          <span className="small" style={{ color: ok ? (r.records ? 'var(--green)' : 'var(--label-2)') : 'var(--orange)' }}>
            {!r ? '–' : ok ? (r.records ? t('shared, receiving data') : t('shared, no records yet')) : t(STATUS_WORD[r.status] || r.status)}
          </span>
        </div>
      })}
      <div className="small dim" style={{ marginTop: 8 }}>{t('Only whether each kind of data arrives is checked; no values are read or shown here.')}</div>
    </>}
    <div style={{ height: 12 }} />
    <button className="btn" onClick={close}>{t('Done')}</button>
  </div>
}

const when = ms => (ms ? fmtDate(new Date(ms).toISOString().slice(0, 10)) + ', ' + new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null)

/* Settings → Data & backup → Oura: connect, status, Sync now, Disconnect. Signed-in web only
   (Settings decides): the OAuth round trip goes through this server's own callback, and comes
   back here with ?oura=<result>. Nothing about Oura is written into the synced state. */
export default function OuraCard() {
  const toast = useUI(s => s.toast)
  const nav = useNavigate()
  const [st, setSt] = useState(null)
  const [busy, setBusy] = useState(false)

  const load = () => ouraStatus().then(setSt).catch(() => setSt({ configured: false, unreachable: true }))
  // Back from Oura's consent screen (#/settings/data?oura=<result>): say how it went once, then
  // drop the parameter. Read off the hash itself: the callback is the only way it gets there.
  useEffect(() => {
    load()
    const hash = typeof window !== 'undefined' ? window.location.hash : ''
    const code = new URLSearchParams(hash.split('?')[1] || '').get('oura')
    if (!code) return
    const msg = connectResultMessage(code, t)
    if (msg) toast(msg)
    nav('/settings/data', { replace: true })
  }, [])

  if (!st || st.unreachable) return null

  const connect = async () => {
    setBusy(true)
    try { window.location.assign(await ouraConnectUrl()) }
    catch (e) { toast(overviewErrorMessage(e, t)); setBusy(false) }
  }
  const sync = async () => {
    setBusy(true)
    try { await ouraSync(); toast(t('Oura synced')); await load() }
    catch (e) { toast(overviewErrorMessage(e, t)); await load() }
    setBusy(false)
  }
  const disconnect = () => confirmSheet({
    title: t('Disconnect Oura?'),
    message: t('Gymly revokes its access at Oura and deletes the stored tokens and any Oura data it holds, right away. Your Oura account and its data at Oura are not affected.'),
    confirmText: t('Disconnect'), danger: true,
    onConfirm: async () => {
      setBusy(true)
      try { const r = await ouraDisconnect(); toast(r.revoked ? t('Oura disconnected') : t('Oura disconnected. Also remove Gymly in the Oura app under App integrations.')) }
      catch (e) { toast(overviewErrorMessage(e, t)) }
      await load()
      setBusy(false)
    },
  })

  const footer = t('Read-only. Gymly keeps up to 90 days of your Oura summaries in server memory while you use Training & recovery, syncing every few hours; they are never saved, synced, exported, or sent to the AI Coach or AI assistants.')

  if (!st.configured) return (
    <Section title={t('Oura')} footer={st.stale ? null : footer}>
      <Row icon="heart" iconTint="var(--grey)" title={t('Oura')} subtitle={t('Not set up on this server')} />
      {st.stale && <Row icon="trash" iconTint="var(--red)" title={t('Remove old Oura connection')} danger accessory="chevron" onClick={disconnect} />}
    </Section>
  )

  if (!st.connected) return (
    <Section title={t('Oura')} footer={footer}>
      <Row icon="heart" iconTint="var(--purple)" title={busy ? t('Opening Oura…') : t('Connect Oura')}
        subtitle={t('Sleep, readiness, activity, heart rate, stress, SpO2 and workouts')} accessory="chevron"
        onClick={busy ? undefined : connect} />
      {st.stale && <Row icon="trash" iconTint="var(--red)" title={t('Remove old Oura connection')} danger accessory="chevron" onClick={disconnect} />}
    </Section>
  )

  return (
    <Section title={t('Oura')} footer={footer}>
      <Row icon="heart" iconTint="var(--purple)" title={t('Oura connected')}
        subtitle={[
          st.lastSync ? t('Last synced {0}', when(st.lastSync)) : t('Connected {0}', when(st.connectedAt)),
          st.lastError ? t('last sync failed ({0})', st.lastError) : null,
          st.autoSync?.active ? t('auto-sync on') : t('auto-sync starts when you open Training & recovery'),
        ].filter(Boolean).join(' · ')} />
      <Row icon="chart" iconTint="var(--green)" title={t('Training & recovery')} accessory="chevron" onClick={() => nav('/oura')} />
      <Row icon="repeat" iconTint="var(--blue)" title={busy ? t('Syncing…') : t('Sync now')} accessory="chevron" onClick={busy ? undefined : sync} />
      <Row icon="checkCircle" iconTint="var(--teal)" title={t('Check connection')} subtitle={t('Which kinds of data arrive, without showing any')} accessory="chevron"
        onClick={() => useUI.getState().openSheet(close => <DiagnosticsSheet close={close} />)} />
      <Row icon="xmark" iconTint="var(--red)" title={t('Disconnect Oura')} danger accessory="chevron" onClick={busy ? undefined : disconnect} />
    </Section>
  )
}
