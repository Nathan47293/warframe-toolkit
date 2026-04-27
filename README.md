# Warframe Toolkit

> **Live: [nathan47293.github.io/warframe-toolkit](https://nathan47293.github.io/warframe-toolkit/)** — no install, just bookmark the URL.

A static web app that fetches live price data from [warframe.market](https://warframe.market) to help make smarter mod and arcane trading decisions in Warframe.

Hosted on GitHub Pages with a Cloudflare Worker handling the warframe.market CORS proxy.

## Tools

### Mod Flipper
Find the most profitable Rank 10 mods to flip (buy at R0, rank up with endo, sell at R10). Mods are classified into 6 types matching the in-game API rarity labels: **Common**, **Uncommon**, **Rare**, **Galvanized**, **Archon**, **Primed**. Each row shows flip profit, plat-per-1k-endo (true ROI on your endo investment), a composite **Value Score**, and 48-hour R10 trade volume. Includes per-mod **Sim R10** input that calculates a hypothetical **Sim Plat/1k Endo** if you sold at that R10 price.

Filter inputs sit directly under each numeric column header (`Sell (R10)`, `Flip Profit`, `Plat/1k Endo`, `Value Score`, `R10 Volume`) so each input is visually tied to its column. The Type column sorts in chip order (Common → Primed) instead of alphabetical. Archon and Primed are unchecked by default — those mods cost 1,000,000 credits each to obtain (transmute fee), so they rarely flip profitably.

### Endo Dissolve
Calculate the endo-per-plat efficiency of buying R10 mods and dissolving them. Mods are classified into 4 endo tiers: **Common**, **Uncommon**, **Galv/Rare**, **Archon/Primed**. The `Endo/Plat` column rounds to the nearest whole number, with green/yellow/red coloring based on efficiency. Min filters live inside the `Endo/Plat` and `R10 Volume` column headers. Includes per-mod **Sim Price** input for hypothetical buy prices. Archon/Primed off by default (same 1M credit reason).

### Vosfor Dissolve
Calculate the vosfor-per-plat efficiency of buying arcanes and dissolving them. Lists max-rank arcanes only (R5 or R3 — buying maxed always beats buying unranked on vosfor/plat efficiency). Rarity tiers: **Common**, **Uncommon**, **Rare**, **Tektolyst**, **Legendary**. Includes per-arcane **Sim Price** input. Min filters live inside the `Vosfor`, `Vosfor/Plat`, and `Volume` column headers. Hardcoded base vosfor values for all 162 tradeable arcanes (verified against the live warframe.market API).

### Arcane Packs
Expected plat value calculator for 9 vosfor-purchasable arcane collection packs (200 vosfor each): **Cavia, Duviri, Eidolon, Holdfasts, Höllvania, Necralisk, Ostron, Solaris, Steel**. Per-arcane rows have labeled columns: `Arcane | Max Sell | Vol | Per Unit | Vosfor`.

- **Dissolve Threshold** — arcanes with max rank price below the threshold get dissolved for vosfor recycling
- **Min Volume** — arcanes below this 48hr trade volume are treated as illiquid and dissolved
- **No-Volume Auto-Dissolve** — arcanes with 0 trades in the last 48 hours are automatically treated as untradeable; their base vosfor contributes to the recycle pool
- **Vosfor/Plat cost basis** — defaults to median of top 5 Vosfor Dissolve entries; used to calculate pack cost in plat and ROI
- **Geometric series recycling** — `Total EV = Direct Plat ÷ (1 − recycled vosfor ÷ 200)`
- **ROI** — `(EV − Pack Cost) ÷ Pack Cost × 100`

## Formulas

| Metric | Formula |
|--------|---------|
| **Flip Profit** | Sell SMA (R10) − Buy SMA (R0) |
| **Plat/1k Endo** | Flip Profit ÷ Endo Cost × 1000 |
| **Value Score** | (0.9 × Plat/1k Endo percentile rank + 0.1 × min(Volume ÷ 48, 1)) × min(Volume ÷ 10, 1) × 100 |
| **Sim Plat/1k Endo** | (Sim R10 − Buy SMA) ÷ Endo Cost × 1000 |
| **Endo/Plat** | Endo Return ÷ R10 Price |
| **Vosfor/Plat** | Vosfor Return ÷ Arcane Price |
| **Pack Direct EV** | Σ (drop chance × unit plat value) × 3 arcanes per pack |
| **Pack Total EV** | Direct EV ÷ (1 − recycled vosfor ÷ 200) |
| **Pack ROI** | (Total EV − Pack Cost) ÷ Pack Cost × 100 |

### Value Score Design

The Value Score ranks mods by combining endo efficiency with market liquidity, then applies a low-volume penalty so unreliable mods don't dominate the top of the list:

- **Plat/1k Endo (90%)** — percentile ranked against all mods. Captures true ROI on endo investment, normalizing across rarity tiers so an Uncommon mod using 20,460 endo is fairly compared against a Primed mod using 40,920 endo.
- **Volume (10%)** — raw linear score capped at 48 trades per 48 hours. Anything above 48 scores identically; intentionally NOT percentile ranked to avoid cliff effects near common volume clusters.
- **Low-volume penalty** — final score is multiplied by `min(Volume ÷ 10, 1)`. A mod with 10+ trades takes no penalty; below that, the score scales linearly toward 0. Smooth (no cliffs).

### Endo Values

| Tier | Endo to R10 | Dissolve Return (R10) |
|------|-------------|-----------------------|
| Archon / Primed | 40,920 | 30,710 |
| Galv / Rare | 30,690 | 23,033 |
| Uncommon | 20,460 | 15,355 |
| Common | 10,230 | 7,678 |

### Vosfor Values

Each arcane has a base vosfor value at R0. Max rank multiplier is ×21 for R5 arcanes and ×10 for R3 arcanes. All 162 tradeable arcane slugs are verified against the live API.

### Arcane Collections

9 collections available for 200 vosfor each. Each has rarity-grouped arcane contents with empirically verified drop rates (Ostron and Solaris use corrected rates that differ from official drop tables). Pack contents were cross-checked against in-game pack screenshots.

## Color Coding

### Mod Flipper
| Metric | Green | Yellow | Red |
|--------|-------|--------|-----|
| Plat/1k Endo | ≥2.5 | ≥2 | <2 |
| Value Score | ≥75 | ≥50 | <50 |

### Endo Dissolve
| Metric | Green | Yellow | Red |
|--------|-------|--------|-----|
| Endo/Plat | ≥500 | ≥300 | <300 |

### Vosfor Dissolve
| Metric | Green | Yellow | Red |
|--------|-------|--------|-----|
| Vosfor/Plat | ≥15 | ≥8 | <8 |

### Arcane Packs
| Metric | Green | Yellow | Red |
|--------|-------|--------|-----|
| Pack EV | ≥5p | ≥3p | <3p |
| ROI | ≥50% | ≥0% | <0% |
| Arcane Volume | ≥48 | ≥10 | <10 |

All colored metrics round to their displayed precision before threshold comparison, so a value displayed as `2.50` reliably colors green when the threshold is `2.5`.

## Architecture

Three files in the repo:

- `index.html` — the entire app (UI + logic, ~1,670 lines, vanilla JS, no build step)
- `cloudflare-worker.js` — source for the Cloudflare Worker that proxies warframe.market with a path whitelist and 5-minute edge caching
- `DEPLOYMENT.md` — one-time setup guide

### Data Flow

1. Browser fetches `<API_BASE>/v2/items` from the Cloudflare Worker → Worker forwards to warframe.market → returns full item catalog
2. Browser filters to ~132 rank-10 mods + ~162 arcanes (peculiar mods excluded)
3. Parallel fetch of `<API_BASE>/v1/items/{slug}/statistics` for each item (3 workers, 500ms stagger)
4. 48-hour closed trade stats parsed: SMA preferred, fallback to weighted avg or avg price
5. Arcane name lookup persisted in cache so unpriced arcanes still display readable names
6. Results cached in localStorage (24-hour freshness), auto-fetches if stale

### Rate Limiting

- 3 concurrent workers with 500ms delay between requests
- Exponential backoff on HTTP 429: 2s → 4s → 8s, up to 3 retries
- Worker caches responses for 5 minutes at the edge, so repeat fetches within the window don't re-hit warframe.market
- Errors counted but non-blocking — partial data is still rendered

### UI

- **Collapsible sidebar** — toggle button (chevron) in the header collapses to icons-only; state persists in localStorage
- **Per-column filter inputs** — numeric `min` filters live directly under their column headers in Mod Flipper, Endo Dissolve, and Vosfor Dissolve tabs
- **Custom sort orders** — Type/Tier/Rarity columns sort in chip order (left-to-right ascending) instead of alphabetical
- **Sticky table headers** — column headers stay visible while scrolling

## Deployment

See [DEPLOYMENT.md](DEPLOYMENT.md) for one-time setup (Cloudflare Worker + GitHub Pages, ~10 min, free tier on both).

## Companion: Chrome Extension (Dynamic Price Automator + Ducanator 2.0)

A separate Chrome extension lives in [`chrome-extension/`](chrome-extension/) for live trading. It ships two panels:

- **Dynamic Price Automator** — injects on your warframe.market profile page (after a one-time claim-profile prompt), reads each of your R10 mod sell listings, finds the cheapest *ingame* competitor, and recommends a `−1p` undercut gated by a plat/1k endo floor.
- **Ducanator 2.0** — injects on `warframe.market/tools/ducats`, scrapes the top-N rows from the Ducanator (despite the page using react-virtuoso virtualization), looks up the cheapest live ingame seller for each, and ranks the best real ducats/plat deals. Auto-clicks the page's Ducats/Plat column header to ensure descending sort before each scan. Persistent seller blocklist with one-click block from any result row, plus a `[/w]` link to copy a pre-formatted whisper for the seller.

Loaded as an unpacked extension — see the folder's README for install steps. Lives in this repo for source-of-truth tracking but runs entirely on warframe.market once installed.

## Browser Requirements

Modern enough to support CSS `:has()` — Chrome 105+, Firefox 121+, Safari 15.4+.
