import { useRef, useState } from 'react'
import { useStore } from '../store/useStore.js'
import { useUI } from '../store/useUI.js'
import { t } from '../lib/i18n.js'
import { ACCENT_NAMES } from '../lib/format.js'
import { HABIT_ICONS, HABIT_COLORS, NAME_MAX, HABIT_MAX, habitOf, habitList, withHabit, createHabit } from '../lib/habits.js'
import { useSheetKeyboard } from '../lib/use-sheet-keyboard.js'
import Icon from './Icon.jsx'
import { Button, Segmented } from './ui.jsx'

// The colour names Settings already shows for the accent (lib/format.js ACCENT_NAMES), by token.
const COLOR_NAMES = { teal: ACCENT_NAMES.teal, green: ACCENT_NAMES.lime, blue: ACCENT_NAMES.sky, purple: ACCENT_NAMES.violet,
  pink: ACCENT_NAMES.pink, red: ACCENT_NAMES.red, orange: ACCENT_NAMES.orange, yellow: ACCENT_NAMES.gold }

/** Archives or brings back a habit. Its days stay either way. */
export function setArchived(id, archived) {
  useStore.getState().update(s => { s.habitLog = withHabit(s.habitLog, id, { archived }) })
}

// A new habit (no `id`) or one to change: its name, what kind it is, an icon and a colour, and
// for one that exists, Archive / Bring back. Alcohol's kind is its own and is not offered. Nothing
// is written until Save.
function HabitEditor({ id, close, onSaved }) {
  const S = useStore(s => s.S)
  const h = id ? habitOf(S, id) : null
  const nameRef = useRef(null)
  const onNameFocus = useSheetKeyboard(nameRef)
  const [name, setName] = useState(h?.name || '')
  const [kind, setKind] = useState(h?.kind || 'do')
  const [icon, setIcon] = useState(h?.icon || 'star')
  const [color, setColor] = useState(h?.color || 'teal')
  if (id && !h) return null
  const builtin = !!h?.builtin
  const full = !id && habitList(S, { archived: null }).filter(x => !x.builtin).length >= HABIT_MAX
  const canSave = (builtin || name.trim().length > 0) && !full
  const save = () => {
    if (!canSave) return
    let made = null
    useStore.getState().update(s => {
      if (id) { s.habitLog = withHabit(s.habitLog, id, { name, kind, icon, color }); return }
      const r = createHabit(s.habitLog, { name, kind, icon, color })
      s.habitLog = r.map
      made = r.id
    })
    close()
    onSaved?.(id || made)
  }
  return <>
    <h3>{id ? t('Edit habit') : t('New habit')}</h3>
    <div className="lbl2" style={{ margin: '4px 0 6px' }}>{t('Habit name')}</div>
    <input ref={nameRef} className="input" maxLength={NAME_MAX} value={name} onFocus={onNameFocus}
      placeholder={builtin ? t('Alcohol') : t('Habit name')} aria-label={t('Habit name')}
      onChange={e => setName(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') save() }} />
    {!builtin && <>
      <div style={{ height: 14 }} />
      <Segmented value={kind} onChange={setKind}
        options={[{ value: 'do', label: t('Build a habit') }, { value: 'avoid', label: t('Avoid a habit') }]} />
      <div className="small muted" style={{ marginTop: 6 }}>
        {kind === 'avoid' ? t('Each day: Avoided, Did it or Not logged.') : t('Each day: Done, Not done or Not logged.')}
        {id && h.kind !== kind ? ' ' + t('Days you already logged keep their meaning: a good day stays good.') : ''}
      </div>
    </>}
    <div className="lbl2" style={{ margin: '16px 0 8px' }}>{t('Icon')}</div>
    <div className="habit-icons" role="radiogroup" aria-label={t('Icon')}>
      {HABIT_ICONS.map((n, i) => <button key={n} type="button" role="radio" aria-checked={icon === n}
        aria-label={t('Icon {0}', i + 1)} className={'habit-icon' + (icon === n ? ' on' : '')}
        style={icon === n ? { background: `var(--${color})` } : undefined} onClick={() => setIcon(n)}><Icon name={n} /></button>)}
    </div>
    <div className="lbl2" style={{ margin: '16px 0 8px' }}>{t('Color')}</div>
    <div className="swatches" role="radiogroup" aria-label={t('Color')}>
      {HABIT_COLORS.map(c => <button key={c} type="button" role="radio" aria-checked={color === c} aria-label={t(COLOR_NAMES[c])}
        className={'swatch' + (color === c ? ' on' : '')} style={{ background: `var(--${c})` }} onClick={() => setColor(c)} />)}
    </div>
    {full && <div className="small muted" style={{ marginTop: 12 }}>{t('You can have up to {0} habits of your own.', HABIT_MAX)}</div>}
    <div style={{ height: 18 }} />
    <Button variant="primary" disabled={!canSave} onClick={save}>{id ? t('Save') : t('Add habit')}</Button>
    {id && <>
      <div style={{ height: 8 }} />
      <Button icon={h.archived ? 'undo' : 'folder'} onClick={() => { setArchived(id, !h.archived); close() }}>
        {h.archived ? t('Unarchive') : t('Archive')}
      </Button>
      {!h.archived && <div className="small muted" style={{ marginTop: 6, textAlign: 'center' }}>
        {t('Archiving hides it from Home and the list. Every day you logged is kept.')}
      </div>}
    </>}
  </>
}

/** Opens the editor: a new habit with no `id`. `onSaved(id)` runs after Save. */
export const habitEditSheet = (id, onSaved) => useUI.getState().openSheet(close => <HabitEditor id={id} close={close} onSaved={onSaved} />)
