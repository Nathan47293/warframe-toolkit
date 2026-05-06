// background.js — service worker for the Warframe Toolkit chrome extension.
//
// Two responsibilities:
//
//  1. Ducanator scan scheduler & runner. The scan logic lives here (not in
//     content.js) so it runs on chrome.alarms — which keep firing on time
//     even when no Ducanator tab is in focus or the page is throttled by
//     Chrome's intensive-throttling/freezing for hidden tabs.
//
//     Settings, source cache, parts cache, blocklist, and tier list live in
//     chrome.storage.local; the content script mirrors UI changes there on
//     every input event. Results are pushed back to all open Ducanator tabs
//     via chrome.tabs.query (allowed by warframe.market host_permissions, no
//     tabs perm needed) + sendMessage.
//
//  2. Notifications. When a scan turns up at least one fresh deal, we fire a
//     chrome.notifications toast directly from here. On click, we focus any
//     open Ducanator tab (or open one if none) and round-trip the whisper
//     text to the content script for clipboard write. Clipboard writes need
//     a document context, which the SW doesn't have.
//
// MV3 service workers shut down after ~30s idle and wake on events. The
// alarm itself survives SW restarts, click->action mappings persist in
// chrome.storage.session, so scheduled scans keep firing through wake/sleep
// cycles and notification clicks still resolve correctly after a wake.

const SESSION_KEY_PREFIX = 'wfap-notif-action:';
const PENDING_WHISPER_KEY = 'wfbh-pending-whisper';
const ALARM_NAME = 'wfbh-scan';
const PACE_MS = 350;
const DUCANATOR_URL = 'https://warframe.market/tools/ducats';
const DUCANATOR_URL_PATTERN = 'https://warframe.market/tools/ducats*';

// Cross-namespace key: mirrored by content.js from the user's Dynamic
// Price Automator profile claim. Used to filter the user's own ingame
// listings out of scan results (no self-trades).
const MY_SLUG_KEY = 'wfaap-my-slug';

// ─── Storage keys (mirror content.js BH namespace) ───
const BH = {
  ENABLED: 'wfbh-enabled',
  INTERVAL: 'wfbh-interval',
  TOP_M: 'wfbh-top-m',
  MIN_DPP: 'wfbh-min-dpp',
  MIN_DPT: 'wfbh-min-dpt',
  MIN_TOTAL_D: 'wfbh-min-total-d',
  MIN_CACHE_DPP: 'wfbh-min-cache-dpp',
  TIERED_FLOOR: 'wfbh-tiered-floor',
  DUCATS_ALLOWED: 'wfbh-ducats-allowed',
  BLOCKLIST: 'wfbh-blocklist',
  SOURCE_CACHE: 'wfbh-source-cache',
  PARTS_CACHE: 'wfbh-parts-cache',
  NOTIFY_ENABLED: 'wfbh-notify-enabled',
  NOTIFIED_DEALS: 'wfbh-notified-deals',
  MIN_TRADE_EFF: 'wfbh-min-trade-eff',
  SORT_BY: 'wfbh-sort-by',
  SECONDARY_SORT_BY: 'wfbh-secondary-sort-by',
  LAST_SCAN: 'wfbh-last-scan',
  // Defaults
  DEFAULT_INTERVAL: 600,
  DEFAULT_TOP_M: 10,
  DEFAULT_MIN_TRADE_EFF: 1,
  DEFAULT_SORT_BY: 'dpp',
  DEFAULT_SECONDARY_SORT_BY: 'none',
  DEFAULT_NOTIFY_ENABLED: true,
  DEFAULT_DUCATS_ALLOWED: '15,25,45,65,100',
  DEFAULT_MIN_DPP: 0,
  DEFAULT_MIN_DPT: 0,
  DEFAULT_MIN_TOTAL_D: 0,
  DEFAULT_MIN_CACHE_DPP: 0,
  DUCAT_DENOMS: [15, 25, 45, 65, 100],
  TRADE_CAP: 6,
  NOTIFY_PRUNE_MS: 60 * 60 * 1000,
};

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── API ───
// Crossplay: true tells warframe.market to include cross-platform sellers
// (Xbox, PS, mobile) who have crossplay enabled. credentials: 'include'
// sends the user's warframe.market session cookie so we get full ingame
// data without bot-challenges. host_permissions in manifest authorises
// these cross-origin fetches from the SW context.
async function api(path) {
  const resp = await fetch(`https://api.warframe.market${path}`, {
    headers: { 'Language': 'en', 'Platform': 'pc', 'Crossplay': 'true' },
    credentials: 'include',
  });
  if (!resp.ok) throw new Error(`${path} -> HTTP ${resp.status}`);
  return resp.json();
}

async function getItemOrders(slug) {
  const data = await api(`/v2/orders/item/${encodeURIComponent(slug)}`);
  return data.data || [];
}

// ─── Trade math (kept in lockstep with content.js scan-time semantics) ───
//
// findOptimalK: largest K (units to buy, <= qty) packing into trades that
// meet BOTH per-trade floors:
//   - items per trade >= effFloor (partial trade can't be too small)
//   - ducats per trade >= minDpt (each trade must clear the ducats floor)
// Returns 0 if nothing satisfies both.
function findOptimalK(qty, partsPerUnit, effFloor, ducatsPerUnit, minDpt) {
  const cap = BH.TRADE_CAP;
  const fullTradeDucats = (cap / partsPerUnit) * ducatsPerUnit;
  if (fullTradeDucats < minDpt) return 0;
  for (let K = qty; K >= 1; K--) {
    const parts = K * partsPerUnit;
    const rem = parts % cap;
    if (rem !== 0 && rem < effFloor) continue;
    if (rem > 0) {
      const partialDucats = (rem / partsPerUnit) * ducatsPerUnit;
      if (partialDucats < minDpt) continue;
    }
    return K;
  }
  return 0;
}

function computeTradeBreakdown(K, partsPerUnit, ducatsPerUnit) {
  const cap = BH.TRADE_CAP;
  const parts = K * partsPerUnit;
  const fullTrades = Math.floor(parts / cap);
  const lastRem = parts % cap;
  const totalTrades = fullTrades + (lastRem > 0 ? 1 : 0);
  const totalDucats = K * ducatsPerUnit;
  const dPerTrade = totalTrades > 0 ? Math.floor(totalDucats / totalTrades) : 0;
  return { totalTrades, fullTrades, lastRem, totalDucats, dPerTrade };
}

function formatTradeBreakdown(b) {
  if (b.totalTrades === 1) {
    const eff = b.lastRem > 0 ? `${b.lastRem}/${BH.TRADE_CAP}` : `${BH.TRADE_CAP}/${BH.TRADE_CAP}`;
    return `1 trade · ${eff}`;
  }
  if (b.lastRem === 0) {
    return `${b.totalTrades} trades · ${BH.TRADE_CAP}/${BH.TRADE_CAP}`;
  }
  return `${b.totalTrades} trades · ${BH.TRADE_CAP}/${BH.TRADE_CAP}, ${b.lastRem}/${BH.TRADE_CAP} last`;
}

function tieredFloorFor(dPerTrade, tiersDesc, baseFloor) {
  for (const t of tiersDesc) {
    if (dPerTrade >= t.dtrade) return t.dpp;
  }
  return baseFloor;
}

// Build the "/w ..." copy-to-clipboard whisper text. Uses natural per-trade
// split when the per-trade plat is integer (always for items P=1; for sets
// only when P divides 6X and P divides lastRem*X). Otherwise averaged with
// the leftover front-loaded into the first trade so the seller gets the
// biggest predictable chunk upfront.
function formatWhisper(e) {
  const K = e.boughtK;
  const X = e.ingamePrice;
  const P = e.partsPerUnit;
  const total = K * X;
  const totalParts = K * P;
  const fullTrades = Math.floor(totalParts / BH.TRADE_CAP);
  const lastRem = totalParts % BH.TRADE_CAP;
  const totalTrades = fullTrades + (lastRem > 0 ? 1 : 0);
  if (K === 1) {
    return `/w ${e.sellerName} Hi! I want to buy: "${e.name}" for ${X} platinum. (warframe.market)`;
  }
  if (totalTrades > 1) {
    const naturalFullPlat = (BH.TRADE_CAP / P) * X;
    const naturalLastPlat = lastRem > 0 ? (lastRem / P) * X : 0;
    const naturalClean = Number.isInteger(naturalFullPlat)
      && (lastRem === 0 || Number.isInteger(naturalLastPlat));
    let breakdown;
    if (naturalClean) {
      if (lastRem === 0) {
        breakdown = `${naturalFullPlat}p per trade for ${fullTrades} trades`;
      } else if (fullTrades > 0) {
        const fullPart = fullTrades === 1 ? 'first trade' : `first ${fullTrades} trades`;
        breakdown = `${naturalFullPlat}p for the ${fullPart} and then ${naturalLastPlat}p for the last trade`;
      } else {
        breakdown = `${naturalLastPlat}p for the trade`;
      }
    } else {
      const baseRate = Math.floor(total / totalTrades);
      const firstTrade = total - (totalTrades - 1) * baseRate;
      if (firstTrade === baseRate) {
        breakdown = `${baseRate}p per trade for ${totalTrades} trades`;
      } else {
        const remaining = totalTrades - 1;
        const remPhrase = remaining === 1 ? 'next trade' : `next ${remaining} trades`;
        breakdown = `${firstTrade}p for the first trade and then ${baseRate}p for the ${remPhrase}`;
      }
    }
    return `/w ${e.sellerName} Hi! I want to buy: ${K} x "${e.name}" for ${X} platinum each, ${breakdown} (Total: ${total}p). (warframe.market)`;
  }
  return `/w ${e.sellerName} Hi! I want to buy: ${K} x "${e.name}" for ${X} platinum each (Total: ${total}p). (warframe.market)`;
}

// ─── Notification dedup (chrome.storage.local, SW-owned) ───
async function getNotifiedDeals() {
  const data = await chrome.storage.local.get(BH.NOTIFIED_DEALS);
  const raw = data[BH.NOTIFIED_DEALS];
  return (raw && typeof raw === 'object') ? raw : {};
}
async function setNotifiedDeals(map) {
  await chrome.storage.local.set({ [BH.NOTIFIED_DEALS]: map });
}
function pruneNotifiedDeals(map) {
  const cutoff = Date.now() - BH.NOTIFY_PRUNE_MS;
  const out = {};
  for (const [id, ts] of Object.entries(map)) {
    if (typeof ts === 'number' && ts >= cutoff) out[id] = ts;
  }
  return out;
}

// ─── Tier list parser ───
function parseTierList(raw) {
  try {
    const arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!Array.isArray(arr)) return [];
    return arr
      .filter(t => t && typeof t.dtrade === 'number' && typeof t.dpp === 'number'
        && t.dtrade > 0 && t.dpp >= 0);
  } catch {
    return [];
  }
}

// ─── Settings reader ───
// Pulls every BH key the scan needs from chrome.storage.local in one shot.
// Content script mirrors localStorage values here on every UI change so this
// is always current at scan time. Falls back to defaults for anything missing
// (fresh install or content script hasn't initialised yet).
async function readSettings() {
  const data = await chrome.storage.local.get([
    BH.ENABLED, BH.INTERVAL, BH.TOP_M, BH.MIN_DPP, BH.MIN_DPT, BH.MIN_TOTAL_D,
    BH.MIN_CACHE_DPP, BH.TIERED_FLOOR, BH.DUCATS_ALLOWED, BH.BLOCKLIST,
    BH.NOTIFY_ENABLED, BH.MIN_TRADE_EFF, BH.SORT_BY, BH.SECONDARY_SORT_BY,
    BH.SOURCE_CACHE, BH.PARTS_CACHE, MY_SLUG_KEY,
  ]);
  const parseFloatOr = (v, def) => {
    const n = parseFloat(v);
    return Number.isFinite(n) && n >= 0 ? n : def;
  };
  const parseIntOr = (v, def) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) && n >= 0 ? n : def;
  };
  const enabled = data[BH.ENABLED] === '1';
  const intervalSec = Math.max(60, parseIntOr(data[BH.INTERVAL], BH.DEFAULT_INTERVAL));
  const topM = Math.max(1, parseIntOr(data[BH.TOP_M], BH.DEFAULT_TOP_M));
  const minDpp = parseFloatOr(data[BH.MIN_DPP], BH.DEFAULT_MIN_DPP);
  const minDpt = parseIntOr(data[BH.MIN_DPT], BH.DEFAULT_MIN_DPT);
  const minTotalD = parseIntOr(data[BH.MIN_TOTAL_D], BH.DEFAULT_MIN_TOTAL_D);
  const minCacheDpp = parseFloatOr(data[BH.MIN_CACHE_DPP], BH.DEFAULT_MIN_CACHE_DPP);
  const minTradeEff = Math.max(1, Math.min(BH.TRADE_CAP,
    parseIntOr(data[BH.MIN_TRADE_EFF], BH.DEFAULT_MIN_TRADE_EFF)));
  const sortBy = ['dpp', 'dpt', 'total'].includes(data[BH.SORT_BY])
    ? data[BH.SORT_BY] : BH.DEFAULT_SORT_BY;
  const secondarySortBy = ['none', 'dpp', 'dpt', 'total'].includes(data[BH.SECONDARY_SORT_BY])
    ? data[BH.SECONDARY_SORT_BY] : BH.DEFAULT_SECONDARY_SORT_BY;
  const tiers = parseTierList(data[BH.TIERED_FLOOR]);
  const tiersDesc = tiers.filter(t => t.dtrade > 0).sort((a, b) => b.dtrade - a.dtrade);
  const ducatsAllowedRaw = data[BH.DUCATS_ALLOWED];
  const ducatsAllowedStr = ducatsAllowedRaw == null ? BH.DEFAULT_DUCATS_ALLOWED : String(ducatsAllowedRaw);
  const ducatsAllowed = new Set(ducatsAllowedStr.split(',').map(s => parseInt(s, 10)).filter(n => Number.isFinite(n)));
  const ducatsFilterActive = ducatsAllowed.size > 0 && ducatsAllowed.size < BH.DUCAT_DENOMS.length;
  const blocklistRaw = data[BH.BLOCKLIST];
  let blocklist = [];
  try {
    const arr = typeof blocklistRaw === 'string' ? JSON.parse(blocklistRaw) : blocklistRaw;
    if (Array.isArray(arr)) blocklist = arr.map(s => String(s).toLowerCase());
  } catch {}
  const notifyRaw = data[BH.NOTIFY_ENABLED];
  const notifyOn = notifyRaw == null ? BH.DEFAULT_NOTIFY_ENABLED : notifyRaw === '1';
  let sourceCache = null;
  try {
    const obj = typeof data[BH.SOURCE_CACHE] === 'string'
      ? JSON.parse(data[BH.SOURCE_CACHE]) : data[BH.SOURCE_CACHE];
    if (obj && Array.isArray(obj.items)) sourceCache = obj;
  } catch {}
  let partsCache = {};
  try {
    const obj = typeof data[BH.PARTS_CACHE] === 'string'
      ? JSON.parse(data[BH.PARTS_CACHE]) : data[BH.PARTS_CACHE];
    if (obj && obj.parts && typeof obj.parts === 'object') partsCache = obj.parts;
  } catch {}
  const mySlug = String(data[MY_SLUG_KEY] || '').toLowerCase();
  return {
    enabled, intervalSec, topM, minDpp, minDpt, minTotalD, minCacheDpp,
    minTradeEff, sortBy, secondarySortBy, tiersDesc, ducatsAllowed, ducatsFilterActive,
    blocklist, notifyOn, sourceCache, partsCache, mySlug,
  };
}

// ─── Tab discovery ───
// chrome.tabs.query with a URL pattern works without the 'tabs' permission
// because warframe.market is in our host_permissions.
async function findDucanatorTabs() {
  return await chrome.tabs.query({ url: DUCANATOR_URL_PATTERN });
}

async function broadcastToDucanatorTabs(message) {
  const tabs = await findDucanatorTabs();
  for (const tab of tabs) {
    try {
      chrome.tabs.sendMessage(tab.id, message, () => { void chrome.runtime.lastError; });
    } catch {
      // Tab may have unloaded; non-fatal.
    }
  }
}

// ─── Scan ───
let _scanInFlight = false;

async function runScan({ via }) {
  if (_scanInFlight) return { ok: false, error: 'scan already in flight' };
  _scanInFlight = true;
  const sendStatus = (text) => {
    broadcastToDucanatorTabs({ type: 'wfbh-scan-status', text });
  };

  try {
    sendStatus('Reading source cache...');
    const s = await readSettings();
    if (!s.sourceCache || s.sourceCache.items.length === 0) {
      const msg = 'No source cache. Click "Refresh" next to "Source cache" to build it (must be on the Ducanator tab).';
      broadcastToDucanatorTabs({ type: 'wfbh-scan-results', recs: [], statusText: msg, lastScanTs: Date.now() });
      return { ok: false, error: msg };
    }

    const isSetSlug = (slug) => /_set$/i.test(slug || '');
    const scraped = s.minCacheDpp > 0
      ? s.sourceCache.items.filter(it => it.dpp == null || it.dpp >= s.minCacheDpp)
      : s.sourceCache.items;
    const droppedByCacheDpp = s.sourceCache.items.length - scraped.length;
    const items = s.ducatsFilterActive
      ? scraped.filter(it => isSetSlug(it.slug) || s.ducatsAllowed.has(it.ducats))
      : scraped;
    const droppedByDucats = scraped.length - items.length;

    if (items.length === 0) {
      let msg;
      if (scraped.length === 0 && s.minCacheDpp > 0) {
        msg = `All ${s.sourceCache.items.length} cached rows are below ${s.minCacheDpp} D/p. Lower the Min D/p (page) input or refresh the source cache.`;
      } else {
        msg = s.ducatsFilterActive
          ? `Read ${scraped.length} cached rows but the Ducats(item) filter dropped them all. Adjust the denominations.`
          : 'No items in cache. Refresh the source cache.';
      }
      broadcastToDucanatorTabs({ type: 'wfbh-scan-results', recs: [], statusText: msg, lastScanTs: Date.now() });
      return { ok: false, error: msg };
    }

    const noteParts = [];
    if (droppedByCacheDpp > 0) noteParts.push(`${droppedByCacheDpp} below ${s.minCacheDpp} D/p (page)`);
    if (s.ducatsFilterActive) noteParts.push(`${droppedByDucats} dropped by Ducats(item)`);
    const ducatsNote = noteParts.length > 0 ? ` · ${noteParts.join(' · ')}` : '';
    sendStatus(`${items.length} cached rows${ducatsNote}. Fetching live listings...`);

    // Per-listing emission: every qualifying (item, seller) combination
    // becomes its own row. Sorted globally by sortBy desc (with optional
    // secondary tiebreaker, then totalDucats as the final tier so a
    // 13-qty listing beats a 3-qty one at the same rate). Top-M is sliced
    // from the global sort so the highest-rate deals always surface
    // regardless of which item they belong to.
    const enriched = [];
    let droppedByEff = 0;        // items where every candidate had K=0
    let droppedByMins = 0;       // items where K>0 sellers all failed min filters
    let itemsWithListings = 0;   // items that contributed at least one row
    let missingPartsData = 0;
    let fetchErrors = 0;

    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      sendStatus(`Checking ${i + 1}/${items.length}: ${it.name}`);
      const isSet = isSetSlug(it.slug);
      const partsPerUnit = isSet ? (s.partsCache[it.slug] || 0) : 1;
      if (isSet && partsPerUnit === 0) {
        // Set without cached parts data — silently skip; user can refresh
        // the source cache from the panel to backfill /v2/items/{slug}.
        missingPartsData++;
        continue;
      }
      try {
        const orders = await getItemOrders(it.slug);
        const candidates = orders
          .filter(o => o.type === 'sell')
          .filter(o => o.user?.status === 'ingame')
          .filter(o => !s.mySlug || (o.user?.slug || '').toLowerCase() !== s.mySlug)
          .filter(o => !s.blocklist.includes((o.user?.slug || '').toLowerCase()))
          .filter(o => o.platinum > 0)
          .sort((a, b) => a.platinum - b.platinum);

        const ducatsPerUnit = it.ducats;
        let candidatesWithK = 0, listingsForThisItem = 0;
        for (const c of candidates) {
          const K = findOptimalK(c.quantity || 0, partsPerUnit, s.minTradeEff, ducatsPerUnit, s.minDpt);
          if (K === 0) continue;
          candidatesWithK++;
          const breakdown = computeTradeBreakdown(K, partsPerUnit, ducatsPerUnit);
          const dpp = ducatsPerUnit / c.platinum;
          const effectiveDppFloor = tieredFloorFor(breakdown.dPerTrade, s.tiersDesc, s.minDpp);
          if (dpp < effectiveDppFloor) continue;
          if (breakdown.dPerTrade < s.minDpt) continue;
          if (breakdown.totalDucats < s.minTotalD) continue;
          enriched.push({
            ...it,
            ingamePrice: c.platinum,
            quantity: c.quantity,
            boughtK: K,
            partsPerUnit,
            isSet,
            dpp,
            dPerTrade: breakdown.dPerTrade,
            totalD: breakdown.totalDucats,
            totalTrades: breakdown.totalTrades,
            breakdownStr: formatTradeBreakdown(breakdown),
            sellerName: c.user.ingameName || c.user.slug || '',
            sellerSlug: (c.user.slug || '').toLowerCase(),
          });
          listingsForThisItem++;
        }
        if (listingsForThisItem > 0) itemsWithListings++;
        else if (candidates.length > 0 && candidatesWithK === 0) droppedByEff++;
        else if (candidatesWithK > 0) droppedByMins++;
      } catch (err) {
        fetchErrors++;
      }
      if (i < items.length - 1) await sleep(PACE_MS);
    }

    const keyFor = (k) => k === 'dpt' ? 'dPerTrade' : k === 'total' ? 'totalD' : k === 'dpp' ? 'dpp' : null;
    const sortKey = keyFor(s.sortBy) || 'dpp';
    const secondaryKey = keyFor(s.secondarySortBy);
    enriched.sort((a, b) => {
      const primaryDiff = (b[sortKey] || 0) - (a[sortKey] || 0);
      if (primaryDiff !== 0) return primaryDiff;
      if (secondaryKey) {
        const secondaryDiff = (b[secondaryKey] || 0) - (a[secondaryKey] || 0);
        if (secondaryDiff !== 0) return secondaryDiff;
      }
      // Final tiebreaker: bigger total ducats (= more units bought) wins.
      // Without this a 13-qty listing can lose to a 3-qty listing of the
      // same item at the same rate, just because of API response order.
      return (b.totalD || 0) - (a.totalD || 0);
    });
    const topResults = enriched.slice(0, s.topM);

    // Pre-format the whisper text per row so content.js can drop straight
    // into a data-message attribute without needing the formatter.
    const recs = topResults.map(e => ({
      slug: e.slug,
      name: e.name,
      ducats: e.ducats,
      isSet: e.isSet,
      ingamePrice: e.ingamePrice,
      quantity: e.quantity,
      boughtK: e.boughtK,
      partsPerUnit: e.partsPerUnit,
      dpp: e.dpp,
      dPerTrade: e.dPerTrade,
      totalD: e.totalD,
      totalTrades: e.totalTrades,
      breakdownStr: e.breakdownStr,
      sellerName: e.sellerName,
      sellerSlug: e.sellerSlug,
      whisperText: formatWhisper(e),
    }));

    // Per-arcane bucket counts for the status line, even though enriched
    // is now per-listing. noIngame = items with no qualifying seller at
    // all (including blocked/own listings filtered out).
    const noIngame = items.length - itemsWithListings - missingPartsData
                     - droppedByEff - droppedByMins - fetchErrors;
    const cutoffParts = [];
    if (noIngame > 0) cutoffParts.push(`${noIngame} no qualifying seller`);
    if (droppedByEff > 0) cutoffParts.push(`${droppedByEff} items dropped by ${s.minTradeEff}/${BH.TRADE_CAP} trade-eff`);
    if (missingPartsData > 0) cutoffParts.push(`${missingPartsData} sets missing parts data, refresh source cache`);
    if (droppedByMins > 0) {
      const minLabels = [];
      if (s.minDpp > 0) minLabels.push(`${s.minDpp} D/p`);
      if (s.tiersDesc.length > 0) minLabels.push(`tiered D/p (${s.tiersDesc.length})`);
      if (s.minDpt > 0) minLabels.push(`${s.minDpt} D/trade`);
      if (s.minTotalD > 0) minLabels.push(`${s.minTotalD} D total`);
      cutoffParts.push(minLabels.length > 0
        ? `${droppedByMins} items had no seller meeting min ${minLabels.join(' / ')}`
        : `${droppedByMins} items dropped`);
    }
    if (fetchErrors > 0) cutoffParts.push(`${fetchErrors} fetch errors`);
    const cutoffStr = cutoffParts.length > 0 ? ` (${cutoffParts.join('; ')})` : '';
    const totalListings = enriched.length;
    const statusText = `Scanned ${items.length} from ${scraped.length} cached, ${totalListings} listing${totalListings === 1 ? '' : 's'} pass; top ${topResults.length} shown${cutoffStr}.`;
    const lastScanTs = Date.now();
    await chrome.storage.local.set({ [BH.LAST_SCAN]: String(lastScanTs) });
    broadcastToDucanatorTabs({ type: 'wfbh-scan-results', recs, statusText, lastScanTs });

    // Notification dispatch — only fresh deals (not yet in dedup window).
    if (s.notifyOn && recs.length > 0) {
      const dealId = (e) => `${e.slug}:${(e.sellerSlug || e.sellerName || '').toLowerCase()}`;
      const notified = pruneNotifiedDeals(await getNotifiedDeals());
      const fresh = recs.filter(e => !(dealId(e) in notified));
      if (fresh.length > 0) {
        const now = Date.now();
        for (const e of recs) notified[dealId(e)] = now;
        await setNotifiedDeals(notified);

        const top = recs[0];
        const title = `Ducanator: ${recs.length} deal${recs.length === 1 ? '' : 's'} · top ${top.dpp.toFixed(2)} D/p`;
        const body = `${top.name} · ${top.dPerTrade}D/trade · ${top.totalD}D total`;
        const whisperText = `/w ${top.sellerName} Hi! I want to buy: "${top.name}" for ${top.ingamePrice} platinum. (warframe.market)`;
        await fireNotification({ title, body, whisperText });
      }
    }

    return { ok: true };
  } catch (err) {
    const msg = `Error: ${err.message || err}`;
    broadcastToDucanatorTabs({ type: 'wfbh-scan-error', error: msg });
    return { ok: false, error: msg };
  } finally {
    _scanInFlight = false;
  }
}

// ─── Notification create ───
// tabUrlPattern (optional, defaults to Ducanator) drives where the click
// handler routes to. The watchlist on the profile page passes
// 'https://warframe.market/profile/*' so clicking the notif focuses the
// profile tab instead of opening Ducanator.
async function fireNotification({ title, body, whisperText, tabUrlPattern }) {
  const id = `wfap-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    await new Promise((resolve, reject) => {
      chrome.notifications.create(id, {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icon.png'),
        title: title || 'Ducanator',
        message: body || '',
        priority: 1,
        requireInteraction: false,
      }, (createdId) => {
        if (chrome.runtime.lastError) reject(chrome.runtime.lastError);
        else resolve(createdId);
      });
    });
    await chrome.storage.session.set({
      [SESSION_KEY_PREFIX + id]: {
        whisperText: whisperText || '',
        tabUrlPattern: tabUrlPattern || DUCANATOR_URL_PATTERN,
      },
    });
  } catch {
    // Notification create failure isn't fatal; the scan results still go to
    // open Ducanator tabs via broadcastToDucanatorTabs.
  }
}

// ─── Notification click handler ───
// On click: focus any open Ducanator tab and round-trip the whisper text to
// the content script for clipboard write. If no tab is open, open one and
// queue the whisper in chrome.storage.session for the new tab to consume on
// init (see content.js wfbh-tab-hello handshake).
chrome.notifications.onClicked.addListener(async (notifId) => {
  const key = SESSION_KEY_PREFIX + notifId;
  const sessionData = await chrome.storage.session.get(key);
  const action = sessionData[key] || null;
  if (!action) {
    chrome.notifications.clear(notifId);
    return;
  }
  try {
    // Default to Ducanator tabs for backward-compat with notifications
    // fired before tabUrlPattern was added (e.g. during an SW idle window
    // around an upgrade). Watchlist notifications carry the profile pattern.
    const pattern = action.tabUrlPattern || DUCANATOR_URL_PATTERN;
    const tabs = await chrome.tabs.query({ url: pattern });
    if (tabs.length > 0) {
      const tab = tabs[0];
      if (tab.id != null) await chrome.tabs.update(tab.id, { active: true });
      if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true });
      if (action.whisperText) {
        chrome.tabs.sendMessage(tab.id, {
          type: 'copy-whisper',
          text: action.whisperText,
        }, () => { void chrome.runtime.lastError; });
      }
    } else if (action.whisperText && pattern === DUCANATOR_URL_PATTERN) {
      // No Ducanator tab open: open one and queue the whisper. The new tab's
      // content script will pull and consume PENDING_WHISPER_KEY on init.
      // (Profile-pattern notifications skip this branch since we won't open
      // a profile tab without knowing which profile slug to point at.)
      await chrome.storage.session.set({ [PENDING_WHISPER_KEY]: action.whisperText });
      await chrome.tabs.create({ url: DUCANATOR_URL });
    }
  } catch {
    // Tab/window may have closed during the click handler; nothing graceful.
  } finally {
    chrome.notifications.clear(notifId);
    await chrome.storage.session.remove(key);
  }
});

chrome.notifications.onClosed.addListener(async (notifId) => {
  await chrome.storage.session.remove(SESSION_KEY_PREFIX + notifId);
});

// ─── Alarm scheduler ───
// chrome.alarms.create's periodInMinutes/delayInMinutes have a 1-minute
// minimum in published extensions (30s in unpacked dev). Our UI minimum is
// 60s so we always pass >= 1 min.
async function setupAlarm() {
  const data = await chrome.storage.local.get([BH.ENABLED, BH.INTERVAL]);
  const enabled = data[BH.ENABLED] === '1';
  const intervalSec = Math.max(60, parseInt(data[BH.INTERVAL], 10) || BH.DEFAULT_INTERVAL);
  await chrome.alarms.clear(ALARM_NAME);
  if (enabled) {
    const minutes = intervalSec / 60;
    await chrome.alarms.create(ALARM_NAME, {
      periodInMinutes: minutes,
      delayInMinutes: minutes,
    });
  }
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  // Tab-presence gate: skip scheduled scans when no Ducanator tab is
  // open. Closing the last Ducanator tab is a clean way to say "I'm
  // done for now" without having to flip the master toggle. The alarm
  // keeps firing (cheap to no-op vs re-arming on tab open/close); the
  // next tick after a tab reopens will run normally. Manual Run Now
  // from the panel always runs, since clicking it implies a tab.
  const tabs = await findDucanatorTabs();
  if (tabs.length === 0) return;
  await runScan({ via: 'alarm' });
});

// SW startup hooks: re-arm the alarm to reflect current settings. Alarms
// persist across SW idle restarts but not across extension install/update,
// so onInstalled re-arms post-update; onStartup re-arms after browser
// restart. The bare setupAlarm() at module-init covers SW wake-from-event
// (e.g. notification click waking us with the alarm cleared somehow).
chrome.runtime.onInstalled.addListener(setupAlarm);
chrome.runtime.onStartup.addListener(setupAlarm);

// ─── Message handler ───
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return false;

  // Manual "Run Now" from the Ducanator panel.
  if (msg.type === 'wfbh-run-now') {
    runScan({ via: 'manual' }).then(
      (r) => sendResponse(r),
      (e) => sendResponse({ ok: false, error: String(e.message || e) })
    );
    return true;
  }

  // Settings changed in the panel that affect the alarm (toggle or interval).
  if (msg.type === 'wfbh-set-schedule') {
    setupAlarm().then(
      () => sendResponse({ ok: true }),
      (e) => sendResponse({ ok: false, error: String(e.message || e) })
    );
    return true;
  }

  // Tab handshake: a freshly-loaded Ducanator content script announces
  // itself and asks for any whisper queued by a prior notification click
  // (the case where we opened a new tab because none was open at click).
  if (msg.type === 'wfbh-tab-hello') {
    chrome.storage.session.get(PENDING_WHISPER_KEY).then((data) => {
      const whisper = data[PENDING_WHISPER_KEY] || '';
      if (whisper) {
        chrome.storage.session.remove(PENDING_WHISPER_KEY);
      }
      sendResponse({ ok: true, pendingWhisper: whisper });
    });
    return true;
  }

  // Generic notification request from any content script. Used by the
  // Arcane Watchlist (which runs in the content script, not the SW). The
  // tabUrlPattern decides where the click handler routes back to: profile
  // for the watchlist, ducats for Ducanator, etc. Defaults to ducats so
  // older callers without the field still work.
  if (msg.type === 'show-notification') {
    fireNotification({
      title: msg.title,
      body: msg.body,
      whisperText: msg.whisperText || '',
      tabUrlPattern: msg.tabUrlPattern,
    }).then(
      () => sendResponse({ ok: true }),
      (e) => sendResponse({ ok: false, error: String(e.message || e) })
    );
    return true;
  }

  return false;
});

// SW module-init: ensure the alarm reflects current settings every time the
// SW wakes (idle restart, event wake-up, etc.). Cheap idempotent operation.
setupAlarm();
