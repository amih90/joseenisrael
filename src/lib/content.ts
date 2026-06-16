export function entrySlug(entry: { id: string }) {
  return entry.id.replace(/\.(md|mdx)$/i, '').split('/').at(-1) || entry.id;
}

export function withBase(path: string) {
  if (!path) return import.meta.env.BASE_URL;
  if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(path)) return path;

  const base = import.meta.env.BASE_URL.endsWith('/') ? import.meta.env.BASE_URL : `${import.meta.env.BASE_URL}/`;
  const relativePath = path.replace(/^\/+/, '');
  return `${base}${relativePath}`;
}

export function assetPath(path: string) {
  return withBase(path);
}

const wordpressHosts = new Set(['josenisraeltours.net', 'www.josenisraeltours.net']);
const wordpressUrlPattern = /https?:\/\/(?:www\.)?josenisraeltours\.net\/[^\s<>"]+/gi;

type LegacyEntry = {
  id: string;
  collection?: string;
  data: {
    originalUrl?: string;
    legacyPath?: string;
  };
};

function legacyUrlKey(value?: string) {
  if (!value) return undefined;

  try {
    const url = new URL(value, 'https://josenisraeltours.net');
    if (!wordpressHosts.has(url.hostname)) return undefined;

    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    return pathname.toLowerCase();
  } catch {
    return undefined;
  }
}

function localUrlForEntry(entry: LegacyEntry) {
  return entry.collection === 'posts' ? postUrl(entry) : pageUrl(entry);
}

export function buildLegacyUrlMap(entries: LegacyEntry[]) {
  const links = new Map<string, string>();

  for (const entry of entries) {
    const localUrl = localUrlForEntry(entry);
    for (const legacyUrl of [entry.data.originalUrl, entry.data.legacyPath]) {
      const key = legacyUrlKey(legacyUrl);
      if (key) links.set(key, localUrl);
    }
  }

  return links;
}

function rewriteContentUrl(value: string, legacyUrlMap: ReadonlyMap<string, string>) {
  const key = legacyUrlKey(value);
  if (key) {
    return legacyUrlMap.get(key) || withBase(key);
  }

  if (/^\/(?!\/)/.test(value)) return withBase(value);

  return value;
}

export function contentHtml(entry: { rendered?: { html?: string } }, legacyUrlMap: ReadonlyMap<string, string> = new Map()) {
  const html = (entry.rendered?.html || '').replace(/\b(src|href)=(['"])([^'"]*)\2/g, (_match, attribute, quote, value) => {
    return `${attribute}=${quote}${rewriteContentUrl(value, legacyUrlMap)}${quote}`;
  });

  return html.replace(wordpressUrlPattern, (value) => rewriteContentUrl(value, legacyUrlMap));
}

export function postUrl(entry: { id: string }) {
  return withBase(`/blog/${entrySlug(entry)}/`);
}

export function pageUrl(entry: { id: string }) {
  const slug = entrySlug(entry);
  return withBase(slug === 'home' ? '/' : `/${slug}/`);
}

export function sortedByDate<T extends { data: { pubDate: Date } }>(entries: T[]) {
  return [...entries].sort((first, second) => second.data.pubDate.getTime() - first.data.pubDate.getTime());
}

export function displayName(value = '') {
  return value
    .split(/\s|-/g)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}

export function formatDate(value: Date) {
  return new Intl.DateTimeFormat('es', { dateStyle: 'medium' }).format(value);
}