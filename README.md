# Warframe Mod Flip Tracker

A local web app that fetches live price data from [warframe.market](https://warframe.market) and calculates the most profitable Rank 10 mods to flip (buy at R0, rank up, sell at R10).

![Dark themed UI with sortable, filterable mod data](https://img.shields.io/badge/warframe-mod%20flipper-00e5ff?style=flat-square)

## Features

- **Live data** from warframe.market's API (fetches ~350 rank-10 mods)
- **Opportunity Score** ranking: `Flip Profit × ln(R10 Volume + 1)` — balances profit with trade volume
- **Sortable columns** with three-state cycling (descending → ascending → unsorted)
- **Filterable** by mod name, type (Archon/Galvanized/Primed/Regular), min profit, min opp score, min sell price, min volume
- **24-hour caching** via localStorage — instant load on revisit, manual refresh anytime
- **Rate limit handling** with exponential backoff retry on 429 responses
- **Dark gaming aesthetic** UI

## How It Works

The app runs a tiny local Python server that proxies requests to warframe.market (to avoid CORS issues with `file://` pages). The HTML frontend fetches the item list, filters to rank-10 mods, pulls 48-hour trade statistics for each, and calculates flip profits.

### Formulas

| Metric | Formula |
|--------|---------|
| **Flip Profit** | Sell SMA (R10) − Buy SMA (R0) |
| **Opportunity Score** | Flip Profit × ln(R10 Volume + 1) |

## Quick Start

1. Make sure [Python 3](https://www.python.org/downloads/) is installed
2. Double-click `run_flipper.bat` (or run `python server.py` from a terminal)
3. The app opens automatically at `http://localhost:8777`
4. Data fetches automatically on first launch (~2-3 minutes for ~350 mods)

## Files

| File | Description |
|------|-------------|
| `run_flipper.bat` | Windows launcher — double-click to start |
| `server.py` | Local Python server that proxies warframe.market API |
| `warframe_mod_flipper.html` | The app UI (HTML/CSS/JS) |

## Requirements

- Python 3.6+ (no pip packages needed — uses only built-in libraries)
- A web browser

## Color Coding

| Metric | Green | Yellow | Red |
|--------|-------|--------|-----|
| Flip Profit | ≥80p | ≥60p | <60p |
| Opp Score | ≥300 | ≥250 | <250 |
