import { useNavigate } from 'react-router-dom'
import { useStore } from '../store/useStore.js'
import { useToday } from '../lib/use-today.js'
import { t } from '../lib/i18n.js'
import { habitList, habitStats } from '../lib/habits.js'
import { tappable } from '../lib/use-sheet-keyboard.js'
import Icon from '../components/Icon.jsx'
import HabitButtons, { HabitIcon, habitName } from '../components/HabitButtons.jsx'
import { habitEditSheet, setArchived } from '../components/HabitEditor.jsx'
import { Button } from '../components/ui.jsx'

/** The line under a habit's name: its current streak. */
export function streakLine(h, current) {
  if (!(current > 0)) return t('No streak yet')
  return h.builtin ? t('Alcohol-free streak (days): {0}', current) : t('Streak (days): {0}', current)
}

/** One active habit: its name and streak (tap for its screen) and today in one tap. */
export function HabitRow({ h, today, nav }) {
  const S = useStore(s => s.S)
  const { current } = habitStats(S, h.id, today)
  return <div className="habit-row">
    <div className="row between" style={{ marginBottom: 10, cursor: 'pointer' }} {...tappable(() => nav('/habits/' + h.id))}>
      <div className="row" style={{ gap: 9, minWidth: 0 }}>
        <HabitIcon h={h} />
        <div style={{ minWidth: 0 }}>
          <div className="ttl habit-name">{habitName(h)}</div>
          <div className="small muted">{streakLine(h, current)}</div>
        </div>
      </div>
      <Icon name="chevronRight" className="chev" />
    </div>
    <HabitButtons iso={today} habit={h.id} />
  </div>
}

/** Every habit: the active ones with today's check-in, Add habit, and the archived ones. `/habits`. */
export default function Habits() {
  const nav = useNavigate()
  const S = useStore(s => s.S)
  const today = useToday()
  const active = habitList(S)
  const archived = habitList(S, { archived: true })
  return <div className="narrow">
    <div className="hdr">
      <button className="iconbtn" onClick={() => nav('/home')} aria-label={t('Home')}><Icon name="chevronLeft" /></button>
      <div style={{ flex: 1, marginLeft: 10 }}><h1>{t('Habits')}</h1></div>
      <Button size="sm" variant="tinted" icon="plus" onClick={() => habitEditSheet(null)}>{t('Add habit')}</Button>
    </div>

    {active.map(h => <div className="card" key={h.id}><HabitRow h={h} today={today} nav={nav} /></div>)}
    {!active.length && <div className="card"><div className="empty">{t('No active habits. Add one, or bring an archived one back.')}</div></div>}

    {archived.length > 0 && <>
      <h2 style={{ margin: '18px 4px 8px' }}>{t('Archived')}</h2>
      <div className="card">
        {archived.map(h => <div key={h.id} className="row between habit-archived">
          <div className="row" style={{ gap: 9, minWidth: 0, flex: 1, cursor: 'pointer' }} {...tappable(() => nav('/habits/' + h.id))}>
            <HabitIcon h={h} />
            <div className="ttl habit-name">{habitName(h)}</div>
          </div>
          <Button size="sm" variant="ghost" icon="undo" onClick={() => setArchived(h.id, false)}>{t('Unarchive')}</Button>
        </div>)}
      </div>
    </>}

    <div className="muted small" style={{ margin: '4px 4px 24px' }}>
      {t('Your habit log syncs with your profile and is included in backups. It is never shared with AI assistants or the Coach.')}
    </div>
  </div>
}
