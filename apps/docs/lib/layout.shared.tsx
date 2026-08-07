import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import { appName, gitConfig } from './shared';

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: <span className="font-mono font-semibold">{appName}</span>,
      url: '/',
    },
    // Top navbar links.
    links: [
      { text: 'Docs', url: '/docs' },
      { text: 'Playground', url: '/docs/playground' },
    ],
    githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
  };
}
