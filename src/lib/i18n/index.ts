import viTranslations from './vi.json';
import enTranslations from './en.json';

const translations: Record<string, any> = {
  vi: viTranslations,
  en: enTranslations,
};

export function t(key: string, lang: 'vi' | 'en' = 'vi'): string {
  const currentLang = translations[lang] ? lang : 'vi';
  const dict = translations[currentLang];

  // Resolve nested keys (e.g., 'sidebar.dashboard')
  const value = key.split('.').reduce((acc, part) => {
    return acc && acc[part] !== undefined ? acc[part] : undefined;
  }, dict);

  return typeof value === 'string' ? value : key;
}
