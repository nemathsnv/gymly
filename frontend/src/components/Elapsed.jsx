import { useEffect, useState } from 'react'
import { activeMs, fmtClock, isPaused } from '../lib/workout-clock.js'

// A session's running time, "12:34", paused time left out (lib/workout-clock.js). Its own little
// component so the only thing that re-renders every second is this text: the workout header and
// the tab bar's Resume button both show it. Read from the timestamps on every tick, never counted
// up, so it is right again the moment the app comes back from the background. Paused, it holds
// still and stops ticking.
export default function Elapsed({ session }) {
  const start = session?.start
  const pausedAt = session?.pausedAt
  const pauses = session?.pauses
  const read = () => fmtClock(activeMs({ start, pausedAt, pauses }, Date.now()))
  const [txt, setTxt] = useState(read)
  useEffect(() => {
    const tick = () => setTxt(read())
    tick()
    if (isPaused({ pausedAt })) return
    const iv = setInterval(tick, 1000)
    // A phone unlocked or a tab brought back shows the right time at once, not a second later.
    document.addEventListener('visibilitychange', tick)
    return () => { clearInterval(iv); document.removeEventListener('visibilitychange', tick) }
  }, [start, pausedAt, pauses])
  return <span>{txt}</span>
}
