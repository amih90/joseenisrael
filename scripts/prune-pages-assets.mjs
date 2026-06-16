import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';

const distDir = path.resolve(process.argv[2] || 'dist');
const uploadsDir = path.join(distDir, 'wp-content', 'uploads');
const scannedExtensions = new Set(['.html', '.css', '.js', '.xml']);
const localUploadPattern = /(?:https?:\/\/[^\s"'<>)]*)?\/(?:joseenisrael\/)?wp-content\/uploads\/[^\s"'<>),]+/gi;

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function walkFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walkFiles(entryPath));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }

  return files;
}

function localPathForReference(reference) {
  const parsed = reference.startsWith('http') ? new URL(reference) : new URL(reference, 'https://amih90.github.io');
  let pathname = parsed.pathname.replace(/^\/joseenisrael\//, '/');
  pathname = decodeURIComponent(pathname).replace(/^\/+/, '');
  return path.normalize(path.join(distDir, pathname));
}

function isInside(child, parent) {
  const relative = path.relative(parent, child);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function main() {
  if (!await exists(uploadsDir)) {
    console.log('No WordPress uploads directory found in dist. Nothing to prune.');
    return;
  }

  const files = await walkFiles(distDir);
  const keepFiles = new Set();

  for (const file of files) {
    if (!scannedExtensions.has(path.extname(file).toLowerCase())) continue;
    const text = await import('node:fs/promises').then(({ readFile }) => readFile(file, 'utf8'));

    for (const match of text.matchAll(localUploadPattern)) {
      const localPath = localPathForReference(match[0]);
      if (isInside(localPath, uploadsDir)) {
        keepFiles.add(localPath);
      }
    }
  }

  let removed = 0;
  let kept = 0;

  for (const file of await walkFiles(uploadsDir)) {
    if (keepFiles.has(path.normalize(file))) {
      kept += 1;
      continue;
    }

    await rm(file, { force: true });
    removed += 1;
  }

  console.log(`Pruned ${removed} unused WordPress media files from dist; kept ${kept} referenced files.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});