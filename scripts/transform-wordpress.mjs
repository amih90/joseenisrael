import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as cheerio from 'cheerio';
import TurndownService from 'turndown';
import {
  cleanRendered,
  ensureDir,
  latestExportDir,
  normalizeSiteUrl,
  readJson,
  SITE_URL,
  slugify,
  stripHtml,
  writeJson,
} from './lib/wordpress.mjs';

const turndown = new TurndownService({
  bulletListMarker: '-',
  codeBlockStyle: 'fenced',
  emDelimiter: '*',
  headingStyle: 'atx',
});

turndown.addRule('wordpressImages', {
  filter: 'img',
  replacement(_content, node) {
    const src = node.getAttribute('src') || node.getAttribute('data-src') || '';
    if (!src || src.startsWith('data:')) return '';
    const alt = node.getAttribute('alt') || node.getAttribute('title') || '';
    return `\n\n![${alt.replace(/[\[\]]/g, '')}](${normalizeSiteUrl(src)})\n\n`;
  },
});

function collectionItems(collection) {
  return Array.isArray(collection?.items) ? collection.items : [];
}

function decodeTitle(value) {
  return cheerio.load(value || '').root().text().trim();
}

function uniqueSlug(base, used) {
  const initial = slugify(base);
  let slug = initial;
  let index = 2;
  while (used.has(slug)) {
    slug = `${initial}-${index}`;
    index += 1;
  }
  used.add(slug);
  return slug;
}

function yamlString(value) {
  return JSON.stringify(value ?? '');
}

function yamlArray(values) {
  return JSON.stringify(values || []);
}

function frontmatter(data) {
  return Object.entries(data)
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => {
      if (Array.isArray(value)) return `${key}: ${yamlArray(value)}`;
      return `${key}: ${yamlString(value)}`;
    })
    .join('\n');
}

function cleanHtml(html) {
  const $ = cheerio.load(html || '', { decodeEntities: true });
  $('script, style, noscript, iframe, form, input, button').remove();
  $('img').each((_, image) => {
    const element = $(image);
    const source = element.attr('data-src') || element.attr('src') || '';
    const normalized = normalizeSiteUrl(source);
    if (!normalized || normalized.startsWith('data:')) {
      element.remove();
      return;
    }
    element.attr('src', normalized);
    element.removeAttr('srcset sizes data-src data-srcset class loading decoding fetchpriority');
  });

  $('[style*="background-image"]').each((_, element) => {
    const current = $(element);
    const style = current.attr('style') || '';
    const match = style.match(/url\(['"]?([^'")]+)['"]?\)/i);
    const normalized = normalizeSiteUrl(match?.[1] || '');
    if (normalized && !normalized.startsWith('data:')) {
      const label = current.attr('aria-label') || current.attr('data-elementor-lightbox-title') || '';
      current.after(`<p><img src="${normalized}" alt="${label}" /></p>`);
    }
  });

  $('.elementor-screen-only, .assistive-text, .swiper-pagination, .elementor-spacer, .project-links-container').remove();
  return $.root().html() || '';
}

function htmlToMarkdown(html) {
  return turndown
    .turndown(cleanHtml(html))
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

function firstUploadUrlFromHtml(html) {
  const $ = cheerio.load(cleanHtml(html || ''));
  const image = $('img[src*="/wp-content/uploads/"]').first().attr('src');
  return image ? normalizeSiteUrl(image) : undefined;
}

function legacyPath(item) {
  if (!item?.link) return undefined;
  try {
    return new URL(item.link).pathname;
  } catch {
    return undefined;
  }
}

function renderedPageSlug(page) {
  const title = decodeTitle(page.title?.rendered || '');
  const linkPath = legacyPath(page) || '';
  if (page.slug === 'home' || linkPath === '/') return 'home';
  if (title.toLowerCase() === 'agricultura') return 'agricultura';
  if (title.toLowerCase() === 'nuestros cultos') return 'nuestros-cultos';
  if (title.toLowerCase() === 'contacto') return 'contacto';
  if (title.toLowerCase() === 'creadores' || page.slug === 'contacto') return 'creadores';
  if (title.toLowerCase() === 'galeria' || page.slug === 'galeria') return 'galeria';
  if (title.toLowerCase() === 'blog' || page.slug === 'blog') return 'blog';
  if (page.slug === 'viajes') return 'viajes';
  return slugify(title || page.slug);
}

function pageStatus(page) {
  const title = decodeTitle(page.title?.rendered || '').toLowerCase();
  const slug = page.slug || '';
  if (['shop', 'my-account', 'privacy-policy', 'home-main'].includes(slug)) return 'archived';
  if (title.includes('privacy policy') || title === 'shop' || title === 'my account') return 'archived';
  if (renderedPageSlug(page) === 'blog') return 'archived';
  return 'rendered';
}

function extractGalleryImages(pages, htmlSnapshots) {
  const sources = [];
  const galleryPage = pages.find((page) => renderedPageSlug(page) === 'galeria');
  if (galleryPage?.content?.rendered) sources.push(galleryPage.content.rendered);
  for (const snapshot of htmlSnapshots.filter((item) => item.url?.includes('/galeria/'))) {
    sources.push(snapshot.html || '');
  }

  const images = [];
  const seen = new Set();
  for (const source of sources) {
    const $ = cheerio.load(source || '', { decodeEntities: true });
    $('a[href*="/wp-content/uploads/"]').each((_, anchor) => {
      const element = $(anchor);
      const src = normalizeSiteUrl(element.attr('href'));
      if (!src || seen.has(src)) return;
      seen.add(src);
      const thumbnail = normalizeSiteUrl(element.find('[data-thumbnail]').first().attr('data-thumbnail') || src);
      images.push({
        src,
        thumbnail,
        title: element.attr('data-elementor-lightbox-title') || element.find('[aria-label]').first().attr('aria-label') || '',
      });
    });
  }
  return images;
}

function extractTeam(htmlSnapshots) {
  const snapshots = htmlSnapshots.filter((item) => item.url?.includes('/dt_team/'));
  const team = [];
  for (const snapshot of snapshots) {
    const $ = cheerio.load(snapshot.html || '', { decodeEntities: true });
    const name = $('h1, h2, .entry-title').first().text().trim() || snapshot.url.split('/').filter(Boolean).at(-1);
    const email = $('a[href^="mailto:"]').first().attr('href')?.replace(/^mailto:/, '') || '';
    const image = normalizeSiteUrl($('img[src*="/wp-content/uploads/"]').first().attr('src'));
    const bio = stripHtml($('main, article, .content, body').first().text()).slice(0, 320);
    if (name) team.push({ name, role: 'Guia de turismo', email, image, bio, sourceUrl: snapshot.url });
  }

  if (team.length > 0) return team;
  return [
    { name: 'Jose Hollander', role: 'Guia de turismo', email: 'joseholl2014@gmail.com', image: '', bio: 'Guia de turismo en Tierra Santa y creador de Jos en Israel.' },
    { name: 'Shaked', role: 'Creador', email: '', image: '', bio: 'Parte del equipo de creadores de Jos en Israel.' },
    { name: 'Yanay', role: 'Creador', email: '', image: '', bio: 'Parte del equipo de creadores de Jos en Israel.' },
  ];
}

async function writeContentFile(root, slug, data, body) {
  await ensureDir(root);
  await writeFile(join(root, `${slug}.md`), `---\n${frontmatter(data)}\n---\n\n${body || data.description || ''}\n`, 'utf8');
}

async function main() {
  const exportDir = process.env.WP_EXPORT_DIR || (await latestExportDir());
  const posts = collectionItems(await readJson(join(exportDir, 'posts.json')));
  const pages = collectionItems(await readJson(join(exportDir, 'pages.json')));
  const categories = collectionItems(await readJson(join(exportDir, 'categories.json')).catch(() => ({ items: [] })));
  const tags = collectionItems(await readJson(join(exportDir, 'tags.json')).catch(() => ({ items: [] })));
  const users = collectionItems(await readJson(join(exportDir, 'users.json')).catch(() => ({ items: [] })));
  const htmlSnapshots = await readJson(join(exportDir, 'html-snapshots.json')).catch(() => []);

  const categoryById = new Map(categories.map((category) => [category.id, decodeTitle(category.name)]));
  const tagById = new Map(tags.map((tag) => [tag.id, decodeTitle(tag.name)]));
  const userById = new Map(users.map((user) => [user.id, user.name]));
  const postSlugByLegacyPath = new Map();
  const usedPostSlugs = new Set();

  await rm('src/content/posts', { recursive: true, force: true });
  await rm('src/content/pages', { recursive: true, force: true });

  for (const post of posts) {
    const title = decodeTitle(post.title?.rendered || 'Untitled');
    const desiredSlug = post.slug?.startsWith('elementor-') ? title : post.slug || title;
    const slug = uniqueSlug(desiredSlug, usedPostSlugs);
    const body = htmlToMarkdown(post.content?.rendered || post.excerpt?.rendered || '');
    const description = cleanRendered(post.excerpt).slice(0, 220);
    const path = legacyPath(post);
    postSlugByLegacyPath.set(path, slug);
    await writeContentFile('src/content/posts', slug, {
      title,
      description,
      pubDate: post.date,
      updatedDate: post.modified,
      categories: (post.categories || []).map((id) => categoryById.get(id)).filter(Boolean),
      tags: (post.tags || []).map((id) => tagById.get(id)).filter(Boolean),
      author: userById.get(post.author),
      originalUrl: post.link,
      legacyPath: path,
      heroImage: firstUploadUrlFromHtml(post.content?.rendered),
    }, body || description);
  }

  const renderedPages = [];
  const usedPageSlugs = new Set();
  for (const page of pages) {
    const status = pageStatus(page);
    const slug = uniqueSlug(renderedPageSlug(page), usedPageSlugs);
    const title = decodeTitle(page.title?.rendered || slug);
    const description = cleanRendered(page.excerpt || page.content).slice(0, 220);
    if (status === 'rendered') {
      renderedPages.push(slug);
      await writeContentFile('src/content/pages', slug, {
        title,
        description,
        sourceSlug: page.slug,
        originalUrl: page.link,
        legacyPath: legacyPath(page),
        status,
      }, htmlToMarkdown(page.content?.rendered || description));
    }
  }

  const gallery = extractGalleryImages(pages, htmlSnapshots);
  const team = extractTeam(htmlSnapshots);
  const latestHero = gallery[0]?.src || firstUploadUrlFromHtml(posts[0]?.content?.rendered) || '/wp-content/uploads/2021/09/JosEnIsrael.png';

  await ensureDir('src/data');
  await writeFile('src/data/site.ts', `export const site = ${JSON.stringify({
    name: 'Jos en Israel',
    title: 'Jos en Israel - Guias de turismo en Tierra Santa',
    description: 'Viajes personales, familiares y grupales por Israel con guias locales de habla hispana.',
    url: SITE_URL,
    language: 'es',
    phone: '+972 54 2448922',
    phoneDisplay: '972-54-2448922',
    whatsapp: 'https://wa.me/972542448922',
    email: 'joseholl2014@gmail.com',
    facebook: 'https://www.facebook.com/JosEnIsrael',
    instagram: 'https://www.instagram.com/jose_hollander/',
    heroImage: latestHero,
  }, null, 2)} as const;\n`, 'utf8');

  await writeFile('src/data/navigation.ts', `export const navigation = ${JSON.stringify([
    { label: 'Home', href: '/' },
    { label: 'Viajes', href: '/viajes/' },
    { label: 'Nuestros cultos', href: '/nuestros-cultos/' },
    { label: 'Agricultura', href: '/agricultura/' },
    { label: 'Blog', href: '/blog/' },
    { label: 'Galeria', href: '/galeria/' },
    { label: 'Contacto', href: '/contacto/' },
    { label: 'Creadores', href: '/creadores/' },
  ], null, 2)} as const;\n`, 'utf8');

  await writeFile('src/data/gallery.ts', `export const galleryImages = ${JSON.stringify(gallery, null, 2)} as const;\n`, 'utf8');
  await writeFile('src/data/team.ts', `export const teamMembers = ${JSON.stringify(team, null, 2)} as const;\n`, 'utf8');

  const legacyRedirects = [];
  for (const [from, slug] of postSlugByLegacyPath.entries()) {
    if (from) legacyRedirects.push({ from, to: `/blog/${slug}/` });
  }
  for (const page of pages) {
    const status = pageStatus(page);
    if (status !== 'rendered') continue;
    const from = legacyPath(page);
    const slug = renderedPageSlug(page);
    const to = slug === 'home' ? '/' : `/${slug}/`;
    if (from && from !== to) legacyRedirects.push({ from, to });
  }
  await writeFile('src/data/legacyRedirects.ts', `export const legacyRedirects = ${JSON.stringify(legacyRedirects, null, 2)} as const;\n`, 'utf8');

  const inventory = {
    exportDir,
    transformedAt: new Date().toISOString(),
    counts: { posts: posts.length, pages: pages.length, renderedPages: renderedPages.length, galleryImages: gallery.length, teamMembers: team.length },
    pages: pages.map((page) => ({ id: page.id, title: decodeTitle(page.title?.rendered || ''), slug: page.slug, renderedSlug: renderedPageSlug(page), status: pageStatus(page), link: page.link })),
    posts: posts.map((post) => ({ id: post.id, title: decodeTitle(post.title?.rendered || ''), slug: post.slug, link: post.link })),
  };
  await writeJson(join(exportDir, 'inventory.json'), inventory);
  console.log(`transform complete: ${JSON.stringify(inventory.counts)}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});