import { t } from '../lib/i18n.js'
import { legalUrl } from '../lib/legal.js'

// "Privacy Policy · Terms of Service", for the sign-in screen and Settings → About. A new tab, so
// reading them never leaves the app (or a half-done sign-up) behind.
export default function LegalLinks({ className = 'dim small' }) {
  return (
    <nav aria-label={t('Legal')} className={className}>
      <a href={legalUrl('privacy')} target="_blank" rel="noopener">{t('Privacy Policy')}</a>
      {' · '}
      <a href={legalUrl('terms')} target="_blank" rel="noopener">{t('Terms of Service')}</a>
    </nav>
  )
}
