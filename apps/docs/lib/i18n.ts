import { defineI18n } from 'fumadocs-core/i18n';

// Untranslated pages fall back to the default language automatically.
export const i18n = defineI18n({
  defaultLanguage: 'en',
  languages: ['en', 'pt', 'de'],
});
