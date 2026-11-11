import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { t } from '../lib/i18n.js'
import { fmtDate } from '../lib/format.js'
import { Section, Row } from './ui.jsx'
import { confirmSheet } from '../sheets.jsx'
import { useUI } from '../store/useUI.js'
import { ouraStatus, ouraConnectUrl, ouraSync, ouraDisconnect, connectResultMessage, overviewErrorMessage } from '../lib/oura-api.js'

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
    try { const r = await ouraSync(); toast(t('Oura synced: {0} days, {1} workouts', r.days, r.workouts.length)); await load() }
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

  const footer = t('Read-only. Gymly reads your Oura data when you open the overview and keeps it in server memory for a few minutes; it is never saved, synced, exported, or sent to the AI Coach or AI assistants.')

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
        subtitle={st.lastSync ? t('Last synced {0}', when(st.lastSync)) : t('Connected {0}', when(st.connectedAt))} />
      <Row icon="chart" iconTint="var(--green)" title={t('Recovery overview')} accessory="chevron" onClick={() => nav('/oura')} />
      <Row icon="repeat" iconTint="var(--blue)" title={busy ? t('Syncing…') : t('Sync now')} accessory="chevron" onClick={busy ? undefined : sync} />
      <Row icon="xmark" iconTint="var(--red)" title={t('Disconnect Oura')} danger accessory="chevron" onClick={busy ? undefined : disconnect} />
    </Section>
  )
}
