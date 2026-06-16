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

export function contentHtml(entry: { rendered?: { html?: string } }) {
  return (entry.rendered?.html || '').replace(/\b(src|href)=(['"])(\/(?!\/)[^'"]*)\2/g, (_match, attribute, quote, path) => {
    return `${attribute}=${quote}${withBase(path)}${quote}`;
  });
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