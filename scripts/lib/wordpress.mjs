import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

export const SITE_URL = process.env.WP_SOURCE_URL || 'https://josenisraeltours.net';
export const EXPORT_ROOT = resolve('data/wordpress-export');
export const PUBLIC_ROOT = resolve('public');

export async function ensureDir(path) {
  await mkdir(path, { recursive: true });
}

export async function writeJson(path, value) {
  await ensureDir(dirname(path));
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

export function toPosix(path) {
  return path.replace(/\\/g, '/');
}

export function publicPathFor(localPath) {
  return `/${toPosix(relative(PUBLIC_ROOT, localPath))}`;
}

export function endpointUrl(path, params = {}) {
  const url = new URL(path, SITE_URL);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      url.searchParams.set(key, String(value));
    }
  }
  return url;
}

function fetchTimeoutMs(options) {
  return Number(options.timeoutMs || process.env.WP_FETCH_TIMEOUT_MS || 15000);
}

export async function fetchWithRetry(url, options = {}, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const timeoutMs = fetchTimeoutMs(options);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const { timeoutMs: _timeoutMs, ...fetchOptions } = options;
    try {
      const response = await fetch(url, {
        ...fetchOptions,
        signal: fetchOptions.signal || controller.signal,
        headers: {
          'user-agent': 'joseenisrael-static-migration/1.0',
          ...(fetchOptions.headers || {}),
        },
      });
      if (response.ok || attempt === attempts) {
        return response;
      }
      lastError = new Error(`${response.status} ${response.statusText}`);
    } catch (error) {
      lastError = controller.signal.aborted ? new Error(`GET ${url} timed out after ${timeoutMs}ms`) : error;
      if (attempt === attempts) {
        throw lastError;
      }
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError;
}

async function fetchBodyWithRetry(url, options, parser, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const timeoutMs = fetchTimeoutMs(options);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const { timeoutMs: _timeoutMs, ...fetchOptions } = options;
    try {
      const response = await fetch(url, {
        ...fetchOptions,
        signal: fetchOptions.signal || controller.signal,
        headers: {
          'user-agent': 'joseenisrael-static-migration/1.0',
          ...(fetchOptions.headers || {}),
        },
      });

      if (!response.ok && attempt < attempts) {
        lastError = new Error(`${response.status} ${response.statusText}`);
        continue;
      }

      const data = response.ok ? await parser(response) : undefined;
      return { data, headers: response.headers, ok: response.ok, status: response.status, statusText: response.statusText };
    } catch (error) {
      lastError = controller.signal.aborted ? new Error(`GET ${url} timed out after ${timeoutMs}ms`) : error;
      if (attempt === attempts) {
        throw lastError;
      }
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError;
}

export async function fetchJson(url) {
  const options = { headers: { accept: 'application/json' } };
  const result = await fetchBodyWithRetry(url, options, (response) => response.json());
  if (!result.ok) {
    throw new Error(`GET ${url} failed: ${result.status} ${result.statusText}`);
  }
  return { data: result.data, headers: result.headers, status: result.status };
}

export async function fetchText(url) {
  const options = { headers: { accept: 'text/html,application/xml,text/xml,*/*' } };
  const result = await fetchBodyWithRetry(url, options, (response) => response.text());
  if (!result.ok) {
    throw new Error(`GET ${url} failed: ${result.status} ${result.statusText}`);
  }
  return { text: result.data, headers: result.headers, status: result.status };
}

export async function fetchRestCollection(restBase, params = {}) {
  const items = [];
  let total = 0;
  let totalPages = 1;
  let page = 1;

  do {
    const url = endpointUrl(`/wp-json/wp/v2/${restBase}`, { per_page: 100, page, ...params });
    const { data, headers } = await fetchJson(url);
    if (!Array.isArray(data)) {
      throw new Error(`Expected ${url} to return an array`);
    }
    items.push(...data);
    total = Number(headers.get('x-wp-total') || items.length);
    totalPages = Number(headers.get('x-wp-totalpages') || page);
    page += 1;
  } while (page <= totalPages);

  return {
    restBase,
    count: items.length,
    total,
    totalPages,
    fetchedAt: new Date().toISOString(),
    items,
  };
}

export function extractLocs(xml) {
  return [...xml.matchAll(/<loc>(.*?)<\/loc>/gims)].map((match) => decodeXml(match[1].trim()));
}

export function safeFileName(value) {
  return value
    .replace(/^https?:\/\//, '')
    .replace(/[^a-z0-9_.-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 150) || 'resource';
}

export function decodeXml(value) {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'")
    .replace(/&#39;/g, "'");
}

export function stripHtml(value = '') {
  return decodeXml(String(value))
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function cleanRendered(value) {
  return stripHtml(typeof value === 'object' && value?.rendered ? value.rendered : value || '');
}

export function slugify(value) {
  const slug = String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' y ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  return slug || 'contenido';
}

export function normalizeSiteUrl(input) {
  if (!input) return '';
  const decoded = decodeXml(String(input).replace(/\\\//g, '/')).trim();
  if (!decoded || decoded.startsWith('data:')) return '';
  try {
    const url = new URL(decoded, SITE_URL);
    if (url.hostname !== new URL(SITE_URL).hostname) return url.href;
    return `${url.pathname}${url.search}`;
  } catch {
    return decoded;
  }
}

export function absoluteSourceUrl(input) {
  const normalized = normalizeSiteUrl(input);
  if (!normalized) return '';
  try {
    return new URL(normalized, SITE_URL).href;
  } catch {
    return '';
  }
}

export function extractUploadUrlsFromText(text) {
  const normalized = decodeXml(String(text || '').replace(/\\\//g, '/'));
  const urls = new Set();
  const uploadsPattern = /(?:https?:\/\/josenisraeltours\.net)?\/wp-content\/uploads\/[^"'\s<>)]+/gim;
  for (const match of normalized.matchAll(uploadsPattern)) {
    const cleaned = match[0].replace(/[.,;]+$/g, '');
    urls.add(absoluteSourceUrl(cleaned));
  }
  return [...urls].filter(Boolean);
}

export async function latestExportDir() {
  const entries = await readdir(EXPORT_ROOT).catch(() => []);
  const dirs = [];
  for (const entry of entries) {
    const fullPath = join(EXPORT_ROOT, entry);
    if ((await stat(fullPath)).isDirectory()) {
      dirs.push(fullPath);
    }
  }
  dirs.sort();
  const latest = dirs.at(-1);
  if (!latest) {
    throw new Error(`No export directories found under ${EXPORT_ROOT}`);
  }
  return latest;
}

export async function walkFiles(root) {
  const files = [];
  async function visit(path) {
    const entries = await readdir(path, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(path, entry.name);
      if (entry.isDirectory()) {
        await visit(fullPath);
      } else if (entry.isFile()) {
        files.push(fullPath);
      }
    }
  }
  await visit(root);
  return files;
}

export async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const current = nextIndex;
      nextIndex += 1;
      results[current] = await mapper(items[current], current);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export function localPathForUploadUrl(url) {
  const parsed = new URL(url);
  const decodedPath = decodeURIComponent(parsed.pathname).replace(/^\/+/, '');
  return join(PUBLIC_ROOT, decodedPath);
}