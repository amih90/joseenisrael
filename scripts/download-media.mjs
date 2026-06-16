import { createWriteStream } from 'node:fs';
import { readFile, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import {
  ensureDir,
  extractUploadUrlsFromText,
  fetchWithRetry,
  latestExportDir,
  localPathForUploadUrl,
  mapLimit,
  publicPathFor,
  walkFiles,
  writeJson,
} from './lib/wordpress.mjs';

async function collectUrls(exportDir) {
  const files = await walkFiles(exportDir);
  const urls = new Set();
  for (const file of files) {
    if (file.endsWith('media-manifest.json')) continue;
    const content = await readFile(file, 'utf8');
    extractUploadUrlsFromText(content).forEach((url) => urls.add(url));
  }
  return [...urls].sort();
}

function mediaTimeoutMs() {
  return Number(process.env.WP_MEDIA_TIMEOUT_MS || process.env.WP_FETCH_TIMEOUT_MS || 20000);
}

async function downloadOne(url) {
  const localPath = localPathForUploadUrl(url);
  const publicPath = publicPathFor(localPath);
  await ensureDir(dirname(localPath));
  const existing = await stat(localPath).catch(() => null);

  const timeoutMs = mediaTimeoutMs();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchWithRetry(url, { headers: { accept: '*/*' }, signal: controller.signal, timeoutMs }, 2);
    if (!response.ok || !response.body) {
      return { url, publicPath, localPath, status: 'failed', httpStatus: response.status, error: response.statusText };
    }

    const expectedBytes = Number(response.headers.get('content-length') || 0);
    if (existing?.size > 0 && expectedBytes > 0 && existing.size === expectedBytes) {
      return { url, publicPath, localPath, status: 'skipped', bytes: existing.size };
    }

    await pipeline(response.body, createWriteStream(localPath), { signal: controller.signal });
    const written = await stat(localPath);
    return {
      url,
      publicPath,
      localPath,
      status: 'downloaded',
      httpStatus: response.status,
      contentType: response.headers.get('content-type') || '',
      bytes: written.size,
    };
  } catch (error) {
    await rm(localPath, { force: true });
    throw controller.signal.aborted ? new Error(`GET ${url} timed out after ${timeoutMs}ms`) : error;
  } finally {
    clearTimeout(timeout);
  }
}

async function main() {
  const exportDir = process.env.WP_EXPORT_DIR || (await latestExportDir());
  const urls = await collectUrls(exportDir);
  console.log(`media urls found: ${urls.length}`);

  let completed = 0;
  const results = await mapLimit(urls, 8, async (url) => {
    try {
      return await downloadOne(url);
    } catch (error) {
      return { url, status: 'failed', error: error.message };
    } finally {
      completed += 1;
      if (completed % 25 === 0 || completed === urls.length) {
        console.log(`media progress: ${completed}/${urls.length}`);
      }
    }
  });

  const summary = results.reduce(
    (acc, item) => {
      acc[item.status] = (acc[item.status] || 0) + 1;
      return acc;
    },
    { downloaded: 0, skipped: 0, failed: 0 },
  );

  await writeJson(join(exportDir, 'media-manifest.json'), {
    exportDir,
    createdAt: new Date().toISOString(),
    summary,
    items: results,
  });

  console.log(`media complete: ${JSON.stringify(summary)}`);
  if (summary.failed > 0 && process.env.STRICT_MEDIA === '1') {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});