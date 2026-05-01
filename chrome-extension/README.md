# Warframe Dynamic Price Automator (Chrome Extension)

A Chrome extension that ships **two panels** for live trading on warframe.market, both injected by a single content script:

- **Dynamic Price Automator** — on *your own* profile page, reads each of your R10 mod sell listings, finds the cheapest *ingame* competitor, and recommends a `−1p` undercut gated by a configurable plat/1k endo floor so it never undercuts past your break-even. Arcanes, riven mods, non-R10 listings, and buy orders are skipped automatically.
- **Ducanator 2.0** — on the Ducanator page (`/tools/ducats`), scrapes the top-N rows of the live ducat-deal table (despite the page using react-virtuoso virtualization), looks up the cheapest live ingame seller for each, and ranks the best real `ducats/plat` deals.

## Features

Both panels:

- **Master toggle** in the panel header (default OFF, persisted). Only the toggle authorises auto-runs — status going to `ingame` never flips it on by itself.
- **Auto-runs at a configurable interval**, with a manual `Run Now` button always available.
- **Background-tab safe** (Ducanator): the Ducanator scheduler + scan logic lives in the **service worker** (`background.js`), driven by `chrome.alarms`. Alarms keep firing on time even when the Ducanator tab is hidden or throttled, so scans land while you're alt-tabbed in-game. Tab-presence gate: scheduled scans are skipped when no Ducanator tab is open (closing the last tab is a clean way to say "I'm done for now" without flipping the master toggle off; reopening resumes scans on the next alarm tick). Manual `Run Now` always runs since clicking it implies a tab. Notifications fire directly from the SW when a scan turns up fresh deals; clicking one focuses the Ducanator tab and copies the top deal's `/w` to the clipboard. The DPA panel still runs in the content script (it gates on `ingame` status detected from the profile page DOM, so a backgrounded profile tab is fine for normal use). Both panels' state is namespaced (`wfaap-*` / `wfbh-*`) so cross-tab interactions stay isolated.
- **Draggable + collapsible** panels, with collapsed/position state persisted.

### Dynamic Price Automator (warframe.market/profile/<slug>)

- **Single-button flow**: `Run Now` (manual) or auto-runs every interval seconds when status is `ingame` AND toggle is on.
- **Visible-only**: only manages listings with `visible: true`.
- **Walk-up price tier selection**: tries `cheapest − 1`, falls through to `2nd − 1`, `3rd − 1`, etc., picking the highest-tier slot still above your plat/1k endo floor. Reports `position X/N`. Tied-at-top scenarios (a competitor at your exact price) naturally fall out as a `−1` undercut whenever the floor allows; otherwise the listing is held.
- **Floor mode** (select): switches between two ways to set the floor.
  - **Static value** (default) — you type a fixed plat/1k endo floor. Mods only undercut to tiers above that.
  - **Target #1 count** — you type how many of your mods you want at position 1 (cheapest); the floor is **derived dynamically every scan** from the live market data. The derivation: for each mod with a competitor, compute the "would-be #1 ratio" `(cheapest_competitor_plat − 1) / endo_cost × 1000`. Sort those descending, take the Nth (where N = target − unopposed-mods-already-at-#1). That value is the highest floor where exactly N mods land at #1. Edge cases: if you already have ≥N mods unopposed (no ingame competitor), the computed floor is `∞` (no undercut runs); if you set N higher than the total mods that *can* reach #1, it's `0` (everyone undercuts and the achievable count is whatever the market supports). The computed floor is shown back to you under the input as `Computed floor: 2.30 P/1k (target 5 #1: 2 unopposed + 3 cheapest-tier above floor)` so you know the actual margin in play.
- **Auto-refresh on apply**: when prices change, the page reloads to show new prices. The skip-initial flag prevents a re-scan loop; interval timing is preserved across the reload via `LAST_SCAN_KEY`.
- PATCH `/v2/order/{id}` with `{ visible, platinum, quantity, rank }`, ~500ms apart, with `X-CSRFToken`.

### Ducanator 2.0

Lives on the **Ducanator page** only (`/tools/ducats`). Reads the live table on the page directly.

- **Auto-sort**: at the start of every **cache refresh**, clicks the page's **Ducats/Plat** column header until that column is sorted descending — verified by comparing the values of the two rendered rows with the lowest `data-item-index` (robust to mid-list scroll, since virtuoso doesn't keep `data-item-index="0"` mounted when you've scrolled). Up to 3 click attempts. So you never have to manually fix the table's sort before refreshing the cache.
- Reads the top **N** rows from the cached source list (default 30, max 500 = cache size). The cache is built/refreshed via the Refresh button — that's the only step that actually scrapes the page, scrolling the virtuoso list to mount fresh rows and deduping by slug. Regular scans just slice the cache.
- **Ducats (item)** — multi-select over the 5 prime-part ducat denominations (15 / 25 / 45 / 65 / 100). Only parts whose ducats are checked pass through to the API-call stage; sets are always exempt (their ducats are sums of part ducats, not single denominations). Default is all 5 checked = no filter. Clearing every box is treated as "filter off" too, so you can't accidentally drop every part. Applied to cached rows before any API calls.
- **Trade math (uniform for items + sets)**: every listing is evaluated through the in-game 6-items-per-trade cap. For each candidate seller, the program finds the largest `K` units (items, or sets — sets being treated as bundles of `parts_per_set` parts) that you could buy such that all full trades are 6/6 AND the (single, last) partial trade meets your **Min trade efficiency** floor. If no `K ≥ 1` works, the listing is excluded.
  - For items (`P=1`): trivial — keep `K=qty` if `qty mod 6 ≥ floor` (or 0); else drop down to the largest multiple of 6.
  - For sets (`P` = parts per set, looked up from API + cached): iterate `K = qty, qty-1, …, 1` and pick the first where `K×P mod 6` is 0 or ≥ floor.
  - Output per listing: `D/p`, `D/trade` (= `total_D / total_trades`, rounded down), `total_D` (= `K × ducats_per_unit`), and a trade-breakdown string like `2 trades · 6/6` or `3 trades · 6/6, 4/6 last`.
- **Min trade efficiency (X/6)** — number input 1–6 (default 1). 1 means any non-zero partial OK; 6 means only fully-loaded trades count. Drives the `K` calculation above. Setting this excludes listings whose best `K` is 0.
- **Sort by** — `D/p` (page-style), `D/trade` (best when trade-limited), or `total D` (raw ducats from the listing). Persisted. The right-side metric shown next to each result's name follows the sort: D/trade by default, or total D when sorting by total D.
- **Set parts data**: looked up via `/v2/items/{slug}` (returns `setRoot` + `setParts: [...IDs]`; parts count = filter out the set's own ID). Cached forever in `wfbh-parts-cache` per slug — composition only changes on new prime releases. The cache is backfilled automatically when you click **Refresh source cache**: any new set in the source list gets a parts fetch (paced 500ms apart). Sets with missing parts data during a regular scan are silently skipped, with a "X sets missing parts data — refresh source cache" note in the status line.
- Each result row shows the listing's plat price, quantity, the seller's name (clickable to their profile), a **[block]** link, a **[/w]** link, the trade breakdown (`2 trades · 6/6 · 780D total`), and a "view item" link. For 1-trade listings the redundant `total` segment is omitted (D/trade equals total D); when sorting by `total D`, total D is omitted from the detail since it's already in the name line.
  - **[block]**: adds the seller to a persistent blocklist, drops every row currently selling from them, and future scans pick a non-blocked seller for those items.
  - **[/w]**: copies a pre-formatted whisper to clipboard in the same format warframe.market uses: `/w <ingame-name> Hi! I want to buy: "<item name>" for <X> platinum. (warframe.market)`. Paste straight into Warframe's chat. The link briefly turns green and reads `copied!` on success.
- **Blocklist viewer** (`<details>` section at the bottom): collapsible list of every blocked seller with × buttons to remove individually. Count shown in the summary line. Persisted across reloads / browser restarts via localStorage (`wfbh-blocklist`).
- Toggle + interval behavior matches the Dynamic Price Automator (default 600s interval, min 60s). **No status gate** — runs regardless of whether you're online, ingame, or offline, since finding deals doesn't require either side to be ingame.
- **Source-list cache + Refresh button**: scans no longer scrape the page directly. Instead they pull from a manually-refreshed cache of up to 500 rows kept in `localStorage` (mirrored to `chrome.storage.local` so the service worker can read it). The `Refresh` button next to "Source cache" runs a foreground scrape (auto-sort + 500-row scroll-and-collect) and writes the result to the cache; the timestamp of the last refresh is shown next to it (`Cache: 480 rows · 2h ago`). Because regular scans run in the SW against the cached data, they work fine when the tab is hidden, throttled, or fully closed. Refresh the cache when you think the page's source list has shifted (rare; the top-500 by WA-based D/p is very stable hour-to-hour). The Refresh button itself still requires the tab to be visible, since the page's react-virtuoso list only mounts rows when painted.
- **Notify on new deals** (toggle, default ON): when a scan (in the service worker) turns up at least one deal that hasn't been notified about in the last hour, fires a Windows toast via `chrome.notifications`. Scans only run while a Ducanator tab is open (see the tab-presence gate above), but the tab can be hidden, throttled, or in another window — the SW alarm keeps firing on time regardless of focus state.
  - Title: `Ducanator: 3 deals · top 90.50 D/p`
  - Body: `Mirage Prime Helmet · 270D/trade · 540D total`
  - Click action: focuses any open Ducanator tab (or opens a new one) and copies the top-D/p deal's `/w` whisper to your clipboard. When opening a new tab, the whisper is queued in `chrome.storage.session` and the freshly-loaded content script consumes it via a `wfbh-tab-hello` handshake on init.
  - Dedup: a deal is identified by `slug + seller_slug`. Once notified, it stays in the dedup set for an hour after its last appearance, so consecutive scans containing the same deals don't re-notify. After it falls off (gone from results for >1h), if it reappears it'll re-trigger. The dedup map lives in `chrome.storage.local` and is owned by the SW.

### Profile ownership

The Dynamic Price Automator only injects on **your own** cached profile URL. On the first profile-page visit (any profile), if no slug is cached, a **claim-profile prompt** appears asking you to paste your own warframe.market profile URL. After you save, only that profile gets the panel; other people's profiles stay untouched. To change the cached profile later, click the **change** link in the panel footer (it clears the cache and re-prompts on the next profile load).

## Install

1. Copy this `chrome-extension/` folder to a stable location, e.g.
   `C:\Users\<you>\Documents\WarframeToolkitExtension\`
   (Keeping the runtime copy outside the repo means you can delete the repo without breaking the extension.)
2. Open Chrome → `chrome://extensions`
3. Toggle **Developer mode** on (top-right).
4. Click **Load unpacked** → point at the folder you copied to.
5. Visit your warframe.market profile (e.g. `https://warframe.market/profile/<yourname>`). A floating panel appears in the top-right.

## Use

### Dynamic Price Automator

1. First visit to any warframe.market profile page: a **claim-profile prompt** appears. Paste your own profile URL (`https://warframe.market/profile/<your_slug>`) and hit **Save profile**. The page reloads.
2. From now on, the panel only injects when the URL slug matches the cached one. Visit `warframe.market/profile/<your_slug>` — panel injects in the top-right.
3. Pick a **Floor mode**: `Static value` (default) or `Target #1 count`. With static, set the **Plat/1k Endo floor** (default 2.5). With target-count, set the **Target #1 count** (default 5) — the floor is computed each scan and shown to you under the input.
4. Set your **Auto-run interval** (default 300s, min 30).
5. Flip the **header toggle ON** to enable auto-runs. Default is OFF.
6. Status line shows `Status: ingame · auto-run on (via dom)` when everything is ready.
7. **Run Now** is always available regardless of toggle for one-shot manual scans.
8. The panel footer shows the cached profile slug. Click **change** there to clear it and re-prompt.

Each row in the results table is colored by outcome:
- **Green (move)** — recommended undercut, will be applied.
- **Cyan (applied)** — successfully PATCHed; price is updated.
- **Yellow (floor)** — every undercut tier on the leaderboard would land below your floor; the listing is held.
- **Gray (noop)** — already at the optimal price, or no ingame competitor.
- **Red (error)** — fetch or PATCH failed; check the message.

### Ducanator 2.0

1. Visit the Ducanator page on warframe.market — panel injects in the top-right.
2. Adjust **Top-N source rows** (default 30, max 500), **Top-M results** (default 10), **Min ducats/plat** floor (default 0 = off), **Min trade efficiency** (1–6, default 1; floor on the partial-trade size — 6 = only fully-loaded 6/6 trades), **Sort by** (D/p / D/trade / total D, default D/p), **Auto-run interval** (default 600s, min 60), **Ducats (item)** (5 checkboxes for 15 / 25 / 45 / 65 / 100, default all checked = no filter), **Notify on new deals** (default ON).
3. Click **Refresh** next to "Source cache" to build the initial cache (up to 500 rows). This is required before the first scan can produce results. The cache survives across reloads / browser restarts.
4. Flip the **header toggle ON** to enable auto-runs. Default OFF.
5. **Run Now** for one-shot scans.

The cache refresh (not regular scans) auto-clicks the page's **Ducats/Plat** column header until the table is sorted descending — so you don't have to manually fix the sort order before refreshing. The auto-sort verifies by row order (compares values from the two rendered rows with the lowest `data-item-index`), since the page's `down--*` class isn't a reliable active-sort indicator.

Each result row is **green (deal)** with the real `ducats/p` ratio (using the cheapest ingame seller, not the Ducanator-displayed WA), the seller's name (clickable to their profile), a `[block]` link to add them to the blocklist, a `[/w]` link to copy the in-game whisper to clipboard, and a "view item" link.

The collapsible **Blocklist (N)** section at the bottom of the panel shows every blocked seller. Click `×` next to a name to remove that seller from the blocklist (their listings will appear again on the next scan). The blocklist is stored in `localStorage` and persists across reloads, browser restarts, and extension reloads.

## Update

1. Pull latest from the toolkit repo.
2. Copy the new `chrome-extension/` contents over your runtime folder.
3. In `chrome://extensions`, click the refresh icon on the extension's card. New version is active.

## Why a Chrome extension?

warframe.market's order/profile endpoints sit behind a Cloudflare bot challenge — anonymous and proxied requests get `403`. From inside a logged-in browser session on warframe.market, those same endpoints work because the session has already cleared the challenge and carries auth cookies. The extension runs in that context, so its `fetch` calls Just Work. State-changing requests (PATCHing your own listings) also need the `X-CSRFToken` header which the extension reads from the page's `<meta name="csrf-token">` tag.

The extension also sends `Crossplay: true` on every API call, which surfaces cross-platform sellers (Xbox, PlayStation, Mobile) that the API otherwise filters out — important for accurately picking the real cheapest competitor.

## Files

- `manifest.json` — Manifest V3. Content script is scoped to `https://warframe.market/profile/*` and `https://warframe.market/tools/ducats*`. Host permissions cover the API origin too. Adds `notifications`, `storage`, and `alarms` permissions: the first two for Ducanator notifications + cache; `alarms` for the SW-driven Ducanator scan scheduler.
- `content.js` — single-file content script with both panels' UI. The DPA panel still runs its scheduler + scan inline (status detection needs the profile page DOM); the Ducanator panel is now a UI shell that mirrors settings to `chrome.storage.local`, sends manual `wfbh-run-now` to the SW, and renders results streamed back via `wfbh-scan-results` messages.
- `background.js` — MV3 service worker. Owns the Ducanator scan: reads settings + caches from `chrome.storage.local`, fires `chrome.alarms` ticks, fetches `/v2/orders/item/{slug}` for each cached row, applies the trade math + tier-filter logic, broadcasts results to all open Ducanator tabs, and creates `chrome.notifications` toasts for fresh deals. On notification click, focuses any open Ducanator tab (or opens one) and round-trips the top deal's whisper text for clipboard write. Click→action mappings live in `chrome.storage.session` so they survive SW idle restarts; the alarm itself persists across restarts too.
- `icon.png` — 128×128 icon used by `chrome.notifications` (also serves as the extension icon).
- `README.md` — this file.
