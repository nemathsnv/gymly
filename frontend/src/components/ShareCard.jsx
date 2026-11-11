// The sheet a shared picture goes out through: a preview of the picture, 9:16 or 1:1, dark or
// light, and Share. The week and month recap (components/Recap.jsx) uses it. The picture is drawn
// on the device (`render`), shown before it goes anywhere, and handed to the share sheet as a PNG.
// Ported from openGym (19e0164db); History's workout card keeps its own sheet (sheets.jsx), which
// follows the app's theme instead.
import { useEffect, useRef, useState } from 'react'
import { t } from '../lib/i18n.js'
import { Button, Segmented } from './ui.jsx'
import { shareImage } from '../lib/share-image.js'
import { FORMAT_IDS, STYLE_IDS } from '../lib/card-draw.js'

// The last format and look picked, per device: a person who posts Stories keeps posting Stories.
const PREF = 'gym_share_card'
function readPref() {
  try {
    const v = JSON.parse(localStorage.getItem(PREF) || '{}')
    return { format: FORMAT_IDS.includes(v.format) ? v.format : 'story', style: STYLE_IDS.includes(v.style) ? v.style : 'dark' }
  } catch (e) { return { format: 'story', style: 'dark' } }
}
function writePref(p) { try { localStorage.setItem(PREF, JSON.stringify(p)) } catch (e) { /* no storage: not remembered */ } }

/**
 * `render({ format, style })` resolves to a PNG blob (or null when it could not be drawn). `name`
 * is the file name, `shareTitle` what the share sheet is told it is.
 */
export default function ShareCardSheet({ title, render, name, shareTitle, close, toast }) {
  const [pref, setPref] = useState(readPref)
  const [img, setImg] = useState(null)
  const [busy, setBusy] = useState(false)
  const shown = useRef(null)
  const set = patch => setPref(p => { const next = { ...p, ...patch }; writePref(next); return next })
  useEffect(() => {
    let alive = true
    Promise.resolve()
      .then(() => render(pref))
      .then(blob => {
        if (!alive) return
        if (!blob) { setImg(prev => ({ ...prev, failed: true })); return }
        // The last picture stays up while the next one is drawn, so a toggle never blanks the sheet.
        if (shown.current) URL.revokeObjectURL(shown.current)
        shown.current = URL.createObjectURL(blob)
        setImg({ blob, url: shown.current })
      })
      .catch(() => { if (alive) setImg(prev => ({ ...prev, failed: true })) })
    return () => { alive = false }
  }, [pref.format, pref.style]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { if (shown.current) URL.revokeObjectURL(shown.current) }, [])
  const share = async () => {
    setBusy(true)
    await shareImage(img.blob, name, shareTitle, toast)
    setBusy(false)
    close?.()
  }
  return <>
    <h3>{title}</h3>
    <div className={'share-card share-' + pref.format}>
      {img?.url
        ? <img src={img.url} alt={t('Preview of the image to share')} />
        : img?.failed ? <div className="share-card-ph small muted">{t('Could not create the image')}</div>
          : <div className="share-card-ph" aria-hidden="true" />}
    </div>
    <div className="share-opts">
      <Segmented value={pref.format} onChange={format => set({ format })}
        options={[{ value: 'story', label: t('Story 9:16') }, { value: 'square', label: t('Square 1:1') }]} />
      <Segmented value={pref.style} onChange={style => set({ style })}
        options={[{ value: 'dark', icon: 'moon', label: t('Dark') }, { value: 'light', icon: 'sun', label: t('Light') }]} />
    </div>
    <Button variant="primary" icon="share" disabled={!img?.blob || busy} onClick={share}>{t('Share')}</Button>
  </>
}
