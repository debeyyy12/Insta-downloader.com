import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const CACHE_MS = 10 * 60 * 1000;
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX = 20;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36';

const IG_HOSTS = new Set(['instagram.com', 'www.instagram.com', 'instagr.am', 'www.instagr.am']);
const CDN_RE = /(^|\.)(cdninstagram\.com|fbcdn\.net)$/i;

const cache = new Map();
const hits = new Map();

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '4kb' }));
app.use((req, res, next) => {
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
  return recent.length <= RATE_MAX;
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

const previewUrl = src => `/api/media?src=${encodeURIComponent(src)}`;

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

/* ---------- scraping ---------- */

async function extractPost({ kind, shortcode }) {
  const hit = cache.get(shortcode);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;

  const canonical = `https://www.instagram.com/${kind}/${shortcode}/`;
  const raw = { videos: [], images: [], username: '', caption: '' };

  try {
    const embed = await fetchText(`${canonical}embed/captioned/`);
    for (const m of embed.matchAll(/"video_url"\s*:\s*"((?:[^"\\]|\\.)*)"/g)) raw.videos.push(decodeJsonString(m[1]));
    for (const m of embed.matchAll(/"display_url"\s*:\s*"((?:[^"\\]|\\.)*)"/g)) raw.images.push(decodeJsonString(m[1]));
    const u = embed.match(/"username"\s*:\s*"([^"]+)"/);
    if (u) raw.username = u[1];
  } catch { /* fall through to OG tags */ }

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
  } catch { /* nothing more to try */ }

  const videos = [...new Set(raw.videos)].filter(isCdn);
  const images = [...new Set(raw.images)].filter(isCdn);
  const list = videos.length
    ? videos.map(src => ({ type: 'video', src }))
    : images.map(src => ({ type: 'image', src }));

  if (!list.length) {
    const err = new Error('No public media found. The post may be private or unavailable.');
    err.status = 404;
    throw err;
  }

  const data = {
    success: true,
    type: list.length > 1 ? 'carousel' : list[0].type,
    media: list.map((m, i) => mediaItem(m, shortcode, i)),
    meta: {
      username: raw.username,
      description: raw.caption.slice(0, 600),
      thumbnail_url: images[0] ? previewUrl(images[0]) : '',
      likes: null,
    },
  };

  if (cache.size > 500) cache.delete(cache.keys().next().value);
  cache.set(shortcode, { at: Date.now(), data });
  return data;
}

/* ---------- routes ---------- */

app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.post('/api/extract', async (req, res) => {
  if (!rateOk(req.ip)) {
    return res.status(429).json({ success: false, error: 'Too many requests. Slow down a bit.' });
  }
  const parsed = parseIgUrl(req.body?.url);
  if (!parsed) {
    return res.status(400).json({ success: false, error: 'Enter a valid instagram.com post, reel, or tv URL.' });
  }
  try {
    res.json(await extractPost(parsed));
  } catch (e) {
    const status = e.status || 502;
    res.status(status).json({
      success: false,
      error: status === 404 ? e.message : 'Could not reach Instagram right now. Try again shortly.',
    });
  }
});

app.post('/api/direct', (req, res) => {
  if (!rateOk(req.ip)) {
    return res.status(429).json({ success: false, error: 'Too many requests. Slow down a bit.' });
  }
  const src = String(req.body?.url || '').trim();
  if (!isCdn(src)) {
    return res.status(400).json({ success: false, error: 'Only Instagram or Facebook CDN media URLs are allowed.' });
  }
  const type = /\.(mp4|mov|webm)(\?|$)/i.test(src) ? 'video' : 'image';
  res.json({
    success: true,
    type,
    media: [mediaItem({ type, src }, 'direct', 0)],
    meta: {
      username: 'Direct CDN URL',
      description: 'Direct media URL',
      thumbnail_url: type === 'image' ? previewUrl(src) : '',
      likes: null,
    },
  });
});

app.get('/api/media', async (req, res) => {
  const src = String(req.query.src || '');
  if (!isCdn(src)) return res.status(400).json({ error: 'Host not allowed' });

  const headers = { 'User-Agent': UA, Referer: 'https://www.instagram.com/' };
  if (req.headers.range) headers.Range = req.headers.range;

  try {
    const up = await fetch(src, { headers, redirect: 'follow' });
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
