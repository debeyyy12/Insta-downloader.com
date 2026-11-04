import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const CACHE_MS = 10 * 60 * 1000;
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX = 20;
const UPSTREAM = 'https://ig-dl-api.vercel.app/api';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';

const IG_HOSTS = new Set(['instagram.com', 'www.instagram.com', 'instagr.am', 'www.instagr.am']);
const CDN_RE = /(^|\.)(cdninstagram\.com|fbcdn\.net)$/i;
const PRIVATE_HOST_RE = /^(localhost|.*\.local|.*\.internal)$|^(\d{1,3}\.){3}\d{1,3}$|^\[?[0-9a-f:]+\]?$/i;

const extractCache = new Map();
const srcStore = new Map();
const hits = new Map();

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '4kb' }));
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});
app.use(express.static(path.join(ROOT, 'public'), { maxAge: '1h' }));

/* ---------- helpers ---------- */

const isCdn = src => {
  try {
    const u = new URL(src);
    return u.protocol === 'https:' && CDN_RE.test(u.hostname);
  } catch { return false; }
};

const isSafeHttps = src => {
  try {
    const u = new URL(src);
    return u.protocol === 'https:' && !PRIVATE_HOST_RE.test(u.hostname);
  } catch { return false; }
};

function parseIgUrl(raw) {
  let u;
  try { u = new URL(String(raw).trim()); } catch { return null; }
  if (!['http:', 'https:'].includes(u.protocol)) return null;
  if (!IG_HOSTS.has(u.hostname.toLowerCase())) return null;
  const m = u.pathname.match(/(?:^|\/)(p|reel|reels|tv)\/([A-Za-z0-9_-]{5,})/);
  return m ? { kind: m[1], shortcode: m[2] } : null;
}

function rateOk(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter(t => now - t < RATE_WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) hits.delete(hits.keys().next().value);
  return recent.length <= RATE_MAX;
}

function tokenFor(src) {
  const t = randomUUID().replace(/-/g, '');
  srcStore.set(t, { src, at: Date.now() });
  if (srcStore.size > 2000) srcStore.delete(srcStore.keys().next().value);
  return t;
}

const previewUrl = src => `/api/media?t=${tokenFor(src)}`;

function mediaItem(m, shortcode, i) {
  const filename = `ig-${shortcode}-${i + 1}.${m.type === 'video' ? 'mp4' : 'jpg'}`;
  const preview = previewUrl(m.src);
  return {
    type: m.type,
    src: m.src,
    preview,
    download: `${preview}&dl=1&name=${encodeURIComponent(filename)}`,
    filename,
  };
}

const decodeEntities = s => s
  .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>');

const decodeJsonString = s => {
  try { return JSON.parse(`"${s}"`); } catch { return s; }
};

function ogTag(html, prop) {
  const re = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']*)["']`, 'i');
  const m = html.match(re);
  return m ? decodeEntities(m[1]) : '';
}

async function fetchText(url, ms = 12000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9', Accept: 'text/html' },
    });
    if (!r.ok) throw new Error(`upstream ${r.status}`);
    return await r.text();
  } finally {
    clearTimeout(timer);
  }
}

function buildResponse(list, shortcode, meta) {
  return {
    success: true,
    type: list.length > 1 ? 'carousel' : list[0].type,
    media: list.map((m, i) => mediaItem(m, shortcode, i)),
    meta: {
      username: meta.username || '',
      description: String(meta.description || '').slice(0, 600),
      thumbnail_url: meta.thumb ? previewUrl(meta.thumb) : '',
      likes: meta.likes ?? null,
    },
  };
}

/* ---------- extraction: upstream (primary) ---------- */

// Upstream ke response ke alag-alag shapes handle karta hai.
function pickList(d) {
  const candidates = [d.media, d.data, d.data?.media, d.result, d.result?.media, d.items];
  const arr = candidates.find(Array.isArray);
  if (arr) return arr;
  // Single URL wala response
  const single = d.cdn_url || d.download_url || d.video_url || d.url || d.data?.url;
  if (typeof single === 'string') return [{ url: single, type: /\.(mp4|mov|webm)(\?|$)/i.test(single) ? 'video' : 'image' }];
  return [];
}

async function extractViaUpstream(igUrl) {
  const r = await fetch(`${UPSTREAM}?url=${encodeURIComponent(igUrl)}`, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(18000),
  });
  if (!r.ok) throw Object.assign(new Error(`Upstream ${r.status}`), { status: 502 });

  const text = await r.text();
  let d;
  try { d = JSON.parse(text); } catch {
    throw Object.assign(new Error('Upstream returned non-JSON'), { status: 502 });
  }
  if (d.success === false) throw Object.assign(new Error(d.error || 'Upstream failed'), { status: 502 });

  const list = pickList(d)
    .map(x => {
      const src = x.cdn_url || x.download_url || x.video_url || x.display_url || x.url || x.src || '';
      const isVid = /video/i.test(x.type || '') || !!x.video_url || /\.(mp4|mov|webm)(\?|$)/i.test(src);
      return { type: isVid ? 'video' : 'image', src };
    })
    .filter(x => isSafeHttps(x.src));

  if (!list.length) throw Object.assign(new Error('No public media found.'), { status: 404 });

  const meta = d.meta || d.metadata || d.data?.meta || {};
  const thumb = meta.thumbnail_url && isSafeHttps(meta.thumbnail_url) ? meta.thumbnail_url : '';
  return buildResponse(list, 'upstream', {
    username: meta.username || '',
    description: meta.description || meta.caption || '',
    thumb,
    likes: meta.likes ?? null,
  });
}

/* ---------- extraction: scraper (fallback) ---------- */

async function extractViaScraper({ kind, shortcode }) {
  const canonical = `https://www.instagram.com/${kind}/${shortcode}/`;
  const raw = { videos: [], images: [], username: '', caption: '' };

  try {
    const embed = await fetchText(`${canonical}embed/captioned/`);
    for (const m of embed.matchAll(/"video_url"\s*:\s*"((?:[^"\\]|\\.)*)"/g)) raw.videos.push(decodeJsonString(m[1]));
    for (const m of embed.matchAll(/"display_url"\s*:\s*"((?:[^"\\]|\\.)*)"/g)) raw.images.push(decodeJsonString(m[1]));
    const u = embed.match(/"username"\s*:\s*"([^"]+)"/);
    if (u) raw.username = u[1];
  } catch { /* OG tags par fallback */ }

  try {
    const page = await fetchText(canonical);
    const v = ogTag(page, 'og:video') || ogTag(page, 'og:video:secure_url');
    const i = ogTag(page, 'og:image');
    if (v) raw.videos.push(v);
    if (i) raw.images.push(i);
    raw.caption ||= ogTag(page, 'og:description');
    if (!raw.username) {
      const m = ogTag(page, 'og:title').match(/@([\w.]+)/);
      if (m) raw.username = m[1];
    }
  } catch { /* aur kuch nahi */ }

  const videos = [...new Set(raw.videos)].filter(isCdn);
  const images = [...new Set(raw.images)].filter(isCdn);
  const list = videos.length
    ? videos.map(src => ({ type: 'video', src }))
    : images.map(src => ({ type: 'image', src }));

  if (!list.length) {
    throw Object.assign(new Error('No public media found. The post may be private or unavailable.'), { status: 404 });
  }

  return buildResponse(list, shortcode, {
    username: raw.username,
    description: raw.caption,
    thumb: images[0] || '',
    likes: null,
  });
}

/* ---------- combined ---------- */

async function extractAny(igUrl, parsed) {
  const key = parsed.shortcode;
  const hit = extractCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;

  let data;
  try {
    data = await extractViaUpstream(igUrl);
  } catch (upErr) {
    console.warn('[upstream failed]', upErr.message);
    try {
      data = await extractViaScraper(parsed);
    } catch (scErr) {
      console.warn('[scraper failed]', scErr.message);
      const err = new Error(scErr.message || upErr.message);
      err.status = scErr.status || 502;
      throw err;
    }
  }

  if (extractCache.size > 500) extractCache.delete(extractCache.keys().next().value);
  extractCache.set(key, { at: Date.now(), data });
  return data;
}

/* ---------- routes ---------- */

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.post('/api/extract', async (req, res) => {
  if (!rateOk(req.ip)) {
    return res.status(429).json({ success: false, error: 'Too many requests. Slow down a bit.' });
  }
  const url = String(req.body?.url || '').trim();
  const parsed = parseIgUrl(url);
  if (!parsed) {
    return res.status(400).json({ success: false, error: 'Enter a valid instagram.com post, reel, or tv URL.' });
  }
  try {
    res.json(await extractAny(url, parsed));
  } catch (e) {
    const status = e.status || 502;
    res.status(status).json({
      success: false,
      error: status === 404 ? e.message : 'Could not extract media right now. Try again shortly.',
    });
  }
});

app.post('/api/direct', (req, res) => {
  if (!rateOk(req.ip)) {
    return res.status(429).json({ success: false, error: 'Too many requests. Slow down a bit.' });
  }
  const src = String(req.body?.url || '').trim();
  if (!isSafeHttps(src)) {
    return res.status(400).json({ success: false, error: 'Only public https media URLs are allowed.' });
  }
  const type = /\.(mp4|mov|webm)(\?|$)/i.test(src) ? 'video' : 'image';
  res.json(buildResponse([{ type, src }], 'direct', {
    username: 'Direct CDN URL',
    description: 'Direct media URL',
    thumb: type === 'image' ? src : '',
    likes: null,
  }));
});

app.get('/api/media', async (req, res) => {
  const entry = srcStore.get(String(req.query.t || ''));
  if (!entry || Date.now() - entry.at > CACHE_MS) {
    return res.status(404).json({ error: 'Link expired. Extract again.' });
  }
  const src = entry.src;

  const headers = { 'User-Agent': UA, Referer: 'https://www.instagram.com/' };
  if (req.headers.range) headers.Range = req.headers.range;

  try {
    const up = await fetch(src, { headers, redirect: 'follow', signal: AbortSignal.timeout(30000) });
    if (!up.ok && up.status !== 206) return res.status(502).json({ error: `Upstream ${up.status}` });

    const ct = up.headers.get('content-type') || '';
    if (!/^(video|image)\//.test(ct)) return res.status(415).json({ error: 'Not a media file' });

    res.status(up.status);
    for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
      const v = up.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    if (req.query.dl) {
      const name = String(req.query.name || 'media').replace(/[^\w.-]/g, '_').slice(0, 80);
      res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    }
    res.setHeader('Cache-Control', 'private, max-age=600');

    if (!up.body) return res.end();
    Readable.fromWeb(up.body).on('error', () => res.destroy()).pipe(res);
  } catch {
    if (!res.headersSent) res.status(502).json({ error: 'Media fetch failed' });
  }
});

app.listen(PORT, () => console.log(`Media Extractor Pro running → http://localhost:${PORT}`));
