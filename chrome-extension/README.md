# Warframe Dynamic Price Automator (Chrome Extension)

A Chrome extension that ships **two panels** for live trading on warframe.market, both injected by a single content script:

- **Dynamic Price Automator** — on *your own* profile page, reads each of your R10 mod sell listings, finds the cheapest *ingame* competitor, and recommends a `−1p` undercut gated by a configurable plat/1k endo floor so it never undercuts past your break-even. Arcanes, riven mods, non-R10 listings, and buy orders are skipped automatically.
- **Ducanator 2.0** — on the Ducanator page (`/tools/ducats`), scrapes the top-N rows of the live ducat-deal table (despite the page using react-virtuoso virtualization), looks up the cheapest live ingame seller for each, and ranks the best real `ducats/plat` deals.

## Features

Both panels:

- **Master toggle** in the panel header (default OFF, persisted). Only the toggle authorises auto-runs — status going to `ingame` never flips it on by itself.
- **Auto-runs at a configurable interval**, with a manual `Run Now` button always available.
- **Background-tab safe**: schedulers use plain `setInterval`, which keeps firing in hidden tabs (Chrome's 1s throttle floor is irrelevant at our 300s/600s defaults). Both panels can run in parallel on separate tabs, both out of focus, with no shared state — they use disjoint `wfaap-*` / `wfbh-*` localStorage namespaces.
- **Draggable + collapsible** panels, with collapsed/position state persisted.

### Dynamic Price Automator (warframe.market/profile/<slug>)

- **Single-button flow**: `Run Now` (manual) or auto-runs every interval seconds when status is `ingame` AND toggle is on.
- **Visible-only**: only manages listings with `visible: true`.
- **Walk-up price tier selection**: tries `cheapest − 1`, falls through to `2nd − 1`, `3rd − 1`, etc., picking the highest-tier slot still above your plat/1k endo floor. Reports `position X/N`.
- **Auto-refresh on apply**: when prices change, the page reloads to show new prices. The skip-initial flag prevents a re-scan loop; interval timing is preserved across the reload via `LAST_SCAN_KEY`.
- PATCH `/v2/order/{id}` with `{ visible, platinum, quantity, rank }`, ~500ms apart, with `X-CSRFToken`.

### Ducanator 2.0

Lives on the **Ducanator page** only (`/tools/ducats`). Reads the live table on the page directly.

- **Auto-sort**: at the start of every scan, clicks the page's **Ducats/Plat** column header until that column is sorted descending — verified by comparing the values of the two rendered rows with the lowest `data-item-index` (robust to mid-list scroll, since virtuoso doesn't keep `data-item-index="0"` mounted when you've scrolled). Up to 3 click attempts. So you never have to manually fix the table's sort before running.
- Scrapes the top **N** rows from the Ducanator table (default 30, configurable). The page uses react-virtuoso virtualization, so the scraper scrolls the window to mount fresh rows and dedupes by slug.
- **Filter** (3-way: All / Parts only / Sets only, default All): set-listing slugs end in `_set` — Sets-only keeps just those, Parts-only excludes them, All keeps everything. Filter is applied to the scraped rows before any API calls, so changing it doesn't waste requests.
- For each row, fetches `/v2/orders/item/{slug}`, finds the cheapest `type:'sell'` + `status:'ingame'` competitor whose `quantity` meets your **Min listing quantity** (default 1). When the Filter is **All**, sets are exempt from the min-qty floor (sets are usually listed as singletons), and the label updates to `Min listing quantity (items)` to reflect that.
- Computes real `ducats / cheapestIngamePrice`, sorts descending, then applies two cutoffs — top **M** results (default 10) and **Min ducats/plat** floor (default 0). Whichever shortens the list wins.
- Each result row shows the listing's plat price, quantity, the seller's name (clickable to their profile), a **[block]** link, a **[/w]** link, and a "view item" link.
  - **[block]**: adds the seller to a persistent blocklist, drops every row currently selling from them, and future scans pick a non-blocked seller for those items.
  - **[/w]**: copies a pre-formatted whisper to clipboard in the same format warframe.market uses: `/w <ingame-name> Hi! I want to buy: "<item name>" for <X> platinum. (warframe.market)`. Paste straight into Warframe's chat. The link briefly turns green and reads `copied!` on success.
- **Blocklist viewer** (`<details>` section at the bottom): collapsible list of every blocked seller with × buttons to remove individually. Count shown in the summary line. Persisted across reloads / browser restarts via localStorage (`wfbh-blocklist`).
- Toggle + interval behavior matches the Dynamic Price Automator (default 600s interval, min 60s). **No status gate** — runs regardless of whether you're online, ingame, or offline, since finding deals doesn't require either side to be ingame.
- **Background-tab safe**: the scheduler uses plain `setInterval`, which keeps firing in hidden tabs (Chrome's 1s throttle floor is irrelevant at our 300s/600s defaults). Both panels can run in parallel on separate tabs (one on the profile page, one on `/tools/ducats`), both out of focus, with no shared state — they use disjoint `wfaap-*` / `wfbh-*` localStorage namespaces.

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
3. Set your **Plat/1k Endo floor** (default 2.5).
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
2. Adjust **Top-N source rows** (default 30), **Top-M results** (default 10), **Min ducats/plat** floor (default 0 = off), **Min listing quantity** (default 1, items-only when Filter=All), **Auto-run interval** (default 600s, min 60), **Filter** (All / Parts only / Sets only, default All).
3. Flip the **header toggle ON** to enable auto-runs. Default OFF.
4. **Run Now** for one-shot scans.

Each scan auto-clicks the page's **Ducats/Plat** column header until the table is sorted descending — so you don't have to manually fix the sort order before scanning. The auto-sort verifies by row order (compares values from the two rendered rows with the lowest `data-item-index`), since the page's `down--*` class isn't a reliable active-sort indicator.

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

- `manifest.json` — Manifest V3. Content script is scoped to `https://warframe.market/profile/*` and `https://warframe.market/tools/ducats*`. Host permissions cover the API origin too.
- `content.js` — single-file content script with both panels' logic + injected UI. No build step.
- `README.md` — this file.
