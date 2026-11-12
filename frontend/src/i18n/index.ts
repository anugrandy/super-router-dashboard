/** i18next setup.
 *
 * Two locale files live next to this module: `locales/id.json` (default) and
 * `locales/en.json`. Keys are grouped by page/component so a string can be
 * found by where it appears rather than by guessing an English phrase.
 *
 * The chosen language is persisted in localStorage under `netdash.lang` and
 * mirrored onto <html lang> so screen readers and font fallback follow it.
 */
import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import id from './locales/id.json'
import en from './locales/en.json'

export const LANGS = ['id', 'en'] as const
export type Lang = (typeof LANGS)[number]

/** Storage key kept in sync with the Settings language selector. */
export const LANG_STORAGE_KEY = 'netdash.lang'

function isLang(value: unknown): value is Lang {
  return value === 'id' || value === 'en'
}

/** Read the persisted language, falling back to Indonesian. */
export function storedLang(): Lang {
  try {
    const saved = localStorage.getItem(LANG_STORAGE_KEY)
    if (isLang(saved)) return saved
  } catch {
    // localStorage can be disabled (private mode); the default still works.
  }
  return 'id'
}

void i18n.use(initReactI18next).init({
  resources: {
    id: { translation: id },
    en: { translation: en },
  },
  lng: storedLang(),
  fallbackLng: 'id',
  supportedLngs: [...LANGS],
  // Resources are bundled inline, so initialisation can be synchronous; that
  // lets `i18n.t()` be called safely during the first render.
  initAsync: false,
  // React already escapes interpolated values.
  interpolation: { escapeValue: false },
  // Missing keys return the key itself, which makes the gap obvious instead of
  // rendering an empty label.
  returnNull: false,
})

if (typeof document !== 'undefined') {
  document.documentElement.lang = i18n.language
}

/** Switch language, persist it, and update <html lang>. */
export function setLanguage(lang: Lang): void {
  try {
    localStorage.setItem(LANG_STORAGE_KEY, lang)
  } catch {
    // Non-fatal: the session still switches, only the preference is lost.
  }
  void i18n.changeLanguage(lang)
  if (typeof document !== 'undefined') document.documentElement.lang = lang
}

export default i18n
