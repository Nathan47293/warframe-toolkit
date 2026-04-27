// Warframe Toolkit Chrome Extension — content script
// Two panels share this script:
//   - Dynamic Price Automator: warframe.market/profile/<slug>
//   - Ducanator 2.0: Ducanator page (under /tools/...)
// Each panel has its own master toggle (default OFF, persisted). The toggle is the
// only thing that authorises auto-runs — status flipping to "ingame" never auto-flips
// the toggle from off→on.

(function () {
  const isProfilePage = () => location.pathname.startsWith('/profile/');
  const isDucanatorPage = () => location.pathname === '/tools/ducats' || location.pathname.startsWith('/tools/ducats');
  // Quick top-level filter: if the URL isn't even one we care about, exit immediately.
  if (!isProfilePage() && !isDucanatorPage()) return;

  // ════════════════════════════════════════════════════════════
  // SHARED HELPERS (used by both panels)
  // ════════════════════════════════════════════════════════════

  const ENDO_COSTS = {
    'Common': 10230,
    'Uncommon': 20460,
    'Galv/Rare': 30690,
    'Archon/Primed': 40920,
  };
  const PACE_MS = 350;
  const APPLY_PACE_MS = 500;

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function makeDraggable(el, handle) {
    let dx = 0, dy = 0, startX = 0, startY = 0, dragging = false;
    handle.addEventListener('mousedown', (e) => {
      // don't start a drag if the user clicked an interactive element in the header
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON' ||
          e.target.closest('label, button, input')) return;
      dragging = true;
      const rect = el.getBoundingClientRect();
      startX = e.clientX; startY = e.clientY;
      dx = rect.left; dy = rect.top;
      el.style.right = 'auto';
      el.style.left = `${dx}px`;
      el.style.top = `${dy}px`;
      e.preventDefault();
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      el.style.left = `${dx + e.clientX - startX}px`;
      el.style.top = `${dy + e.clientY - startY}px`;
    });
    document.addEventListener('mouseup', () => { dragging = false; });
  }

  // ─── API ───
  // Crossplay: true tells warframe.market to include cross-platform sellers (Xbox, PS,
  // mobile) who have crossplay enabled. Switch is auto-excluded by the API since it
  // can't trade with PC. Without this header, ~7% of competing ingame sells are missed.
  async function api(path) {
    const resp = await fetch(`https://api.warframe.market${path}`, {
      headers: { 'Language': 'en', 'Platform': 'pc', 'Crossplay': 'true' },
      credentials: 'include',
    });
    if (!resp.ok) throw new Error(`${path} → HTTP ${resp.status}`);
    return resp.json();
  }

  let _itemsBySlug = null, _itemsById = null;
  async function getItemsMaps() {
    if (_itemsBySlug) return { bySlug: _itemsBySlug, byId: _itemsById };
    const data = await api('/v2/items');
    _itemsBySlug = {}; _itemsById = {};
    for (const item of (data.data || [])) {
      _itemsBySlug[item.slug] = item;
      _itemsById[item.id] = item;
    }
    return { bySlug: _itemsBySlug, byId: _itemsById };
  }

  async function getMyOrders(slug) {
    const data = await api(`/v2/orders/user/${encodeURIComponent(slug)}`);
    return data.data || [];
  }
  async function getItemOrders(slug) {
    const data = await api(`/v2/orders/item/${encodeURIComponent(slug)}`);
    return data.data || [];
  }
  function getCsrfToken() {
    return document.querySelector('meta[name="csrf-token"]')?.content || '';
  }
  async function patchOrder(orderId, body) {
    const headers = {
      'Content-Type': 'application/json',
      'Language': 'en',
      'Platform': 'pc',
      'Crossplay': 'true',
    };
    const csrf = getCsrfToken();
    if (csrf) headers['X-CSRFToken'] = csrf;
    const resp = await fetch(`https://api.warframe.market/v2/order/${encodeURIComponent(orderId)}`, {
      method: 'PATCH', headers, credentials: 'include',
      body: JSON.stringify(body),
    });
    if (!resp.ok) throw new Error(`PATCH /v2/order/${orderId} → HTTP ${resp.status}`);
    return resp.json();
  }

  // ─── Status detection (shared by both panels) ───
  function scrapeStatusFromDOM() {
    const headerEl = document.querySelector('header, .header, [class*="header"]');
    const headerText = (headerEl?.innerText || '').toLowerCase();
    if (!headerText) return null;
    if (/in[-_ ]?game/.test(headerText)) return 'ingame';
    if (/\binvisible\b/.test(headerText)) return 'invisible';
    if (/\bonline\b/.test(headerText)) return 'online';
    if (/\boffline\b/.test(headerText)) return 'offline';
    return null;
  }
  async function detectMyStatus(mySlug) {
    const dom = scrapeStatusFromDOM();
    if (dom) return { status: dom, source: 'dom' };
    if (!mySlug) return { status: 'unknown', source: 'no-slug' };
    try {
      const data = await api(`/v2/user/${encodeURIComponent(mySlug)}`);
      return { status: data.data?.status || 'unknown', source: 'api' };
    } catch (e) {
      return { status: 'unknown', source: 'error' };
    }
  }

  // The logged-in user's slug, scraped from the avatar link in the page header.
  // Works on any warframe.market page once the SPA has rendered the header widget.
  function getLoggedInSlug() {
    const link = document.querySelector(
      'header a[href^="/profile/"], .header a[href^="/profile/"], [class*="header"] a[href^="/profile/"]'
    );
    if (!link) return '';
    const m = (link.getAttribute('href') || '').match(/^\/profile\/([^/?#]+)/);
    return m ? decodeURIComponent(m[1]) : '';
  }

  // Polls for the header avatar link until it's rendered (SPA can hydrate after document_idle).
  async function waitForLoggedInSlug(maxMs = 10000) {
    const start = Date.now();
    while (Date.now() - start < maxMs) {
      const slug = getLoggedInSlug();
      if (slug) return slug;
      await sleep(500);
    }
    return '';
  }

  // The user's cached profile slug, set via the one-time claim prompt
  // (see injectClaimProfilePrompt). Empty string if not set yet.
  function getCachedMySlug() {
    return (localStorage.getItem('wfaap-my-slug') || '').toLowerCase();
  }

  // The current URL's profile slug, lowercased; '' if not on a profile page.
  function getUrlProfileSlug() {
    if (!isProfilePage()) return '';
    return decodeURIComponent(location.pathname.split('/')[2] || '').toLowerCase();
  }

  // The user's own slug. Prefers the cached value (reliable across pages).
  // Falls back to the URL slug on profile pages, or the header-avatar slug elsewhere.
  function getMySlug() {
    const cached = getCachedMySlug();
    if (cached) return cached;
    if (isProfilePage()) {
      return decodeURIComponent(location.pathname.split('/')[2] || '');
    }
    return getLoggedInSlug();
  }

  // ─── Shared CSS for both panels ───
  function injectSharedCss() {
    if (document.getElementById('wfaap-shared-style')) return;
    const style = document.createElement('style');
    style.id = 'wfaap-shared-style';
    style.textContent = `
      .wfaap-panel { position: fixed; top: 80px; right: 16px; width: 360px; max-height: 75vh;
        overflow-y: auto; background: #0d1117; border: 1px solid #1e2a3a; border-radius: 8px;
        color: #e0e0e0; font-family: 'Segoe UI', 'Inter', sans-serif; font-size: 13px;
        z-index: 9999; box-shadow: 0 4px 20px rgba(0,0,0,0.4); }
      .wfaap-header { display: flex; justify-content: space-between; align-items: center;
        padding: 10px 12px; background: #131a27; border-bottom: 1px solid #1e2a3a;
        font-weight: 700; color: #00e5ff; cursor: move; user-select: none;
        border-radius: 8px 8px 0 0; gap: 8px; }
      .wfaap-header > span:first-child { font-size: 13px; letter-spacing: 0.3px; flex: 1; }
      .wfaap-header-controls { display: flex; align-items: center; gap: 6px; }
      .wfaap-btn-icon { background: transparent; border: none; color: #00e5ff;
        font-size: 16px; cursor: pointer; padding: 0 4px; line-height: 1; }
      .wfaap-toggle { position: relative; display: inline-block; width: 32px; height: 18px;
        cursor: pointer; flex-shrink: 0; }
      .wfaap-toggle input { display: none; }
      .wfaap-toggle-track { position: absolute; top: 0; left: 0; right: 0; bottom: 0;
        background: #2a3a4a; border-radius: 9px; transition: background 0.2s; }
      .wfaap-toggle-track:before { position: absolute; content: ''; height: 14px; width: 14px;
        left: 2px; top: 2px; background: #8899aa; border-radius: 50%; transition: 0.2s; }
      .wfaap-toggle input:checked + .wfaap-toggle-track { background: #00b4d8; }
      .wfaap-toggle input:checked + .wfaap-toggle-track:before {
        transform: translateX(14px); background: #fff; }
      .wfaap-body { padding: 12px; }
      .wfaap-row-label { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
      .wfaap-row-label > span { color: #8899aa; font-size: 12px; flex: 1; }
      .wfaap-row-label input { width: 70px; padding: 4px 6px; background: #131a27;
        color: #e0e0e0; border: 1px solid #2a3a4a; border-radius: 3px; font-size: 12px;
        text-align: right; font-family: inherit; }
      .wfaap-row-label input:focus { outline: none; border-color: #00b4d8; }
      .wfaap-row-label select { padding: 4px 6px; background: #131a27;
        color: #e0e0e0; border: 1px solid #2a3a4a; border-radius: 3px; font-size: 12px;
        font-family: inherit; cursor: pointer; }
      .wfaap-row-label select:focus { outline: none; border-color: #00b4d8; }
      .wfaap-profile-footer { margin-top: 10px; padding-top: 8px; border-top: 1px solid #1e2a3a;
        font-size: 10px; color: #556677; text-align: center; }
      .wfaap-profile-footer a { color: #00b4d8; text-decoration: none; }
      .wfaap-profile-footer a:hover { text-decoration: underline; }
      .wfaap-claim-input { width: 100%; padding: 6px; background: #131a27; color: #e0e0e0;
        border: 1px solid #2a3a4a; border-radius: 3px; font-size: 12px;
        font-family: inherit; margin-bottom: 10px; box-sizing: border-box; }
      .wfaap-claim-input:focus { outline: none; border-color: #00b4d8; }
      .wfaap-claim-blurb { font-size: 12px; color: #cdd; margin-bottom: 10px; line-height: 1.4; }
      .wfaap-blocklist-details { margin-top: 10px; padding-top: 8px; border-top: 1px solid #1e2a3a; }
      .wfaap-blocklist-details summary { cursor: pointer; font-size: 12px; color: #8899aa; user-select: none; outline: none; }
      .wfaap-blocklist-details[open] summary { margin-bottom: 8px; }
      .wfaap-blocklist-body { display: flex; flex-direction: column; gap: 4px;
        max-height: 200px; overflow-y: auto; }
      .wfaap-blocklist-row { display: flex; justify-content: space-between; align-items: center;
        padding: 4px 6px; background: #131a27; border: 1px solid #2a3a4a;
        border-radius: 3px; font-size: 12px; }
      .wfaap-blocklist-row a { color: #00b4d8; text-decoration: none; }
      .wfaap-blocklist-row a:hover { text-decoration: underline; }
      .wfaap-blocklist-remove { background: none; border: none; color: #ff6b6b;
        font-size: 14px; cursor: pointer; padding: 0 4px; line-height: 1; }
      .wfaap-blocklist-remove:hover { color: #ff4444; }
      .wfaap-blocklist-empty { font-size: 11px; color: #556677; text-align: center; padding: 4px; }
      .wfaap-block-seller { color: #ff6b6b; text-decoration: none; font-size: 11px;
        margin-left: 4px; cursor: pointer; }
      .wfaap-block-seller:hover { text-decoration: underline; color: #ff4444; }
      .wfaap-copy-msg { color: #00e5ff; text-decoration: none; font-size: 11px;
        margin-left: 4px; cursor: pointer; }
      .wfaap-copy-msg:hover { text-decoration: underline; color: #5af0ff; }
      .wfaap-copy-msg.copied { color: #4ade80; }
      .wfaap-run { width: 100%; padding: 8px; color: #fff; border: none;
        border-radius: 4px; cursor: pointer; font-weight: 600; font-size: 12px;
        transition: all 0.2s; background: linear-gradient(135deg, #00b4d8, #0077b6); }
      .wfaap-run:hover { background: linear-gradient(135deg, #00e5ff, #0096c7); }
      .wfaap-run:disabled { opacity: 0.5; cursor: not-allowed; }
      .wfaap-meta { font-size: 11px; color: #667788; margin-top: 8px; }
      .wfaap-meta .ingame { color: #4ade80; font-weight: 600; }
      .wfaap-meta .online { color: #00e5ff; }
      .wfaap-meta .offline, .wfaap-meta .invisible { color: #8899aa; }
      .wfaap-status { font-size: 11px; color: #8899aa; margin-top: 6px; min-height: 14px; }
      .wfaap-results { margin-top: 8px; max-height: 50vh; overflow-y: auto; }
      .wfaap-rec { padding: 6px 4px; border-bottom: 1px solid #1a2332; }
      .wfaap-rec:last-child { border-bottom: none; }
      .wfaap-rec-name { font-weight: 600; color: #e0e0e0; font-size: 12px; }
      .wfaap-rec-ratio { font-weight: 500; font-size: 11px; color: #667788; margin-left: 4px; }
      .wfaap-rec-detail { font-size: 11px; color: #8899aa; margin-top: 2px; line-height: 1.4; }
      .wfaap-rec-detail a { color: #00b4d8; text-decoration: none; }
      .wfaap-rec-detail a:hover { text-decoration: underline; }
      .wfaap-rec.move .wfaap-rec-name { color: #4ade80; }
      .wfaap-rec.applied .wfaap-rec-name { color: #00e5ff; }
      .wfaap-rec.floor .wfaap-rec-name { color: #fbbf24; }
      .wfaap-rec.noop .wfaap-rec-name { color: #8899aa; }
      .wfaap-rec.error .wfaap-rec-name { color: #f87171; }
      .wfaap-rec.deal .wfaap-rec-name { color: #4ade80; }
      .wfaap-panel.collapsed .wfaap-body { display: none; }
    `;
    document.head.appendChild(style);
  }

  // ─── Generic rec renderer (shared) ───
  function renderRecs(container, recs) {
    container.innerHTML = recs.length === 0
      ? '<div class="wfaap-rec-detail">No results.</div>'
      : recs.map(r => {
          const ratio = (r.ratio != null) ? ` <span class="wfaap-rec-ratio">${r.ratio.toFixed(2)} ${r.unit || ''}</span>` : '';
          return `<div class="wfaap-rec ${r.kind}">
            <div class="wfaap-rec-name">${escapeHtml(r.name)}${ratio}</div>
            <div class="wfaap-rec-detail">${r.detail || ''}</div>
          </div>`;
        }).join('');
  }

  // ════════════════════════════════════════════════════════════
  // DYNAMIC PRICE AUTOMATOR (warframe.market/profile/<slug>)
  // ════════════════════════════════════════════════════════════
  const AP = {
    FLOOR: 'wfaap-floor',
    INTERVAL: 'wfaap-interval',
    COLLAPSED: 'wfaap-collapsed',
    ENABLED: 'wfaap-enabled',
    LAST_SCAN: 'wfaap-last-scan',
    SKIP_INITIAL: 'wfaap-skip-initial',
    LAST_RUN: 'wfaap-last-run',
    MY_SLUG: 'wfaap-my-slug',
    DEFAULT_FLOOR: 2.5,
    DEFAULT_INTERVAL: 300,
    POST_APPLY_REFRESH_MS: 2000,
  };

  function classifyTier(name, tags) {
    const n = (name || '').toLowerCase();
    if (n.startsWith('primed ') || n.startsWith('archon ') ||
        tags.includes('legendary') || tags.includes('archon')) return 'Archon/Primed';
    if (n.startsWith('galvanized ') || tags.includes('rare')) return 'Galv/Rare';
    if (tags.includes('uncommon')) return 'Uncommon';
    if (tags.includes('common')) return 'Common';
    return null;
  }
  function isModItem(tags) {
    return tags.includes('mod') && !tags.includes('riven_mod');
  }

  function competingIngameSells(orders, mySlug, rank) {
    const me = (mySlug || '').toLowerCase();
    return orders
      .filter(o => o.type === 'sell')
      .filter(o => o.user?.status === 'ingame')
      .filter(o => (o.user?.slug || '').toLowerCase() !== me)
      .filter(o => o.platinum > 0)
      .filter(o => rank == null || o.rank === rank)
      .sort((a, b) => a.platinum - b.platinum);
  }
  function findOptimalPriceTier(competitors, endoCost, floor) {
    for (let i = 0; i < competitors.length; i++) {
      const newPrice = competitors[i].platinum - 1;
      const ratio = (newPrice / endoCost) * 1000;
      if (ratio >= floor) {
        return {
          position: i + 1, totalCompetitors: competitors.length,
          competitor: competitors[i], newPrice, ratio,
        };
      }
    }
    return null;
  }

  function injectAutoPricerPanel() {
    if (document.getElementById('wfap-panel')) return;
    const panel = document.createElement('div');
    panel.id = 'wfap-panel';
    panel.className = 'wfaap-panel';
    panel.innerHTML = `
      <div class="wfaap-header">
        <span>Dynamic Price Automator</span>
        <div class="wfaap-header-controls">
          <label class="wfaap-toggle" title="Enable auto-runs"><input type="checkbox" id="wfap-enabled"><span class="wfaap-toggle-track"></span></label>
          <button class="wfaap-btn-icon" id="wfap-collapse" title="Collapse">−</button>
        </div>
      </div>
      <div class="wfaap-body">
        <div class="wfaap-row-label"><span>Plat/1k Endo floor</span>
          <input id="wfap-floor" type="number" step="0.1" min="0"></div>
        <div class="wfaap-row-label"><span>Auto-run interval (sec)</span>
          <input id="wfap-interval" type="number" step="1" min="30"></div>
        <button class="wfaap-run" id="wfap-run">Run Now</button>
        <div class="wfaap-meta" id="wfap-meta">Status: ?</div>
        <div class="wfaap-status" id="wfap-status">Idle.</div>
        <div class="wfaap-results" id="wfap-results"></div>
        <div class="wfaap-profile-footer" id="wfap-profile-footer"></div>
      </div>
    `;
    document.body.appendChild(panel);

    // Inputs (persisted)
    const floorInput = panel.querySelector('#wfap-floor');
    floorInput.value = localStorage.getItem(AP.FLOOR) || String(AP.DEFAULT_FLOOR);
    floorInput.addEventListener('input', () => localStorage.setItem(AP.FLOOR, floorInput.value));

    const intervalInput = panel.querySelector('#wfap-interval');
    intervalInput.value = localStorage.getItem(AP.INTERVAL) || String(AP.DEFAULT_INTERVAL);
    intervalInput.addEventListener('input', () => {
      localStorage.setItem(AP.INTERVAL, intervalInput.value);
      scheduleAutoPricer(panel);
    });

    // Toggle (persisted, default OFF)
    const enabledInput = panel.querySelector('#wfap-enabled');
    enabledInput.checked = localStorage.getItem(AP.ENABLED) === '1';
    enabledInput.addEventListener('change', () => {
      const enabled = enabledInput.checked;
      localStorage.setItem(AP.ENABLED, enabled ? '1' : '0');
      if (enabled) {
        scheduleAutoPricer(panel);
        // immediate scan if currently ingame
        (async () => {
          const status = await refreshAutoPricerStatus(panel);
          if (status === 'ingame') runAutoPricerScan(panel);
        })();
      } else {
        cancelAutoPricerSchedule(panel);
        refreshAutoPricerStatus(panel);
      }
    });

    // Collapsed
    const collapseBtn = panel.querySelector('#wfap-collapse');
    if (localStorage.getItem(AP.COLLAPSED) === '1') {
      panel.classList.add('collapsed');
      collapseBtn.textContent = '+';
    }
    collapseBtn.addEventListener('click', () => {
      const collapsed = panel.classList.toggle('collapsed');
      collapseBtn.textContent = collapsed ? '+' : '−';
      localStorage.setItem(AP.COLLAPSED, collapsed ? '1' : '0');
    });

    // Manual Run Now: works regardless of toggle state
    panel.querySelector('#wfap-run').addEventListener('click', () => runAutoPricerScan(panel));

    // Cached-profile footer: shows whose listings the panel is targeting and lets
    // the user reset the cache (re-prompts on the next profile-page load).
    const footer = panel.querySelector('#wfap-profile-footer');
    const cached = getCachedMySlug();
    footer.innerHTML = `Profile: <b>${escapeHtml(cached)}</b> · <a href="#" id="wfap-change-profile">change</a>`;
    panel.querySelector('#wfap-change-profile').addEventListener('click', (e) => {
      e.preventDefault();
      if (confirm('Clear cached profile? You will be asked for a profile URL on the next profile page load.')) {
        localStorage.removeItem(AP.MY_SLUG);
        location.reload();
      }
    });

    makeDraggable(panel, panel.querySelector('.wfaap-header'));
  }

  // Shown on profile pages when no profile slug is cached yet. The user pastes
  // their own warframe.market profile URL; we extract the slug and cache it.
  // On the next profile page load, the auto-pricer only injects when the URL
  // slug matches the cached one.
  function injectClaimProfilePrompt(urlSlug) {
    if (document.getElementById('wfap-claim')) return;
    const panel = document.createElement('div');
    panel.id = 'wfap-claim';
    panel.className = 'wfaap-panel';
    panel.innerHTML = `
      <div class="wfaap-header">
        <span>Dynamic Price Automator setup</span>
        <button class="wfaap-btn-icon" id="wfap-claim-close" title="Dismiss">×</button>
      </div>
      <div class="wfaap-body">
        <div class="wfaap-claim-blurb">
          Paste <b>your own</b> warframe.market profile URL to enable Dynamic Price Automator.
          The panel will only inject on that exact profile from now on.
        </div>
        <input id="wfap-claim-input" class="wfaap-claim-input" type="text"
               placeholder="https://warframe.market/profile/your_slug"
               value="${escapeHtml(urlSlug ? `https://warframe.market/profile/${urlSlug}` : '')}">
        <button class="wfaap-run" id="wfap-claim-save">Save profile</button>
        <div class="wfaap-status" id="wfap-claim-status"></div>
      </div>
    `;
    document.body.appendChild(panel);

    panel.querySelector('#wfap-claim-close').addEventListener('click', () => panel.remove());

    const input = panel.querySelector('#wfap-claim-input');
    const statusEl = panel.querySelector('#wfap-claim-status');
    function save() {
      const value = input.value.trim();
      const m = value.match(/\/profile\/([^/?#]+)/);
      const slug = (m ? m[1] : value.replace(/^\/+|\/+$/g, '')).toLowerCase();
      if (!slug || /\s/.test(slug) || slug.length > 64) {
        statusEl.textContent = 'Invalid URL or slug.';
        return;
      }
      localStorage.setItem(AP.MY_SLUG, slug);
      statusEl.textContent = 'Saved. Reloading...';
      setTimeout(() => location.reload(), 500);
    }
    panel.querySelector('#wfap-claim-save').addEventListener('click', save);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });

    makeDraggable(panel, panel.querySelector('.wfaap-header'));
  }

  async function refreshAutoPricerStatus(panel) {
    const mySlug = getMySlug();
    const { status, source } = await detectMyStatus(mySlug);
    const enabled = localStorage.getItem(AP.ENABLED) === '1';
    const meta = panel.querySelector('#wfap-meta');
    if (meta) {
      let auto;
      if (!enabled) auto = 'auto-run off';
      else if (status === 'ingame') auto = 'auto-run on';
      else auto = 'auto-run paused';
      meta.innerHTML = `Status: <span class="${escapeHtml(status)}">${escapeHtml(status)}</span> · ${escapeHtml(auto)} <span style="color:#445">(via ${source})</span>`;
    }
    return status;
  }

  function cancelAutoPricerSchedule(panel) {
    if (panel._wfapTimer) clearInterval(panel._wfapTimer);
    if (panel._wfapTimeout) clearTimeout(panel._wfapTimeout);
    panel._wfapTimer = null;
    panel._wfapTimeout = null;
  }

  function scheduleAutoPricer(panel) {
    cancelAutoPricerSchedule(panel);
    if (localStorage.getItem(AP.ENABLED) !== '1') return; // disabled → no schedule

    const intervalMs = Math.max(30, parseInt(panel.querySelector('#wfap-interval').value, 10) || AP.DEFAULT_INTERVAL) * 1000;
    const lastScan = parseInt(localStorage.getItem(AP.LAST_SCAN) || '0', 10);
    const elapsed = Date.now() - lastScan;
    const initialDelay = lastScan > 0 ? Math.max(0, intervalMs - elapsed) : intervalMs;

    const tick = async () => {
      if (localStorage.getItem(AP.ENABLED) !== '1') return; // toggle flipped off mid-wait
      const status = await refreshAutoPricerStatus(panel);
      if (status === 'ingame') runAutoPricerScan(panel);
    };

    panel._wfapTimeout = setTimeout(() => {
      tick();
      panel._wfapTimer = setInterval(tick, intervalMs);
    }, initialDelay);
  }

  async function runAutoPricerScan(panel) {
    if (panel._wfapBusy) return;
    panel._wfapBusy = true;

    const status = panel.querySelector('#wfap-status');
    const results = panel.querySelector('#wfap-results');
    const runBtn = panel.querySelector('#wfap-run');
    const floor = parseFloat(panel.querySelector('#wfap-floor').value) || AP.DEFAULT_FLOOR;

    runBtn.disabled = true;
    results.innerHTML = '';
    status.textContent = 'Loading item catalog...';

    try {
      const mySlug = getMySlug();
      if (!mySlug) throw new Error('No profile slug in URL.');
      const { byId } = await getItemsMaps();
      status.textContent = 'Loading your listings...';
      const myOrders = await getMyOrders(mySlug);

      const sells = myOrders.filter(o => o.type === 'sell');
      const targets = sells.filter(o => {
        if (o.visible !== true) return false;
        if (o.rank !== 10) return false;
        const item = byId[o.itemId];
        if (!item) return false;
        return isModItem(item.tags || []);
      });
      const skipped = sells.length - targets.length;
      const recs = [];

      for (let i = 0; i < targets.length; i++) {
        const order = targets[i];
        const item = byId[order.itemId];
        const slug = item.slug;
        const itemName = item.i18n?.en?.name || slug;
        status.textContent = `Scanning ${i + 1}/${targets.length}: ${itemName}`;

        try {
          const orders = await getItemOrders(slug);
          const competitors = competingIngameSells(orders, mySlug, order.rank);
          const tier = classifyTier(itemName, item.tags || []);
          const endoCost = tier ? ENDO_COSTS[tier] : null;
          const currentRatio = endoCost ? (order.platinum / endoCost) * 1000 : null;

          if (competitors.length === 0) {
            recs.push({ name: itemName, kind: 'noop', ratio: currentRatio, unit: 'P/1k', detail: 'no ingame competitor: leave as is' });
          } else if (!endoCost) {
            recs.push({ name: itemName, kind: 'error', detail: `unknown tier "${tier}"` });
          } else {
            const pick = findOptimalPriceTier(competitors, endoCost, floor);
            if (!pick) {
              recs.push({
                name: itemName, kind: 'floor', ratio: currentRatio, unit: 'P/1k',
                detail: `every undercut tier (1–${competitors.length}) lands below floor ${floor.toFixed(1)} P/1k. Hold at ${order.platinum}p.`,
              });
            } else if (pick.newPrice === order.platinum) {
              recs.push({
                name: itemName, kind: 'noop', ratio: currentRatio, unit: 'P/1k',
                detail: `already at ${order.platinum}p: position ${pick.position}/${pick.totalCompetitors}`,
                position: pick.position,
                totalCompetitors: pick.totalCompetitors,
              });
            } else {
              recs.push({
                name: itemName, kind: 'move', ratio: pick.ratio, unit: 'P/1k',
                detail: `${order.platinum}p → ${pick.newPrice}p · position ${pick.position}/${pick.totalCompetitors}`,
                orderId: order.id,
                oldPrice: order.platinum,
                newPrice: pick.newPrice,
                position: pick.position,
                totalCompetitors: pick.totalCompetitors,
                patch: {
                  visible: order.visible,
                  platinum: pick.newPrice,
                  quantity: order.quantity,
                  rank: order.rank,
                },
              });
            }
          }
        } catch (err) {
          recs.push({ name: itemName, kind: 'error', detail: String(err.message || err) });
        }
        if (i < targets.length - 1) await sleep(PACE_MS);
      }

      // Sort: ascending position (best/cheapest leaderboard slot first),
      // then descending plat/1k endo for ties (more efficient one wins).
      // Recs without a position (no-competitor noop, floor, errors) sink to the bottom.
      recs.sort((a, b) => {
        const aPos = (a.position != null) ? a.position : Infinity;
        const bPos = (b.position != null) ? b.position : Infinity;
        if (aPos !== bPos) return aPos - bPos;
        const aRatio = (a.ratio != null) ? a.ratio : -Infinity;
        const bRatio = (b.ratio != null) ? b.ratio : -Infinity;
        return bRatio - aRatio;
      });

      panel._wfapAllRecs = recs;
      renderRecs(results, recs);

      // Auto-apply moves (iterates in the same sorted order)
      const moves = recs.filter(r => r.kind === 'move');
      let ok = 0, fail = 0;
      if (moves.length > 0) {
        for (let i = 0; i < moves.length; i++) {
          const m = moves[i];
          status.textContent = `Applying ${i + 1}/${moves.length}: ${m.name}...`;
          try {
            await patchOrder(m.orderId, m.patch);
            m.kind = 'applied';
            m.detail = `Applied: now ${m.newPrice}p (was ${m.oldPrice}p) · position ${m.position}/${m.totalCompetitors}`;
            ok++;
          } catch (err) {
            m.kind = 'error';
            m.detail = `Failed: ${err.message || err}`;
            fail++;
          }
          renderRecs(results, recs);
          if (i < moves.length - 1) await sleep(APPLY_PACE_MS);
        }
        status.textContent = `Scanned ${targets.length} (${skipped} skipped). ${ok} applied, ${fail} failed.`;
      } else {
        status.textContent = `Scanned ${targets.length} (${skipped} skipped). No price changes needed.`;
      }

      localStorage.setItem(AP.LAST_SCAN, String(Date.now()));

      // Refresh on any successful apply (warframe.market doesn't live-update list prices)
      if (ok > 0) {
        try {
          sessionStorage.setItem(AP.LAST_RUN, JSON.stringify({
            recs: recs, status: status.textContent,
          }));
        } catch (e) {}
        sessionStorage.setItem(AP.SKIP_INITIAL, '1');
        status.textContent += ` Refreshing page to show new prices...`;
        setTimeout(() => location.reload(), AP.POST_APPLY_REFRESH_MS);
      }
    } catch (err) {
      status.textContent = `Error: ${err.message || err}`;
    } finally {
      runBtn.disabled = false;
      panel._wfapBusy = false;
    }
  }

  async function initAutoPricer() {
    injectAutoPricerPanel();
    const panel = document.getElementById('wfap-panel');
    if (!panel) return;

    const skipInitial = sessionStorage.getItem(AP.SKIP_INITIAL) === '1';
    sessionStorage.removeItem(AP.SKIP_INITIAL);

    if (skipInitial) {
      try {
        const stashed = JSON.parse(sessionStorage.getItem(AP.LAST_RUN) || 'null');
        sessionStorage.removeItem(AP.LAST_RUN);
        if (stashed?.recs) {
          panel._wfapAllRecs = stashed.recs;
          renderRecs(panel.querySelector('#wfap-results'), stashed.recs);
          if (stashed.status) panel.querySelector('#wfap-status').textContent = stashed.status;
        }
      } catch (e) {}
    }

    const enabled = localStorage.getItem(AP.ENABLED) === '1';
    const status = await refreshAutoPricerStatus(panel);
    if (!skipInitial && enabled && status === 'ingame') {
      await runAutoPricerScan(panel);
    }
    if (enabled) scheduleAutoPricer(panel);
  }

  // ════════════════════════════════════════════════════════════
  // DUCANATOR 2.0 (Ducanator page)
  // ════════════════════════════════════════════════════════════
  // Background-tab note: setInterval/setTimeout keep running in hidden tabs
  // (Chrome throttles to 1s floor, irrelevant at our 300s/600s intervals).
  // The Auto-Pricer profile tab and the Ducanator tab are on separate pages
  // and use disjoint localStorage namespaces (wfaap-* vs wfbh-*), so two tabs
  // both out of focus run safely in parallel.
  const BH = {
    ENABLED: 'wfbh-enabled',
    INTERVAL: 'wfbh-interval',
    TOP_N: 'wfbh-top-n',
    TOP_M: 'wfbh-top-m',
    MIN_QTY: 'wfbh-min-qty',
    MIN_DPP: 'wfbh-min-dpp',
    FILTER: 'wfbh-filter',
    BLOCKLIST: 'wfbh-blocklist',
    LAST_SCAN: 'wfbh-last-scan',
    COLLAPSED: 'wfbh-collapsed',
    DEFAULT_INTERVAL: 600,
    DEFAULT_TOP_N: 30,
    DEFAULT_TOP_M: 10,
    DEFAULT_MIN_QTY: 1,
    DEFAULT_MIN_DPP: 0,
    DEFAULT_FILTER: 'all', // 'all' | 'parts' | 'sets'
  };

  // Blocklist helpers — flat array of lowercase seller slugs persisted to
  // localStorage. Used to drop bad-actor sellers from BH results.
  function getBlocklist() {
    try {
      const raw = JSON.parse(localStorage.getItem(BH.BLOCKLIST) || '[]');
      return Array.isArray(raw) ? raw : [];
    } catch {
      return [];
    }
  }
  function setBlocklist(arr) {
    localStorage.setItem(BH.BLOCKLIST, JSON.stringify(arr));
  }
  function addToBlocklist(slug) {
    const s = (slug || '').toLowerCase().trim();
    if (!s) return;
    const list = getBlocklist();
    if (!list.includes(s)) {
      list.push(s);
      setBlocklist(list);
    }
  }
  function removeFromBlocklist(slug) {
    const s = (slug || '').toLowerCase().trim();
    setBlocklist(getBlocklist().filter(x => x !== s));
  }

  // Click a column header (matched by partial wrapper class, e.g.
  // 'ducanator__dpp-sort') until the first two visible rows are in descending
  // order on the column's value (matched by partial cell class, e.g.
  // '__wa--' or 'per-platinum'). The page's sort-state class isn't reliable
  // (we've seen multiple columns simultaneously carrying `down--`), so we
  // verify by observable row order instead.
  async function ensureColumnSortedDescending(wrapperFragment, valueClassFragment, doc = document) {
    const extract = row => {
      const cell = row.querySelector(`[class*="${valueClassFragment}"]`);
      if (!cell) return null;
      const m = (cell.textContent || '').match(/[\d.]+/);
      return m ? parseFloat(m[0]) : null;
    };
    // Take the two rendered rows with the LOWEST data-item-index currently in the
    // DOM (virtuoso only mounts a window — `data-item-index="0"` may not exist if
    // the user has scrolled mid-list). Consecutive indices in the data array still
    // make the desc-vs-asc comparison valid.
    const headOf = () => {
      const rows = [...doc.querySelectorAll('[data-item-index]')];
      if (rows.length < 2) return [null, null];
      rows.sort((a, b) =>
        parseInt(a.getAttribute('data-item-index') || '0', 10) -
        parseInt(b.getAttribute('data-item-index') || '0', 10)
      );
      return [extract(rows[0]), extract(rows[1])];
    };

    for (let attempt = 0; attempt < 3; attempt++) {
      const [v0, v1] = headOf();
      if (v0 == null || v1 == null) return false;
      if (v0 >= v1) return true; // already descending

      const wrapper = doc.querySelector(`[class*="${wrapperFragment}"]`);
      const button = wrapper?.querySelector('[role="button"]');
      if (!button) return false;
      button.click();
      await new Promise(r => setTimeout(r, 300));
    }
    return false;
  }

  // Scrape the Ducanator table: { slug, name, ducats, waPrice }
  // The page uses react-virtuoso for virtualized scrolling, so only ~17 rows are
  // mounted at any given time. We scroll the window in steps and dedupe by slug
  // until we have topN unique items (or stop making progress). Scroll position
  // is restored at the end. Assumes the table is sorted by DPP descending — the
  // caller (`runBargainHunterScan`) ensures that via `ensureColumnSortedDescending`.
  async function scrapeDucanatorRows(topN, doc = document) {
    const win = doc.defaultView || window;
    const scroller = doc.querySelector('[data-virtuoso-scroller="true"]');

    const seen = new Map();
    function scrapeVisible() {
      const rows = doc.querySelectorAll('[data-item-index]');
      rows.forEach(row => {
        const link = row.querySelector('a[href*="/items/"]');
        if (!link) return;
        const m = (link.getAttribute('href') || '').match(/\/items\/([^/?#]+)/);
        if (!m) return;
        const slug = m[1];
        if (seen.has(slug)) return;

        const nameEl = link.querySelector('[class*="itemName-text"], [class*="itemName"]') || link;
        const name = (nameEl.textContent || '').trim();

        // Ducats: prefer a cell whose class includes "__ducats" and is purely numeric.
        let ducats = null;
        const ducatCell = [...row.querySelectorAll('[class*="__ducats"]')]
          .find(el => el !== row && /^\s*\d+\s*$/.test(el.textContent || ''));
        if (ducatCell) {
          const dm = ducatCell.textContent.match(/\d+/);
          if (dm) ducats = parseInt(dm[0], 10);
        }
        // Fallback: known prime-part ducat denominations in the row text.
        if (!ducats) {
          const txt = row.textContent || '';
          const dm = txt.match(/\b(100|65|45|25|15)\b/);
          if (dm) ducats = parseInt(dm[1], 10);
        }
        if (!ducats) return;

        // WA price: the page's WA cell is `ducats__wa--<hash>` containing
        // <b>X.YY</b> + a platinum-icon svg. Match by class hint, then fall back
        // to deriving from the displayed ducats-per-plat ratio (WA = ducats/ratio),
        // then to the legacy "Xp" pattern.
        let waPrice = null;
        const waCell = [...row.querySelectorAll('[class*="__wa--"], [class*="waPrice"], [class*="WaPrice"], [class*="weighted"]')]
          .find(el => /\d/.test(el.textContent || ''));
        if (waCell) {
          const m = waCell.textContent.match(/[\d.]+/);
          if (m) waPrice = parseFloat(m[0]);
        }
        if (waPrice == null && ducats) {
          const ratioCell = [...row.querySelectorAll('[class*="per-platinum"], [class*="perPlat"], [class*="ducatsPerPlat"], [class*="dpp"], [class*="ratio"]')]
            .find(el => /^\s*\d+(?:\.\d+)?\s*$/.test(el.textContent || ''));
          if (ratioCell) {
            const m = ratioCell.textContent.match(/[\d.]+/);
            if (m) {
              const ratio = parseFloat(m[0]);
              if (ratio > 0) waPrice = ducats / ratio;
            }
          }
        }
        if (waPrice == null) {
          const wpm = (row.textContent || '').match(/(\d+(?:\.\d+)?)\s*p\b/);
          if (wpm) waPrice = parseFloat(wpm[1]);
        }

        seen.set(slug, { slug, name, ducats, waPrice });
      });
    }

    const startScrollY = win.scrollY;
    const startScrollerTop = scroller ? scroller.scrollTop : 0;

    scrapeVisible();

    if (scroller && seen.size < topN) {
      const viewport = scroller.querySelector('[data-viewport-type]');
      const useWindow = !viewport || viewport.getAttribute('data-viewport-type') === 'window';

      let stableCount = 0;
      let lastSize = seen.size;
      const MAX_ITERS = Math.max(30, topN * 2);
      for (let i = 0; i < MAX_ITERS && seen.size < topN; i++) {
        if (useWindow) {
          win.scrollBy(0, 600);
        } else {
          scroller.scrollTop += 600;
        }
        await new Promise(r => setTimeout(r, 200));
        scrapeVisible();
        if (seen.size === lastSize) {
          stableCount++;
          if (stableCount >= 4) break;
        } else {
          stableCount = 0;
        }
        lastSize = seen.size;
      }
    }

    // Restore scroll so the user doesn't see the page jump after a scan.
    if (scroller) scroller.scrollTop = startScrollerTop;
    win.scrollTo(0, startScrollY);

    return [...seen.values()].slice(0, topN);
  }

  function injectBargainHunterPanel() {
    if (document.getElementById('wfbh-panel')) return;
    const panel = document.createElement('div');
    panel.id = 'wfbh-panel';
    panel.className = 'wfaap-panel';
    panel.innerHTML = `
      <div class="wfaap-header">
        <span>Ducanator 2.0</span>
        <div class="wfaap-header-controls">
          <label class="wfaap-toggle" title="Enable auto-runs"><input type="checkbox" id="wfbh-enabled"><span class="wfaap-toggle-track"></span></label>
          <button class="wfaap-btn-icon" id="wfbh-collapse" title="Collapse">−</button>
        </div>
      </div>
      <div class="wfaap-body">
        <div class="wfaap-row-label"><span>Top-N source rows</span>
          <input id="wfbh-top-n" type="number" step="1" min="1"></div>
        <div class="wfaap-row-label"><span>Top-M results to show</span>
          <input id="wfbh-top-m" type="number" step="1" min="1"></div>
        <div class="wfaap-row-label"><span>Min ducats/plat</span>
          <input id="wfbh-min-dpp" type="number" step="0.1" min="0"></div>
        <div class="wfaap-row-label"><span id="wfbh-min-qty-label">Min listing quantity</span>
          <input id="wfbh-min-qty" type="number" step="1" min="1"></div>
        <div class="wfaap-row-label"><span>Auto-run interval (sec)</span>
          <input id="wfbh-interval" type="number" step="1" min="60"></div>
        <div class="wfaap-row-label"><span>Filter</span>
          <select id="wfbh-filter" title="All: parts and sets. Parts: sets excluded. Sets: only set listings.">
            <option value="all">All</option>
            <option value="parts">Parts only</option>
            <option value="sets">Sets only</option>
          </select>
        </div>
        <button class="wfaap-run" id="wfbh-run">Run Now</button>
        <div class="wfaap-meta" id="wfbh-meta">Auto-run off</div>
        <div class="wfaap-status" id="wfbh-status">Idle.</div>
        <div class="wfaap-results" id="wfbh-results"></div>
        <details class="wfaap-blocklist-details" id="wfbh-blocklist-section">
          <summary>Blocklist (<span id="wfbh-blocklist-count">0</span>)</summary>
          <div id="wfbh-blocklist-body" class="wfaap-blocklist-body"></div>
        </details>
      </div>
    `;
    document.body.appendChild(panel);

    const topNInput = panel.querySelector('#wfbh-top-n');
    topNInput.value = localStorage.getItem(BH.TOP_N) || String(BH.DEFAULT_TOP_N);
    topNInput.addEventListener('input', () => localStorage.setItem(BH.TOP_N, topNInput.value));

    const topMInput = panel.querySelector('#wfbh-top-m');
    topMInput.value = localStorage.getItem(BH.TOP_M) || String(BH.DEFAULT_TOP_M);
    topMInput.addEventListener('input', () => localStorage.setItem(BH.TOP_M, topMInput.value));

    const minQtyInput = panel.querySelector('#wfbh-min-qty');
    minQtyInput.value = localStorage.getItem(BH.MIN_QTY) || String(BH.DEFAULT_MIN_QTY);
    minQtyInput.addEventListener('input', () => localStorage.setItem(BH.MIN_QTY, minQtyInput.value));

    const minDppInput = panel.querySelector('#wfbh-min-dpp');
    minDppInput.value = localStorage.getItem(BH.MIN_DPP) || String(BH.DEFAULT_MIN_DPP);
    minDppInput.addEventListener('input', () => localStorage.setItem(BH.MIN_DPP, minDppInput.value));

    const filterInput = panel.querySelector('#wfbh-filter');
    const minQtyLabelEl = panel.querySelector('#wfbh-min-qty-label');
    // Min listing quantity only applies to parts when the filter is set to "all"
    // (sets are exempt). Reflect that in the label so the user knows.
    function updateMinQtyLabel() {
      const f = filterInput.value || BH.DEFAULT_FILTER;
      minQtyLabelEl.textContent = f === 'all' ? 'Min listing quantity (items)' : 'Min listing quantity';
    }
    filterInput.value = localStorage.getItem(BH.FILTER) || BH.DEFAULT_FILTER;
    updateMinQtyLabel();
    filterInput.addEventListener('change', () => {
      localStorage.setItem(BH.FILTER, filterInput.value);
      updateMinQtyLabel();
    });

    const intervalInput = panel.querySelector('#wfbh-interval');
    intervalInput.value = localStorage.getItem(BH.INTERVAL) || String(BH.DEFAULT_INTERVAL);
    intervalInput.addEventListener('input', () => {
      localStorage.setItem(BH.INTERVAL, intervalInput.value);
      scheduleBargainHunter(panel);
    });

    const enabledInput = panel.querySelector('#wfbh-enabled');
    enabledInput.checked = localStorage.getItem(BH.ENABLED) === '1';
    enabledInput.addEventListener('change', () => {
      const enabled = enabledInput.checked;
      localStorage.setItem(BH.ENABLED, enabled ? '1' : '0');
      refreshBargainHunterMeta(panel);
      if (enabled) {
        scheduleBargainHunter(panel);
        runBargainHunterScan(panel);
      } else {
        cancelBargainHunterSchedule(panel);
      }
    });

    const collapseBtn = panel.querySelector('#wfbh-collapse');
    if (localStorage.getItem(BH.COLLAPSED) === '1') {
      panel.classList.add('collapsed');
      collapseBtn.textContent = '+';
    }
    collapseBtn.addEventListener('click', () => {
      const collapsed = panel.classList.toggle('collapsed');
      collapseBtn.textContent = collapsed ? '+' : '−';
      localStorage.setItem(BH.COLLAPSED, collapsed ? '1' : '0');
    });

    panel.querySelector('#wfbh-run').addEventListener('click', () => runBargainHunterScan(panel));

    // Delegated click handler on the results container — handles both the
    // [block] link (adds seller slug to blocklist + removes every row from the
    // same seller) and the [/w] link (copies a pre-formatted whisper message
    // to the clipboard).
    panel.querySelector('#wfbh-results').addEventListener('click', (e) => {
      const target = e.target;
      if (!target || !target.classList) return;

      if (target.classList.contains('wfaap-block-seller')) {
        e.preventDefault();
        const slug = target.dataset.slug;
        if (slug) {
          addToBlocklist(slug);
          const sel = `.wfaap-block-seller[data-slug="${CSS.escape(slug)}"]`;
          panel.querySelectorAll(sel).forEach(el => el.closest('.wfaap-rec')?.remove());
          updateBlocklistDisplay(panel);
        }
        return;
      }

      if (target.classList.contains('wfaap-copy-msg')) {
        e.preventDefault();
        const message = target.dataset.message || '';
        if (!message) return;
        const original = target.textContent;
        const flash = (label) => {
          target.textContent = label;
          target.classList.add('copied');
          setTimeout(() => {
            target.textContent = original;
            target.classList.remove('copied');
          }, 1200);
        };
        // Prefer the async clipboard API; fall back to a hidden textarea +
        // execCommand if it isn't available (e.g., older browsers, or when
        // the document hasn't been clicked yet — should be fine here since
        // this fires from a click event).
        const fallback = () => {
          const ta = document.createElement('textarea');
          ta.value = message;
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          let ok = false;
          try { ok = document.execCommand('copy'); } catch (_) {}
          document.body.removeChild(ta);
          flash(ok ? 'copied!' : 'copy failed');
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(message).then(
            () => flash('copied!'),
            () => fallback()
          );
        } else {
          fallback();
        }
      }
    });

    // Blocklist remove buttons: delegated click on the blocklist body.
    panel.querySelector('#wfbh-blocklist-body').addEventListener('click', (e) => {
      const target = e.target;
      if (target && target.classList && target.classList.contains('wfaap-blocklist-remove')) {
        const slug = target.dataset.slug;
        if (slug) {
          removeFromBlocklist(slug);
          updateBlocklistDisplay(panel);
        }
      }
    });

    updateBlocklistDisplay(panel);
    makeDraggable(panel, panel.querySelector('.wfaap-header'));
  }

  // Render the blocklist entries (with remove buttons) and update the count
  // shown next to the <details> summary.
  function updateBlocklistDisplay(panel) {
    const list = getBlocklist();
    const countEl = panel.querySelector('#wfbh-blocklist-count');
    const bodyEl = panel.querySelector('#wfbh-blocklist-body');
    if (countEl) countEl.textContent = String(list.length);
    if (!bodyEl) return;
    if (list.length === 0) {
      bodyEl.innerHTML = '<div class="wfaap-blocklist-empty">Blocklist empty.</div>';
      return;
    }
    bodyEl.innerHTML = list.map(slug => `
      <div class="wfaap-blocklist-row">
        <a href="/profile/${encodeURIComponent(slug)}" target="_blank">${escapeHtml(slug)}</a>
        <button class="wfaap-blocklist-remove" data-slug="${escapeHtml(slug)}" title="Remove from blocklist">×</button>
      </div>
    `).join('');
  }

  // Ducanator 2.0 doesn't gate on online/ingame status — finding deals
  // works from any session, so the meta line just reflects the auto-run toggle.
  function refreshBargainHunterMeta(panel) {
    const enabled = localStorage.getItem(BH.ENABLED) === '1';
    const meta = panel.querySelector('#wfbh-meta');
    if (meta) meta.textContent = enabled ? 'Auto-run on' : 'Auto-run off';
  }

  function cancelBargainHunterSchedule(panel) {
    if (panel._wfbhTimer) clearInterval(panel._wfbhTimer);
    if (panel._wfbhTimeout) clearTimeout(panel._wfbhTimeout);
    panel._wfbhTimer = null;
    panel._wfbhTimeout = null;
  }

  function scheduleBargainHunter(panel) {
    cancelBargainHunterSchedule(panel);
    if (localStorage.getItem(BH.ENABLED) !== '1') return;

    const intervalMs = Math.max(60, parseInt(panel.querySelector('#wfbh-interval').value, 10) || BH.DEFAULT_INTERVAL) * 1000;
    const lastScan = parseInt(localStorage.getItem(BH.LAST_SCAN) || '0', 10);
    const elapsed = Date.now() - lastScan;
    const initialDelay = lastScan > 0 ? Math.max(0, intervalMs - elapsed) : intervalMs;

    const tick = () => {
      if (localStorage.getItem(BH.ENABLED) !== '1') return;
      runBargainHunterScan(panel);
    };

    panel._wfbhTimeout = setTimeout(() => {
      tick();
      panel._wfbhTimer = setInterval(tick, intervalMs);
    }, initialDelay);
  }

  async function runBargainHunterScan(panel) {
    if (panel._wfbhBusy) return;
    panel._wfbhBusy = true;

    const status = panel.querySelector('#wfbh-status');
    const results = panel.querySelector('#wfbh-results');
    const runBtn = panel.querySelector('#wfbh-run');

    runBtn.disabled = true;
    results.innerHTML = '';
    status.textContent = 'Reading Ducanator table...';

    try {
      const topN = Math.max(1, parseInt(panel.querySelector('#wfbh-top-n').value, 10) || BH.DEFAULT_TOP_N);
      const topM = Math.max(1, parseInt(panel.querySelector('#wfbh-top-m').value, 10) || BH.DEFAULT_TOP_M);
      const minQty = Math.max(1, parseInt(panel.querySelector('#wfbh-min-qty').value, 10) || BH.DEFAULT_MIN_QTY);
      const minDpp = Math.max(0, parseFloat(panel.querySelector('#wfbh-min-dpp').value) || BH.DEFAULT_MIN_DPP);
      const filter = panel.querySelector('#wfbh-filter').value || BH.DEFAULT_FILTER;

      // Auto-sort the page by Ducats/Plat descending so the scrape actually
      // pulls the top-N best ratios regardless of how the user last sorted it.
      await ensureColumnSortedDescending('ducanator__dpp-sort', 'per-platinum');

      const scraped = await scrapeDucanatorRows(topN, document);
      if (scraped.length === 0) {
        status.textContent = 'Could not parse Ducanator table — no rows scraped. Is the page fully loaded?';
        return;
      }

      // Sets vs parts: warframe.market set slugs end in `_set`.
      // 'all' = no filter, 'parts' = sets excluded, 'sets' = sets only.
      const isSetSlug = s => /_set$/i.test(s || '');
      const items =
        filter === 'sets' ? scraped.filter(it => isSetSlug(it.slug)) :
        filter === 'parts' ? scraped.filter(it => !isSetSlug(it.slug)) :
        scraped;
      const filterNoun = filter === 'sets' ? 'sets' : filter === 'parts' ? 'parts' : 'items';
      if (items.length === 0) {
        status.textContent =
          filter === 'sets' ? `Scraped ${scraped.length} rows but none were sets. Try increasing Top-N or switch the Filter to All.` :
          filter === 'parts' ? `Scraped ${scraped.length} rows but all were sets. Switch the Filter to Sets-only or All.` :
          'No items scraped — page may not be fully loaded.';
        return;
      }

      status.textContent = `Scraped ${scraped.length} rows · ${items.length} ${filterNoun}. Fetching live ingame listings...`;
      const mySlug = (getMySlug() || '').toLowerCase();
      const blocklist = getBlocklist();
      const enriched = [];

      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        status.textContent = `Checking ${i + 1}/${items.length}: ${it.name}`;
        // When filter='all', sets are exempt from the min-qty floor (sets are
        // typically listed as singletons, so the floor would filter most out).
        // When filter='parts' or 'sets', everything is the same kind, so the
        // floor applies uniformly.
        const exemptFromMinQty = filter === 'all' && isSetSlug(it.slug);
        try {
          const orders = await getItemOrders(it.slug);
          // If the cheapest seller is blocklisted, walk down the price ladder
          // until a non-blocklisted seller is found (or the list runs out).
          const cheapestIngameSell = orders
            .filter(o => o.type === 'sell')
            .filter(o => o.user?.status === 'ingame')
            .filter(o => (o.user?.slug || '').toLowerCase() !== mySlug)
            .filter(o => !blocklist.includes((o.user?.slug || '').toLowerCase()))
            .filter(o => o.platinum > 0)
            .filter(o => exemptFromMinQty || (o.quantity || 0) >= minQty)
            .sort((a, b) => a.platinum - b.platinum)[0] || null;

          if (!cheapestIngameSell) {
            enriched.push({ ...it, ingamePrice: null, dpp: 0, sellerName: null });
          } else {
            const dpp = it.ducats / cheapestIngameSell.platinum;
            enriched.push({
              ...it,
              ingamePrice: cheapestIngameSell.platinum,
              quantity: cheapestIngameSell.quantity,
              dpp,
              sellerName: cheapestIngameSell.user.ingameName || cheapestIngameSell.user.slug || '',
              sellerSlug: (cheapestIngameSell.user.slug || '').toLowerCase(),
            });
          }
        } catch (err) {
          enriched.push({ ...it, ingamePrice: null, dpp: 0, error: String(err.message || err) });
        }
        if (i < items.length - 1) await sleep(PACE_MS);
      }

      // Sort by real ducats/plat descending, then apply two cutoffs:
      //   (a) min ducats/plat threshold (drops anything below)
      //   (b) top M slice (caps the count)
      // Whichever cuts the list shorter wins.
      const dealable = enriched.filter(e => e.ingamePrice != null);
      dealable.sort((a, b) => b.dpp - a.dpp);
      const aboveMin = minDpp > 0 ? dealable.filter(e => e.dpp >= minDpp) : dealable;
      const topResults = aboveMin.slice(0, topM);

      const recs = topResults.map(e => {
        const whisper = `/w ${e.sellerName} Hi! I want to buy: "${e.name}" for ${e.ingamePrice} platinum. (warframe.market)`;
        return {
          name: e.name,
          kind: 'deal',
          ratio: e.dpp,
          unit: 'D/p',
          detail: `${e.ingamePrice}p × ${e.quantity} ingame (seller <a href="/profile/${encodeURIComponent(e.sellerSlug || e.sellerName)}" target="_blank">${escapeHtml(e.sellerName)}</a> <a href="#" class="wfaap-block-seller" data-slug="${escapeHtml(e.sellerSlug || '')}" title="Add seller to blocklist">[block]</a> <a href="#" class="wfaap-copy-msg" data-message="${escapeHtml(whisper)}" title="Copy whisper message to clipboard">[/w]</a>) · ${e.ducats} ducats · WA ${e.waPrice != null ? e.waPrice.toFixed(2) + 'p' : '?'} · <a href="/items/${encodeURIComponent(e.slug)}" target="_blank">view item</a>`,
        };
      });

      renderRecs(results, recs);
      const noIngame = items.length - dealable.length;
      const belowMin = dealable.length - aboveMin.length;
      const cutoffParts = [`${noIngame} had no qualifying ingame seller`];
      if (belowMin > 0) cutoffParts.push(`${belowMin} below min ${minDpp} D/p`);
      status.textContent = `Scanned ${items.length} ${filterNoun} from ${scraped.length} rows. Top ${topResults.length} deals shown (${cutoffParts.join('; ')}).`;
      localStorage.setItem(BH.LAST_SCAN, String(Date.now()));
    } catch (err) {
      status.textContent = `Error: ${err.message || err}`;
    } finally {
      runBtn.disabled = false;
      panel._wfbhBusy = false;
    }
  }

  async function initBargainHunter() {
    injectBargainHunterPanel();
    const panel = document.getElementById('wfbh-panel');
    if (!panel) return;

    refreshBargainHunterMeta(panel);
    if (localStorage.getItem(BH.ENABLED) === '1') {
      await runBargainHunterScan(panel);
      scheduleBargainHunter(panel);
    }
  }

  // ════════════════════════════════════════════════════════════
  // INIT DISPATCH
  // ════════════════════════════════════════════════════════════
  async function init() {
    injectSharedCss();

    // Dynamic Price Automator: only on the cached profile URL. The user
    // claims their profile once via injectClaimProfilePrompt; from then on
    // we only inject the panel when the URL slug matches the cached slug.
    if (isProfilePage()) {
      const cached = getCachedMySlug();
      const urlSlug = getUrlProfileSlug();
      if (!cached) {
        injectClaimProfilePrompt(urlSlug);
      } else if (cached === urlSlug) {
        initAutoPricer();
      }
      return;
    }

    // Ducanator 2.0: only on the Ducanator page itself.
    if (isDucanatorPage()) {
      initBargainHunter();
    }
  }

  if (document.body) init();
  else document.addEventListener('DOMContentLoaded', init);
})();
