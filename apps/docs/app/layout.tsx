import './global.css';
import type { ReactNode } from 'react';

// The <html>/<body> live in app/[lang]/layout.tsx so the lang attribute is
// per-locale. This root only loads global styles and passes children through.
export default function RootLayout({ children }: { children: ReactNode }) {
  return children;
}
