import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import { appName, gitConfig } from './shared';

export function baseOptions(lang = 'en'): BaseLayoutProps {
  return {
    i18n: true,
    nav: {
      title: <span className="font-mono font-semibold">{appName}</span>,
      url: `/${lang}`,
    },
    links: [
      { text: 'Docs', url: `/${lang}/docs` },
      { text: 'Playground', url: `/${lang}/docs/playground` },
    ],
    githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
  };
}
