(() => {
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const form = $('#form'), input = $('#url'), goBtn = $('#go');
  const statusEl = $('#status'), results = $('#results'), hint = $('#hint');
  const toastEl = $('#toast');
  let mode = 'ig', toastT, copyBuf = '';

  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
  const isHttp = s => { try { const u = new URL(s); return u.protocol === 'http:' || u.protocol === 'https:'; } catch { return false; } };

  /* ---------- Themes ---------- */
  const THEME_KEY = 'mx-theme';
  function setTheme(name) {
    document.documentElement.dataset.theme = name;
    try { localStorage.setItem(THEME_KEY, name); } catch {}
    $$('[data-set-theme]').forEach(b => b.setAttribute('aria-checked', String(b.dataset.setTheme === name)));
  }
  $$('[data-set-theme]').forEach(b => b.addEventListener('click', () => setTheme(b.dataset.setTheme)));
  let saved = 'glass';
  try { saved = localStorage.getItem(THEME_KEY) || 'glass'; } catch {}
  setTheme(saved);

  /* ---------- UI helpers ---------- */
  function toast(msg) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastT);
    toastT = setTimeout(() => toastEl.classList.remove('show'), 2200);
  }
  async function copy(text) {
    try { await navigator.clipboard.writeText(text); toast('Copied to clipboard'); }
    catch { toast('Copy failed. Select and copy manually.'); }
  }
  function setStatus(kind, text) {
    statusEl.className = 'status' + (kind === 'done' ? ' done' : kind === 'error' ? ' error' : '');
    statusEl.innerHTML = (kind === 'loading' ? '<span class="ring"></span>' : '') + esc(text);
  }

  /* ---------- 3D tilt (mouse only) ---------- */
  document.addEventListener('pointermove', e => {
    if (e.pointerType !== 'mouse') return;
    const el = e.target.closest?.('[data-tilt]');
    if (!el) return;
    const r = el.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width - .5;
    const y = (e.clientY - r.top) / r.height - .5;
    el.style.setProperty('--rx', `${(-y * 9).toFixed(2)}deg`);
    el.style.setProperty('--ry', `${(x * 11).toFixed(2)}deg`);
    el.style.setProperty('--gx', `${(x + .5) * 100}%`);
    el.style.setProperty('--gy', `${(y + .5) * 100}%`);
  });
  document.addEventListener('pointerout', e => {
    const el = e.target.closest?.('[data-tilt]');
    if (el && !el.contains(e.relatedTarget)) {
      el.style.setProperty('--rx', '0deg');
      el.style.setProperty('--ry', '0deg');
    }
  });

  /* ---------- Mode tabs ---------- */
  $$('.tab').forEach(t => t.addEventListener('click', () => {
    mode = t.dataset.mode;
    $$('.tab').forEach(x => x.setAttribute('aria-selected', String(x === t)));
    input.value = '';
    input.placeholder = mode === 'ig'
      ? 'Paste Instagram post or reel URL'
      : 'Paste direct Instagram CDN image or video URL';
    hint.textContent = mode === 'ig'
      ? 'Public posts, reels and TV links. Press Enter to extract.'
      : 'Direct media links from Instagram or Facebook CDNs only.';
    results.classList.add('hidden');
    statusEl.classList.add('hidden');
    input.focus();
  }));

  /* ---------- Rendering ---------- */
  const skeleton = () => `
    <div class="glass skel reveal" style="--i:0"></div>
    <div class="media-grid">
      <div class="glass skel-card reveal" style="--i:1"></div>
      <div class="glass skel-card reveal" style="--i:2"></div>
    </div>`;

  function summaryHTML(d, v, i) {
    const m = d.meta || {};
    const name = m.username ? '@' + String(m.username).replace(/^@/, '') : 'Instagram media';
    const cap = m.description || 'Media extracted successfully.';
    const avatar = m.thumbnail_url
      ? `<img class="avatar" src="${esc(m.thumbnail_url)}" alt="" referrerpolicy="no-referrer">`
      : `<div class="avatar ph">IG</div>`;
    return `
      <section class="glass summary tilt reveal" data-tilt style="--i:0">
        <div class="profile">
          ${avatar}
          <div class="who">
            <div class="username">${esc(name)}</div>
            <div class="caption">${esc(cap)}</div>
          </div>
        </div>
        <div class="chips">
          <span class="chip">${v} video${v === 1 ? '' : 's'}</span>
          <span class="chip">${i} image${i === 1 ? '' : 's'}</span>
          <span class="chip">${esc(d.type)}</span>
        </div>
      </section>`;
  }

  function mediaHTML(m, idx) {
    const isVid = m.type === 'video';
    const preview = isVid
      ? `<video class="vid" controls playsinline preload="metadata" src="${esc(m.preview)}"></video>`
      : `<img class="img" loading="lazy" src="${esc(m.preview)}" alt="Instagram image ${idx + 1}">`;
    return `
      <article class="glass media-card tilt reveal" data-tilt style="--i:${idx + 1}">
        <div class="preview">
          ${preview}
          <span class="fallback hidden">Preview unavailable. Use Download or Open.</span>
        </div>
        <div class="media-body">
          <div class="media-top">
            <span>${isVid ? 'Video' : 'Image'} ${idx + 1}</span>
            <span class="type-tag">CDN</span>
          </div>
          <div class="urlbox">
            <div class="urltext" id="u${idx}">${esc(m.src)}</div>
            <button class="urltoggle" data-act="toggle" data-idx="${idx}">Show full URL</button>
          </div>
          <div class="actions">
            <a class="action download" href="${esc(m.download)}" download="${esc(m.filename)}">Download</a>
            <button class="action" data-act="copy" data-idx="${idx}">Copy URL</button>
            <a class="action" href="${esc(m.src)}" target="_blank" rel="noopener noreferrer">Open ↗</a>
          </div>
        </div>
      </article>`;
  }

  function bindMedia() {
    $$('.vid', results).forEach(v => v.addEventListener('error', () => {
      v.style.display = 'none';
      v.parentElement.querySelector('.fallback').classList.remove('hidden');
    }));
    $$('.img', results).forEach(im => im.addEventListener('error', () => {
      im.style.display = 'none';
      im.parentElement.querySelector('.fallback').classList.remove('hidden');
    }));
  }

  function render(d) {
    const v = d.media.filter(x => x.type === 'video').length;
    const i = d.media.length - v;
    window.currentMedia = d.media;
    results.innerHTML = summaryHTML(d, v, i) + `<div class="media-grid">${d.media.map(mediaHTML).join('')}</div>`;
    results.classList.remove('hidden');
    bindMedia();
    setStatus('done', `Done — ${v} video(s), ${i} image(s)`);
  }

  function showError(msg) {
    results.innerHTML = `<div class="glass errorbox reveal">${esc(msg)}</div>`;
    results.classList.remove('hidden');
    setStatus('error', 'Could not extract media');
  }

  /* ---------- Submit ---------- */
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const value = input.value.trim();
    if (!isHttp(value)) return toast('Enter a valid http(s) URL');

    goBtn.disabled = true;
    goBtn.querySelector('span').textContent = 'Working';
    results.classList.remove('hidden');
    results.innerHTML = skeleton();
    setStatus('loading', mode === 'ig' ? 'Extracting…' : 'Loading CDN media…');

    try {
      const r = await fetch(mode === 'ig' ? '/api/extract' : '/api/direct', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: value }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.success) throw new Error(data.error || 'Extraction failed');
      render(data);
    } catch (err) {
      const msg = /fetch/i.test(err.message)
        ? 'Server unreachable. Make sure the backend is running (npm start).'
        : err.message;
      showError(msg);
    } finally {
      goBtn.disabled = false;
      goBtn.querySelector('span').textContent = 'Extract';
    }
  });

  /* ---------- Card actions ---------- */
  results.addEventListener('click', e => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const idx = Number(b.dataset.idx);
    const item = window.currentMedia?.[idx];
    if (b.dataset.act === 'toggle') {
      const el = $('#u' + idx);
      const full = el.classList.toggle('full');
      b.textContent = full ? 'Hide full URL' : 'Show full URL';
    }
    if (b.dataset.act === 'copy' && item) copy(item.src);
  });

  /* ---------- Modal (Docs / Prompt) ---------- */
  const DOCS = `Backend endpoints

POST /api/extract
  body: { "url": "https://www.instagram.com/reel/XXXX/" }

POST /api/direct
  body: { "url": "https://scontent.cdninstagram.com/..." }

GET /api/media?src={encoded_cdn_url}&dl=1&name={filename}
  streams the media (CDN allow-list only, Range supported)

Response:
{
  "success": true,
  "type": "video",
  "media": [{
    "type": "video",
    "src": "https://...cdninstagram...",
    "preview": "/api/media?src=...",
    "download": "/api/media?src=...&dl=1&name=ig-XXXX-1.mp4",
    "filename": "ig-XXXX-1.mp4"
  }],
  "meta": { "username": "example", "description": "Caption", "thumbnail_url": "/api/media?src=...", "likes": null }
}

Limits: 20 requests / minute / IP. Results cached 10 minutes.`;

  const PROMPT = `Build a mobile-first media extractor with a Node.js + Express backend and a vanilla frontend. Backend: POST /api/extract parses instagram.com post/reel/tv URLs, reads the embed and OG pages for video and image CDN links, validates CDN hosts to prevent SSRF, caches results, rate-limits per IP, and exposes GET /api/media as a streaming proxy with Range support and optional attachment download. Frontend: four switchable themes (Liquid Glass, Neon Cyber, Aurora, Synthwave), 3D tilt cards with glare, a rotating CSS 3D cube logo, a canvas particle background, shimmer skeletons, staggered reveal animations, status spinner, Show full URL toggle, Download, Copy and Open buttons, and Docs and Prompt modals. Footer: Copyright © Rolex 2026, Credit @RolexBot00.`;

  let copyBufText = '';
  function openModal(title, text) {
    $('#mTitle').textContent = title;
    $('#mBody').textContent = text;
    copyBufText = text;
    $('#modal').classList.remove('hidden');
  }
  const closeModal = () => $('#modal').classList.add('hidden');
  $('#docsBtn').addEventListener('click', () => openModal('API Docs', DOCS));
  $('#promptBtn').addEventListener('click', () => openModal('AI Prompt', PROMPT));
  $('#mCopy').addEventListener('click', () => copy(copyBufText));
  $('#mClose').addEventListener('click', closeModal);
  $('#mDone').addEventListener('click', closeModal);
  $('#modal').addEventListener('click', e => { if (e.target.id === 'modal') closeModal(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });

  /* ---------- Canvas particle background ---------- */
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
    const cv = $('#bg'), ctx = cv.getContext('2d');
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const N = 64;
    const P = Array.from({ length: N }, () => ({
      x: Math.random(), y: Math.random(), z: .3 + Math.random() * .7,
      vx: (Math.random() - .5) * .0005, vy: (Math.random() - .5) * .0005,
    }));
    let W, H, mx = 0, my = 0, color = '#888', frame = 0;
    const resize = () => { W = cv.width = innerWidth * dpr; H = cv.height = innerHeight * dpr; };
    resize();
    addEventListener('resize', resize);
    addEventListener('pointermove', e => {
      mx = e.clientX / innerWidth - .5;
      my = e.clientY / innerHeight - .5;
    }, { passive: true });

    const tick = () => {
      if (frame++ % 30 === 0) {
        color = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#888';
      }
      ctx.clearRect(0, 0, W, H);
      const pts = P.map(p => {
        p.x += p.vx; p.y += p.vy;
        if (p.x < 0 || p.x > 1) p.vx *= -1;
        if (p.y < 0 || p.y > 1) p.vy *= -1;
        return { x: (p.x + mx * .04 * p.z) * W, y: (p.y + my * .04 * p.z) * H, z: p.z };
      });
      ctx.strokeStyle = color;
      ctx.lineWidth = dpr;
      for (let a = 0; a < N; a++) {
        for (let b = a + 1; b < N; b++) {
          const dx = pts[a].x - pts[b].x, dy = pts[a].y - pts[b].y;
          const d = Math.hypot(dx, dy), lim = 140 * dpr;
          if (d < lim) {
            ctx.globalAlpha = (1 - d / lim) * .18;
            ctx.beginPath();
            ctx.moveTo(pts[a].x, pts[a].y);
            ctx.lineTo(pts[b].x, pts[b].y);
            ctx.stroke();
          }
        }
      }
      ctx.fillStyle = color;
      for (const p of pts) {
        ctx.globalAlpha = .3 + p.z * .5;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 1.6 * p.z * dpr, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      requestAnimationFrame(tick);
    };
    tick();
  }
})();
