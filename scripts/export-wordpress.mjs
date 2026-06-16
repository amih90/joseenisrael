import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  ensureDir,
  endpointUrl,
  extractLocs,
  fetchJson,
  fetchRestCollection,
  fetchText,
  mapLimit,
  safeFileName,
  SITE_URL,
  writeJson,
} from './lib/wordpress.mjs';

const exportId = process.env.WP_EXPORT_ID || new Date().toISOString().replace(/[:.]/g, '-');
const exportDir = join('data', 'wordpress-export', exportId);
const sitemapDir = join(exportDir, 'sitemaps');

const standardCollections = [
  { key: 'posts', restBase: 'posts', params: { _embed: 1 } },
  { key: 'pages', restBase: 'pages', params: { _embed: 1 } },
  { key: 'categories', restBase: 'categories' },
  { key: 'tags', restBase: 'tags' },
  { key: 'media', restBase: 'media' },
  { key: 'users', restBase: 'users' },
];

const skippedRestBases = new Set([
  'blocks',
  'comments',
  'media',
  'pages',
  'posts',
  'search',
  'settings',
  'statuses',
  'tags',
  'taxonomies',
  'types',
  'users',
]);

async function exportCollection(spec, manifest) {
  try {
    const collection = await fetchRestCollection(spec.restBase, spec.params || {});
    const file = `${spec.key}.json`;
    await writeJson(join(exportDir, file), collection);
    manifest.collections.push({ ...spec, file, count: collection.count, status: 'ok' });
    console.log(`exported ${spec.key}: ${collection.count}`);
  } catch (error) {
    manifest.collections.push({ ...spec, status: 'failed', error: error.message });
    console.warn(`failed ${spec.key}: ${error.message}`);
  }
}

async function main() {
  await ensureDir(exportDir);
  await ensureDir(sitemapDir);

  const manifest = {
    source: SITE_URL,
    exportId,
    createdAt: new Date().toISOString(),
    collections: [],
    sitemaps: [],
    htmlSnapshots: { count: 0, file: 'html-snapshots.json' },
  };

  const { data: types } = await fetchJson(endpointUrl('/wp-json/wp/v2/types'));
  await writeJson(join(exportDir, 'types.json'), types);

  const customCollections = Object.values(types)
    .map((type) => ({ key: type.rest_base || type.slug, restBase: type.rest_base || type.slug, params: { _embed: 1 }, sourceType: type.slug }))
    .filter((type) => type.restBase && !skippedRestBases.has(type.restBase));

  for (const spec of [...standardCollections, ...customCollections]) {
    await exportCollection(spec, manifest);
  }

  const sitemapIndex = await fetchText(endpointUrl('/wp-sitemap.xml'));
  await writeFile(join(exportDir, 'wp-sitemap.xml'), sitemapIndex.text, 'utf8');
  const childSitemaps = extractLocs(sitemapIndex.text);
  const allUrls = new Set();

  for (const sitemapUrl of childSitemaps) {
    try {
      const { text } = await fetchText(sitemapUrl);
      const file = `${safeFileName(sitemapUrl)}.xml`;
      await writeFile(join(sitemapDir, file), text, 'utf8');
      const urls = extractLocs(text);
      urls.forEach((url) => allUrls.add(url));
      manifest.sitemaps.push({ url: sitemapUrl, file: `sitemaps/${file}`, count: urls.length, status: 'ok' });
      console.log(`sitemap ${sitemapUrl}: ${urls.length}`);
    } catch (error) {
      manifest.sitemaps.push({ url: sitemapUrl, status: 'failed', error: error.message });
      console.warn(`failed sitemap ${sitemapUrl}: ${error.message}`);
    }
  }

  const sitemapUrls = [...allUrls].sort();
  await writeJson(join(exportDir, 'sitemap-urls.json'), sitemapUrls);

  let completedSnapshots = 0;
  const htmlSnapshots = await mapLimit(sitemapUrls, 6, async (url) => {
    try {
      const { text, headers, status } = await fetchText(url);
      return { url, status, contentType: headers.get('content-type') || '', html: text };
    } catch (error) {
      return { url, status: 0, error: error.message, html: '' };
    } finally {
      completedSnapshots += 1;
      if (completedSnapshots % 10 === 0 || completedSnapshots === sitemapUrls.length) {
        console.log(`html snapshots: ${completedSnapshots}/${sitemapUrls.length}`);
      }
    }
  });

  manifest.htmlSnapshots.count = htmlSnapshots.length;
  await writeJson(join(exportDir, 'html-snapshots.json'), htmlSnapshots);
  await writeJson(join(exportDir, 'manifest.json'), manifest);
  console.log(`export complete: ${exportDir}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});