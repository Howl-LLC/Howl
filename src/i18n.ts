// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 Howl LLC
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { getStoredLanguage } from '../utils/settingsStorage';

import enUS from './locales/en-US.json';

type LocaleData = Record<string, string | Record<string, unknown>>;
const localeLoaders: Record<string, () => Promise<{ default: LocaleData }>> = {
  'en-GB': () => import('./locales/en-GB.json'),
  'es':    () => import('./locales/es.json'),
  'fr':    () => import('./locales/fr.json'),
  'de':    () => import('./locales/de.json'),
  'ja':    () => import('./locales/ja.json'),
  'ko':    () => import('./locales/ko.json'),
  'pt-BR': () => import('./locales/pt-BR.json'),
  'zh-CN': () => import('./locales/zh-CN.json'),
};

const storedLang = getStoredLanguage();

i18n.use(initReactI18next).init({
  resources: {
    'en-US': { translation: enUS },
  },
  lng: storedLang,
  fallbackLng: 'en-US',
  interpolation: { escapeValue: false },
});

// Load the user's selected language on demand if not en-US
if (storedLang && storedLang !== 'en-US' && localeLoaders[storedLang]) {
  localeLoaders[storedLang]().then((mod) => {
    i18n.addResourceBundle(storedLang, 'translation', mod.default, true, true);
    if (i18n.language === storedLang) i18n.changeLanguage(storedLang);
  });
}

/** Load a locale dynamically. Call this when the user changes language. */
export async function loadLocale(lang: string): Promise<void> {
  if (lang === 'en-US') {
    i18n.changeLanguage(lang);
    return;
  }
  const loader = localeLoaders[lang];
  if (!loader) return;
  if (!i18n.hasResourceBundle(lang, 'translation')) {
    const mod = await loader();
    i18n.addResourceBundle(lang, 'translation', mod.default, true, true);
  }
  i18n.changeLanguage(lang);
}

export default i18n;
