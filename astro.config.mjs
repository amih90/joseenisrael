import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

const base = normalizeBase(process.env.PUBLIC_BASE_PATH || process.env.ASTRO_BASE || '/');
const site = process.env.PUBLIC_SITE_URL || (base === '/' ? 'https://josenisraeltours.net' : 'https://amih90.github.io');

function normalizeBase(value) {
  const trimmed = String(value || '/').trim();
  if (!trimmed || trimmed === '/') return '/';
  return `/${trimmed.replace(/^\/+|\/+$/g, '')}`;
}

export default defineConfig({
  site,
  base,
  output: 'static',
  integrations: [sitemap()],
});