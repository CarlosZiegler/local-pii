import { createMDX } from 'fumadocs-mdx/next';

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  // Static export for Cloudflare Pages (wrangler pages deploy out).
  output: 'export',
  images: { unoptimized: true },
};

export default withMDX(config);
