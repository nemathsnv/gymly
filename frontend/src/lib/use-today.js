import { useEffect, useState } from 'react'
import { todayISO } from './format.js'

// How often an open page looks at the clock again. A timer set for midnight would be wrong after a
// phone sleeps through it or the device changes time zone; asking is cheap and always right.
const CHECK_MS = 30000

/**
 * Today's date on this device, kept current while the page stays open: it moves at midnight, when
 * the app comes back to the foreground (an installed PWA resumed the next morning) and when the
 * device changes time zone. A screen that logs "today" has to use this, not todayISO() read once
 * at render: left open past midnight it would go on writing to yesterday.
 */
export function useToday() {
  const [today, setToday] = useState(todayISO)
  useEffect(() => {
    const look = () => setToday(todayISO())
    look()
    const tm = setInterval(look, CHECK_MS)
    const onVisible = () => { if (document.visibilityState !== 'hidden') look() }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', look)
    window.addEventListener('pageshow', look)
    return () => {
      clearInterval(tm)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', look)
      window.removeEventListener('pageshow', look)
    }
  }, [])
  return today
}
