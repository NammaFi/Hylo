# Hylo Scraper — Implementation Phases

**This is the Implementation Plan** — how we actually change Hylo's code, deployment, and data pipeline. It's a separate document from `SDK_INTRODUCTION.md`, which is a pure reference/explanation of what the Exponent SDK offers. Read that one to understand the SDK's building blocks; read this one for what we're actually going to do with them, and what's still an open decision.

## Status Overview

| Phase | Description | Status |
|-------|-------------|--------|
| Phase 1 Enhancements | YT metrics in Phase 1 without waiting for Phase 2 | ✅ Complete |
| Vercel Bypass (Option 2) | Playwright-based scraper for Exponent | ✅ Complete |
| RPC-Based Scraper (Option 1) | SDK on-chain data fetch, no browser | ✅ Built, tested, **and wired into `scrape-once.js`** 2026-07-28 — API-primary (Section 0), RPC is a whole-response outage fallback only. Not yet run against the real Gist/RateX/alert endpoint. Two ways to do that were laid out (add a real `GIST_TOKEN` to `server/.env` and run locally, or commit + push to `web_scraping_start` and let the already-configured GitHub Actions workflow run it) — **explicitly deferred by your call, "leave for now."** |
| Scheduling/deployment rework | Fix GH Actions reliability + a live security issue | ✅ Worker built & tested locally 2026-07-28 (`workers/`), security fix shipped — **not yet deployed**, needs your Cloudflare account |

---

## ✅ Completed: Phase 1 YT Metrics Enhancement

See `PHASE1_ENHANCEMENTS.md` for full details.

**Summary**: Enhanced Phase 1 to calculate YT metrics immediately (visual assets, rangeLower,
ytPriceCurrent, etc.) without waiting for Phase 2. Phase 2 still refines rangeUpper and upsidePotential.

---

## ✅ Completed: Vercel Bypass — Option 2 (Playwright)

### Problem
Exponent Finance (`v1.exponent.finance`) is hosted on Vercel. Vercel's bot-detection checkpoint
blocks headless Puppeteer because it detects the `navigator.webdriver` flag and the lack of
real JS challenge execution.

### Solution Chosen
Replace Puppeteer with **Playwright** for all Exponent scraping (Phase 1 farm page + Phase 2 detail pages).

### Exactly how the bypass works today (verified 2026-07-23 by reading `server/scraper-exponent-playwright.js` directly)

One correction worth being precise about: **this bypasses Vercel's own bot-detection checkpoint, not Cloudflare.** The file's own header comment says so directly ("bypasses Vercel checkpoint"), and there's no Cloudflare-specific code anywhere (no `cf_clearance` cookie handling, no Turnstile widget interaction). Concretely, the technique is:

1. **Use Playwright, not Puppeteer** — it launches a real, full Chromium browser build (not a stripped-down automation-only one), which can execute Vercel's client-side JS challenge exactly the way a real visitor's browser would.
2. **Hide the `navigator.webdriver` flag**, which is `true` by default in any automated browser and one of the most common bot-detection signals:
   ```js
   await context.addInitScript(() => {
     Object.defineProperty(navigator, 'webdriver', { get: () => false });
   });
   ```
3. **Launch with `--disable-blink-features=AutomationControlled`** — removes another Chromium flag some detection scripts check for.
4. **Set a real desktop Chrome user-agent string** explicitly, plus an `Accept-Language` header.
5. Runs fully `headless: true` and this is still sufficient — Vercel's checkpoint here doesn't appear to fingerprint headless mode beyond the above signals, once the JS challenge itself executes successfully.

**For RateX specifically:** grepping `server/scraper.js` for any of this same bypass machinery (`cloudflare`, `webdriver`, `challenge`, `userAgent`, etc.) found **nothing** — RateX's scraper uses plain Puppeteer with no special handling, and per the architecture history this has been sufficient. So as of today, **RateX does not need a bot-detection bypass at all**; only Exponent's site does, and it's Vercel's checkpoint, not Cloudflare's.

**Why this matters for the RPC migration below:** all of this bypass machinery goes away entirely once Exponent scraping is replaced with the SDK's direct on-chain reads — there's no page to load, so there's no checkpoint to pass. This is also what makes Cloudflare Workers a viable *compute* location for Exponent data (see the Scheduling section) — a real headless-browser dependency wouldn't run there, but an RPC call does.

### Files Changed (for reference — unchanged by this update)
- **`server/scraper-exponent-playwright.js`** *(new)* — Full replacement for `scraper-exponent.js`
- **`server/scrape-once.js`** — Imports from Playwright scraper
- **`server/package.json`** — Added `playwright: ^1.52.0`
- **`.github/workflows/scrape-ratex.yml`** — Added `npx playwright install chromium --with-deps`

### Fallback
If Playwright browser fails to launch (e.g. missing binary on a runner), Phase 2 falls back to
the old Puppeteer-based `scrapeExponentDetailPages` from `scraper.js`.

---

## 📋 Planned: RPC-Based Scraper — Option 1 (Exponent SDK)

### Motivation
Playwright works today but remains dependent on Exponent's HTML structure and Vercel's bot-detection policy — plus it's built entirely against `v1.exponent.finance`, the **old** UI (see the correction below). An RPC-based approach fetches data **directly from the Solana blockchain** via the Exponent SDK, bypassing the browser layer, Exponent's HTML, and the v1/v2 UI question entirely — we'd be reading the same on-chain accounts regardless of which UI version Exponent is running.

**Note on v1 vs v2, corrected 2026-07-23:** the "exponent v2" commit in this repo's history was a pure hostname rename (`www.exponent.finance` → `v1.exponent.finance`) with zero scraping-logic changes. The live site is already showing users an "Exponent v2 is coming" announcement banner that the scraper currently just dismisses rather than reacts to. This confirms scraping is fundamentally fragile to the actual v2 migration whenever it fully lands — another reason to prioritize this RPC-based approach.

**SDK installed:** `@exponent-labs/exponent-sdk@0.9.23` is now in `server/node_modules` (updated 2026-07-28 from `0.9.21`, the true latest per npm — `pnpm install` on the Exponent side had flagged `0.9.23` as newer). Full API reference: `SDK_INTRODUCTION.md`.

### 0. MAJOR FINDING 2026-07-28: Exponent's own site API — changes the whole approach

Found by you, directly: `https://app.exponent.finance/api/markets`. This is the exact JSON the live site itself fetches to render the Yield Markets table — a single unauthenticated `GET`, no browser, no Vercel bot-checkpoint involved (confirmed: a plain `fetch()`, both via `WebFetch` and a direct Node script, returned the full JSON array cleanly — that checkpoint gates the HTML pages, not this JSON endpoint). This resolves several problems this document previously listed as open, in one shot:

| Field | What it gives us | Resolves |
|---|---|---|
| `underlyingApy` | Decimal Underlying APY, e.g. `0.0586996864972984` for hyloSOL | **The exact open problem from your screenshot.** `0.0586996864972984 * 100 = 5.86996...%` — matches your live screenshot's displayed `5.87%` essentially exactly. Our own on-chain formula (`currentSyExchangeRate` annualized over days-since-vault-inception) gave `25.14%` for the same asset — 4.3x too high, root cause almost certainly the "days since inception" window being far too short/noisy for a young vault (flagged as a risk in the code's own comment before we ever tested it). We don't need to fix that formula — Exponent's own backend already computes this correctly (likely via a proper historical lookback we don't have visibility into), so we just read it. |
| `underlyingApy1Epoch` / `3Epoch` / `7Epoch` / `30Epoch` | The same figure over different lookback windows | Bonus — not required for the current Gist schema, saved as additive `_underlying*Epoch` fields in case smoothing/alerting wants them later. |
| `impliedApy` | Decimal Implied APY, e.g. `0.12085057689614298` for hyloSOL | **Cross-validates our own CLMM formula.** `12.085%` vs. our independently-derived `(Ticks.currentSpotPrice - 1) * 100` giving `12.09%` for the same market — both right, good mutual confirmation. |
| `yieldExposure` | e.g. `214.19` for hyloSOL | **Answers "Yield Exposure"/leverage** — Section 4 below had this as unverified and shipping `null`. No longer a guess. |
| `pointsBoost.points_per_day` | e.g. `1` for hyloSOL, `null` for stSLX | **Answers "points per day"** — Section 3's plan was to hand-maintain this 100% in `asset-registry.json`. Now mostly automatic; the registry's `pointsPerDay` field becomes an override for the (rarer) case this comes back `null`. |
| `orderbookAddresses[]` / `legacyMarketAddresses[]` | Direct address arrays | Same destination as the PDA-derivation work in Section 5, reached without a derivation step — used as primary now, PDA derivation kept as the RPC-fallback path's own mechanism. |
| `vaultAddress`, `tokenName`, `underlyingAsset.name`, `categories`, `maturityDateUnixTs`, `startDateUnixTs`, `marketStatus`, `liquidity`, `totalMarketSize` | Everything else the Gist schema needs | No RPC/SDK call required for any of it — names included, so the `mintPt` Metaplex lookup (Section 3) is no longer on the critical path either. |

**A gap was found, then explicitly ruled out of scope, by diffing this API's response against our own RPC-discovered list:** the API returned **12 active markets**; our RPC-based CLMM discovery (Section 7b) independently found **14 live markets** at the same moment. Three of ours were absent from the API (`kUSDC-10AUG26`, `USD.tel-05DEC26`, `srONyc-14NOV26` — newer/thinner markets, plausibly not yet indexed by whatever internal system backs this endpoint), and the API had one we didn't have registered at all (`fragSOL`). **Decided: not worth backfilling** — those three "weren't needed anyway," per your call.

**Reliability framing:** this is an undocumented, reverse-engineered endpoint — not part of the official `@exponent-labs` SDK, wasn't announced anywhere, and could change shape or disappear without notice, same risk class as scraping HTML (just far cheaper and richer while it lasts: one HTTP call vs. a full browser boot, and it hands us fields — Underlying APY, Yield Exposure, points-per-day — that on-chain reads alone can't reconstruct as accurately). **Decision, per your explicit correction: the RPC path is a whole-response fallback only** — it runs only when the API call itself fails or comes back with zero active markets, never to backfill individual known assets missing from an otherwise-healthy response. `server/fetch-exponent-api.js` (built and tested 2026-07-28) fetches the endpoint; on failure or an empty result it calls `fetch-exponent-rpc.js`'s `fetchAllExponentAssetsRpc()` (full CLMM-anchored discovery, Section 7b) to reconstruct the entire list from scratch. **Tested end-to-end 2026-07-28: the common-path run returns exactly the API's 12 assets in 0.36 seconds, no RPC call made at all** (confirmed by checking no fallback log line fired).

This changes the CPU-time question from Section 6d considerably: the ordinary case is now "one HTTP fetch + a JSON map," not "decode raw Solana account bytes for every market" — the RPC path only ever runs on a genuine outage. Revisit Section 6d's Cloudflare Workers estimate with this in mind before assuming the CLMM decode cost is the binding constraint.

### 1. Auto-Discover Markets — Verified 2026-07-23 (corrects the previous version of this section)

The import paths and function names below were checked directly against the installed package's type declarations, not assumed:

```js
import { fetchProgramAccountsMarketTwo, EXPONENTCORE_PROGRAM_ID } from '@exponent-labs/exponent-sdk/client/core';
import { fetchProgramAccountsMarketThree, EXPONENTCLMM_PROGRAM_ID } from '@exponent-labs/exponent-sdk/client/clmm';
import { fetchProgramAccountsVault } from '@exponent-labs/exponent-sdk/client/core';
import { fetchProgramAccountsExponentTranchingMarket, EXPONENTTRANCHING_PROGRAM_ID } from '@exponent-labs/exponent-sdk/client/tranching';

const legacyMarkets   = await fetchProgramAccountsMarketTwo(connection, EXPONENTCORE_PROGRAM_ID);
const clmmMarkets     = await fetchProgramAccountsMarketThree(connection, EXPONENTCLMM_PROGRAM_ID);
const vaults          = await fetchProgramAccountsVault(connection, EXPONENTCORE_PROGRAM_ID);
const tranchingMarkets = await fetchProgramAccountsExponentTranchingMarket(connection, EXPONENTTRANCHING_PROGRAM_ID);  // if/when we add Tranching support
```

**OrderBook gap: resolved, see Section 5.** No bulk-fetch exists for OrderBook's own accounts, but its address derives via PDA from a known vault (`ExponentOrderbookPDA.orderbook({vault, seedId})`), confirmed live — no maintained list needed.

**`fetchProgramAccountsVault` has a real decode bug, confirmed on a real paid RPC too (2026-07-23 → 2026-07-28) — but superseded 2026-07-28 by a much better discovery path.** Running `fetchProgramAccountsVault` fails with `Codec [u32] cannot decode empty byte arrays` on both the free public RPC and the trading bot's real Helius endpoint — not an RPC-quality issue, a genuine SDK-decoder edge case (or a missing filter). Loading individual, already-known vault addresses (`Vault.load`) works fine regardless.

**Why this reads as two different claims about the same topic (asked, worth answering plainly):** an earlier version of this doc said "we can get vault addresses without scraping" — that was about *individual* vault handling (`Vault.load(address)` works fine once you have an address; Market/CLMM/OrderBook addresses all derive from a *known* vault via PDA) and remains true. What's actually broken is one specific *bulk-discovery path* — `fetchProgramAccountsVault`, which scans for every vault with zero addresses given. Bulk-fetching *markets* instead (below) reaches the same destination — every vault address — through a working path, by reading each market's own embedded `vault` field. Same outcome, different, better route; not a contradiction, just an earlier claim that turned out to need a different mechanism than first assumed.

**The actual answer: bulk-fetch *markets*, not vaults.** Tested `fetchProgramAccountsMarketTwo`/`fetchProgramAccountsMarketThree` directly against the real Helius RPC: **103 legacy AMM markets + 25 CLMM markets, both in under 1.2 seconds combined, zero errors.** Each market account carries its own `vault: PublicKey` field, so collecting the unique vaults referenced across all 128 markets gives **100 unique YT markets — the full current Exponent lineup — without ever calling the broken `fetchProgramAccountsVault`.** Loaded all 100 vaults individually (confirmed reliable) and resolved names via `mintPt` Metaplex metadata (Section 3): **98 of 100 resolved cleanly** — e.g. `PT-ONyc-10SEP26`, `PT-xSOL-07DEC25`, `Exponent PT-fragSOL-31OCT25`, spanning flavors `generic`/`kamino`/`marginfi`/`jitoRestaking`/`perena`. Two edge cases surfaced, worth handling gracefully (skip-and-log, not crash-the-batch): one vault decoded with an "Unknown flavor" (likely a flavor type newer than this SDK build, or a deprecated/test vault), one hit a raw buffer offset-out-of-range error (likely a genuinely different/older account shape). **This decisively answers "can we get the full market list without scraping" — yes, via Market-level bulk fetch.** `fetchProgramAccountsVault`'s own bug is now moot; the real fetcher never needs to call it.

**A real, practical constraint found in the same test: rate limiting.** Looping through 100 sequential `Vault.load` + Metaplex-lookup calls on a *single* connection triggered several `429 Too Many Requests` from Helius (auto-retried, so it still completed, just slower). **Confirms the RPC rotator (Section 7c) is a real requirement for the real fetcher** — spreading ~200+ calls across the 10 rotating `READ_RPC_URLS` keys instead of hammering one avoids this.

### 2. Data Available On-Chain Per Market

Each `MarketTwoAccountData` (legacy AMM, verified against `client/core/types/marketFinancials.d.ts`):
```
financials.expirationTs        → maturity Unix timestamp
financials.lastLnImpliedRate   → ln(implied rate); impliedApy = (Math.exp(lastLnImpliedRate) - 1) * 100
financials.rateScalarRoot      → AMM curve parameter
financials.ptBalance / syBalance → pool balances
vault                           → PublicKey → load vault for underlying APY
mintPt / mintSy (mintYt lives on the Vault, not this account)
```
*(The formula above matches this doc's original hypothesis and the field names are now directly confirmed to exist — the formula itself still hasn't been tested against a live value; see the verification step in section 9.)*

**Each `MarketThreeAccountData` (CLMM) — corrected 2026-07-23, formula corrected again 2026-07-28.** The previous version of this doc claimed a `market.ptApy` property exists on the SDK's `MarketThree` class. **That's wrong — no such getter exists.** The real mechanism is `Ticks.currentSpotPrice`:
```
Ticks.currentSpotPrice        → NOT a natural-log rate despite the "(ln implied rate)" doc annotation on the
                                 Ticks interface -- confirmed via the SDK's own compiled source
                                 (marketThree.d.ts's own @param doc: "Current spot price in format of
                                 1 + percentage / 100"; vaultAssertion.js literally computes
                                 impliedApyDecimal = currentSpotPrice - 1 internally) AND independently
                                 confirmed against bot-engine.ts's own SIMULATE code (already in production):
                                 clmmInitialIY = (clmmInitialSpot - 1) * 100 -- same formula, arrived at
                                 two separate ways.
                                 CORRECT: impliedApy = (currentSpotPrice - 1) * 100
                                 WRONG (an earlier version of this doc/a first-pass test used this):
                                 impliedApy = (Math.exp(currentSpotPrice) - 1) * 100 -- gave absurd 200%+
                                 results on live data before the correction.
Ticks.currentTick             → the active tick (CLMM ticks are keyed by APY, in parts-per-million,
                                 per the SDK's own doc comments on tick-range parameters)
Ticks.currentPrefixSum        → "the active liquidity at the current tick"
Ticks.feeGrowthIndexGlobalPt / feeGrowthIndexGlobalSy → monotonic counters; feed MarketThree.calculateHistoricalFeeApy
                                 and computeFeeInsideForRange, but only meaningfully across two snapshots (see section 8)
```
Fetch `Ticks` via `MarketThree.load(...)` (it loads them automatically) or `Router.fetchClmmsWithTicks(connection, clmmAddresses)`. **Validated 2026-07-28 against real, live data — safe to trust in production.** Computed for all 14 live markets (see Section 10): ONYC's CLMM came out to 14.11% vs. its legacy AMM's independently-confirmed 14.14% (0.03pp apart — plausible, different venues), and every other value landed close to the original screenshot's figures for the same/similar assets (e.g. rkuSOL 6.74% vs. 6.81%, eUSX 6.46% vs. 6.34%, USX 4.88% vs. 5.59%).

Each `VaultAccountData` (verified against `client/core/accounts/vault.d.ts`):
```
startTs + duration              → expiration = startTs + duration
lastSeenSyExchangeRate          → convert to underlying APY:
    underlyingApy ≈ (exchangeRate ^ (365 / daysElapsed) - 1) * 100
mintYt / mintPt / mintSy
```

### 3. Asset Names — decision needed, testing planned together

Confirmed: none of `MarketTwoAccountData`, `MarketThreeAccountData`, `VaultAccountData`, or the Tranching equivalent carry a human-readable name anywhere. Two ways to solve it — **explained in full since this needs a decision, not just a pick:**

**Option A — Metaplex token metadata.** Metaplex is the standard system most Solana tokens (NFTs and fungible tokens alike) use to attach a name, symbol, and image/logo to a token mint. It works by creating a second, linked on-chain account (a "metadata account") next to the mint itself, containing that display info plus usually a URI pointing to a JSON file with a richer description/image. To use it: for each YT mint we discover, look up its metadata account (one extra on-chain read per token) via a library like `@metaplex-foundation/js` (older) or the newer `@metaplex-foundation/umi` toolchain.
- *Pro:* fully automatic — works even for a market added after we last touched this code, no maintenance.
- *Con, and the reason we need to test rather than assume:* **this only works if Exponent actually attached proper metadata to each YT mint when they created it.** Not every project bothers — some tokens exist on-chain with no metadata at all, or a bare/unhelpful one. We don't know yet whether Exponent's mints are well-labeled until we check a real one.
- *Also a cost:* one extra RPC read per token (trivial at ~15-20 assets) and a new dependency to add.

**Option B — a small hand-maintained lookup table.** A plain address → `{name, logo, category}` mapping we update by hand when Exponent adds a new asset — the same pattern the trading-bot project's `config.ts` already uses successfully.
- *Pro:* no dependency on Exponent's metadata quality, nothing to reverse-engineer, and since the discovery functions in section 1 tell us the moment a market address we don't recognize shows up, we can have the system flag "new market found, needs a name" instead of silently missing it — a safety net a purely-automatic approach doesn't need but this one benefits from.
- *Con:* someone has to add the entry by hand (though this happens rarely — new markets don't launch daily).

### Tested 2026-07-23 — real result, not a hypothesis

Ran a live check against 3 real vaults (ONYC, eUSX, BulkSOL — addresses from the trading bot's `config.ts`), deriving each mint's standard Metaplex metadata PDA and reading whatever's actually there:

| Mint | Metadata found? | What's in it |
|---|---|---|
| **`mintYt`** (the one this doc originally assumed we'd look up) | **No** — no metadata account exists at all, for all 3 assets tested | — |
| **`mintPt`** | **Yes — rich** | e.g. name `"PT-ONyc-10SEP26"`, symbol `"PT-ONyc"`, plus a `uri` pointing to a JSON file with (presumably) a logo/description, e.g. `raw.githubusercontent.com/valentinmadrid/exponent-icons/.../ONyc-Income-10SEP26.json` |
| **`mintSy`** | Yes — name only | e.g. name `"Exponent Wrapped ONyc"`, symbol `"wONyc"`, empty `uri` (no logo) |

**This changes the plan in a good way:** Metaplex metadata does exist and is usable — just not on the mint we originally assumed. The fix is simple: look up `mintPt` (rich: name + maturity + logo) with `mintSy` as a lighter fallback (name only), instead of `mintYt`. Since a Vault's `mintYt`/`mintPt`/`mintSy` are all read from the same object anyway, this costs nothing extra. Bonus: `PT-ONyc-10SEP26`'s naming convention lines up almost exactly with the `YT-ONyc-10SEP26` format the existing Gist data already uses (just swap the `PT-`/`YT-` prefix) — minimal downstream changes needed.

**One caveat worth flagging, not blocking:** the logo `uri` points to a GitHub repo under an individual's personal account (`valentinmadrid`), not an Exponent-owned domain — it works today, but it's a third-party dependency outside Exponent's own control, worth keeping in mind as a small reliability risk rather than treating it as guaranteed-stable infrastructure.

**Recommendation:** use `mintPt` metadata as the primary name/logo source (Option A), with the hand-maintained list (Option B) kept as a fallback/override for the rare case a market's PT metadata is missing or wrong — best of both, and no longer a guess.

This same mechanism (Metaplex or hand-maintained list) also solves Tranching Markets' identical naming gap — see `SDK_INTRODUCTION.md` Section 11.

### 4. Leverage Calculation — resolved 2026-07-28, via the API, not the SDK

Superseded by Section 0: Exponent's own site API returns `yieldExposure` directly (e.g. `214.19` for hyloSOL) — this is "Yield Exposure" as shown on the site, no formula to derive or verify ourselves. `Market.marketCalculator()`'s `calc.proportionPtInAsset`-style math (this doc's original hypothesis, from the SDK's `@exponent-labs/market-math` package) remains unread/unverified, but is now moot for the common case — only relevant if we ever need this figure for an asset the API doesn't cover (the RPC-fallback path currently ships `leverage: null` for those, same as before).

### 5. OrderBook Markets — resolved 2026-07-28, no maintained list needed after all

Originally flagged as needing a maintained list. **Resolved, then confirmed live**: the OrderBook (and legacy Market, and CLMM) address is a PDA derivable directly from a vault address — `ExponentOrderbookPDA.orderbook({vault, seedId})`, `ExponentPDA.market({vault, seedId})`, `ExponentCLMMPDA.market({vault, seedId})` respectively, each from their own `@exponent-labs/exponent-*-pda` package. **Tested live against ONYC (2026-07-28): `seedId: 0` derived `EkMwpJy1hm1FtCaTH7WFRkvbEXeFd5Sw4EnCpRKvv1fN` — an exact match for ONYC's real, known OrderBook address.** So once Vaults are known (bulk-discovered or individually loaded), all three venue addresses can be computed locally for free and existence-checked — no lookup list needed for addresses. (A config file is still useful for names/logos/points-per-day — see the new asset-registry design below — just not for addresses.)

### 6. Historical Snapshots — new requirement identified 2026-07-23

Several of the *best* CLMM and Tranching analytics (fee APY over time, TVL over time, coverage-ratio-over-time charts — see `SDK_INTRODUCTION.md` Sections 7 and 11) are explicitly designed to compare **two snapshots taken at different times**, not a single live read. Today's Gist only holds the latest snapshot; getting these richer stats means keeping a **history** of snapshots somewhere. Options: additional dated files in the same Gist, a small database, or Cloudflare KV/D1 if we end up on Cloudflare Workers anyway (see Scheduling section). Not required for the basic market-list migration — only for the richer historical charts, which can be a later addition.

### 6b. Live test results against real ONYC data (2026-07-28)

Ran the actual SDK against ONYC's real on-chain accounts (via the trading bot's own Helius RPC, copied into `server/.env`). Numbers for you to cross-check against Exponent's live site at the same moment:

**Vault:** `currentSyExchangeRate` = 1.12845329, `expirationDate` = 2026-09-10T09:58:19Z.

**Market (legacy AMM):** `ptApy` = 14.127%, `ptApr` = 13.320%, `currentPtPriceInAsset` = 1.01604, `ptDiscount` = 0.98422, `secondsRemaining` ≈ 3,796,835s (~44 days), `feeTreasuryBps` = 2000 (20%). `toJson()` ran fine and returned the full object (fees, LP data, vault sub-object, flavor, CPI accounts, etc.) — no surprises in shape.

**MarketThree (CLMM):** loaded successfully in 510ms including network time — `secondsRemaining` matches Market's (as expected, same maturity), `feeTreasuryBps` = 3500 (35%, notably higher than the AMM's 20% — worth double-checking this is really a per-venue fee difference and not a units mismatch when we implement this for real), `ptBalance`/`syBalance` populated.

**Retested `fetchProgramAccountsVault` against the real Helius RPC — still failed, same error, correcting the earlier hypothesis.** See the updated note in Section 1 above — this is not a free-RPC-quality issue, it reproduces on a paid endpoint too, so it needs real investigation before we depend on it.

### 6c. Yield-drop timing — investigated live against ONYC's vault, real evidence found

Pulled ONYC vault's last 20 transaction signatures: all 20 landed within a **~25-minute window**, roughly one every 1-2 minutes — this account is touched constantly, not sparsely. Read the actual program logs of the most recent one, and it's revealing: it's a Kamino-related batch of `RefreshPriceList` → `UpdatePrice` (×7) → `RefreshReservesBatch` (explicitly logging `"Token: ONyc Price: 1.1285"`, matching the Vault's `currentSyExchangeRate` almost exactly) → `RefreshObligation` → `RefreshAum`. Program ID `KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD` is Kamino Lend's own program — **confirming ONYC's underlying yield source is a Kamino lending position**, and that its price/value gets refreshed by frequent keeper/crank transactions (several times within a 25-minute span in this sample), not one discrete daily event.

**What this suggests, held at appropriate confidence given the short sample:** Kamino lending interest typically accrues continuously (compounding roughly per-slot), refreshed on-chain whenever a crank runs — which looks, from this transaction pattern, like every few minutes, not once a day. If that holds up over a longer sample, **there may not be a single discrete "yield drop" moment for ONYC's rate to catch at all** — the rate creeps up continuously and gets refreshed frequently, rather than jumping once at a fixed time. That would mean the bot's `yieldDropTimeUtc="00:00"` isn't describing this same signal — it's more likely describing a different, empirically-observed pattern (e.g. in trading/liquidity behavior around a particular time) rather than the underlying SY rate update itself. This is a genuinely new, evidenced finding, not yet a fully settled one — a longer historical sample (spanning several days, watching specifically for `lastSeenSyExchangeRate` value changes rather than all transaction activity) would be needed to rule out a daily pattern entirely, but the frequent-refresh evidence above points away from one.

### 6d. CPU-time profiling — first pass, promising but partial

Profiled 100 repeated calls of `Market.toJson()` + a couple of getters (post-load, i.e. NOT including the RPC fetch or the raw account-byte decode step): **0.57ms per market at steady state** after JIT warmup (the very first call cost ~3ms — a one-time cost, not per-market, since a real batch processing many markets in one invocation would warm up during the batch rather than pay that cost repeatedly). At 0.57ms × ~15-20 markets ≈ 8.5-11.5ms, this is right around Cloudflare's 10ms free-tier ceiling **for this one piece alone** — and **this profile does not include decoding the raw bytes** `getProgramAccounts`/`fetchProgramAccountsX` would return, which is a separate, likely non-trivial cost not yet measurable until the Section 1 decode issue is resolved (can't profile decoding raw bulk-fetch bytes when the bulk fetch itself doesn't work yet). Honest read: promising, but not a green light yet — the full pipeline (raw bytes → decoded object → computed values) needs profiling once Section 1's bug is sorted out, before trusting Cloudflare's free tier for the "Exponent does its own compute" option.

### 7. Full Implementation Plan

Now grounded in the actual current architecture (per the 2026-07-23 architecture review) and your 2026-07-28 feedback, not the old single-server assumption this section originally described:

1. **Keep as-is:** the GitHub Gist as storage (the frontend reads it directly via `ratexApi.ts` — zero frontend changes needed), RateX scraping (`scraper.js`, different platform, out of SDK scope, unchanged scheduling too) — xSOL/CR metrics (`scraper-xsol-phase0.js`, `cr-monitor.js` — unrelated to Exponent SDK).
2. **Built and tested 2026-07-28, revised same day after Section 0's discovery — the real replacement for `scraper-exponent-playwright.js` is now two files working together:**

   - **`server/fetch-exponent-api.js` (primary).** Fetches `https://app.exponent.finance/api/markets` (one HTTP call), maps each active entry straight to the Gist schema — `impliedApy`, `underlyingApy`, `yieldExposure`, and `pointsBoost.points_per_day` used directly, no on-chain reads at all. **Tested end-to-end 2026-07-28: 12 assets from the API in 0.36 seconds**, correct shape, values cross-validated against both the live screenshot (hyloSOL Underlying APY: computed `5.87%` vs. displayed `5.87%`) and our own RPC-derived Implied APY (hyloSOL: `12.085%` vs. `12.09%`).
   - **`server/fetch-exponent-rpc.js` (whole-response fallback only, per your explicit correction).** Still fully built and working (`fetchAllExponentAssetsRpc()`, full CLMM-anchored discovery) — but now only invoked when the API call itself fails or returns zero active markets, never to backfill individual known assets missing from an otherwise-healthy response. The three assets an earlier per-asset-fallback design recovered (`kUSDC-10AUG26`, `srONyc-14NOV26`, `USD.tel-05DEC26`) turned out not to be needed, so that per-key fallback path (`fetchAssetsForKnownKeys`) was removed rather than kept as unused code.

   **Two things surfaced earlier while building/testing the RPC path — relevant only on the rare full-outage fallback, not the normal case:**
   - **`downsideRisk` can come out negative** (saw `-106.89` for hyloSOL, before the API path existed). Root cause: the existing scraper's own convention sets `rangeLower = apy` (Underlying APY) as a stand-in "worst case" input to `calculateYtMetrics` — this assumes Underlying APY is always *below* Implied APY. That's not guaranteed; when Underlying APY exceeds Implied APY, the "lower" price ends up higher than the "current" price and the downside-risk math inverts. **This is the existing scraper's own convention, faithfully carried over, not a new bug.**
   - **The RPC-only Underlying APY formula (`currentSyExchangeRate` annualized over days-since-inception) is confirmed wrong** — see Section 0. Only relevant if the API is genuinely down and the full RPC fallback is doing the whole job; in that scenario Underlying APY quality regresses until the API recovers. Accepted as a known limitation of the outage path, not something to fix, since the API is the intended long-term source for this figure.

   Displayed/alerted Implied Yield is CLMM's specifically (confirmed, formula verified, and now independently cross-validated by the API). Legacy AMM and OrderBook addresses come straight from the API response (`legacyMarketAddresses[]`/`orderbookAddresses[]`) in the normal case, or via PDA derivation in the RPC fallback.

   **Done 2026-07-28: wired into `scrape-once.js`.** Phase 1's `scrapeAllExponentAssets()` (Playwright) call replaced with `fetchAllExponentAssetsWithFallback()`. Since the API/RPC output already includes precise maturity and `assetBoost` — the only two things Exponent's old Phase 2 detail-page scrape ever added — **Exponent's entire Phase 2 step was removed**, along with the Playwright browser launch/teardown it required (RateX's own Phase 2, on Puppeteer, is untouched). Verified by running the actual Phase 1 validation/merge logic (APY/assetBoost/visual-asset overrides, YT-metrics recalculation) against real fetcher output with an empty prior Gist and no RateX match (the null-heaviest case) — all 12 assets processed with no errors. **Not run against the real Gist/RateX/alert endpoint** — that's a live, shared-state action (writes the production Gist, scrapes RateX for real, can trigger real Telegram alerts), left for you to run deliberately rather than as a side effect of this change.
   - **One pre-existing edge case surfaced, not introduced by this change:** `calculateYtMetrics` (in `scraper.js`, untouched) returns `downsideRisk: undefined` rather than a number when `apy` (Underlying APY) is exactly `0` — true today for `USX-16SEP26`, `hyUSD-12AUG26`, `hyloSOL+-12AUG26`, `xSOL-12AUG26` (all four show `underlyingApy: 0` in the live API response right now, plausibly because these vaults' base yield is genuinely ~0% or not yet computed by Exponent's own backend). Existing behavior of a shared function, not something to silently fix here.
   - **CI cleanup, done 2026-07-28:** removed the now-unused `npx playwright install chromium --with-deps` step from `.github/workflows/scrape-ratex.yml` — nothing in `scrape-once.js` imports Playwright anymore. Local edit only, not yet pushed (see below).
3. **Simplify:** the current Phase 1 (fast cards) / Phase 2 (slow detail pages) split existed because browser rendering was slow. The API fetch is now sub-second — the Phase 1/2 split, and the "write to the Gist 3 times per run" pattern, likely collapses to one pass, one write. Worth confirming once wired into `scrape-once.js`.
4. **New pieces:** the API-primary fetcher (Section 0), the RPC path (now a whole-response outage fallback only — Section 7b's discovery pipeline, name-resolution via `mintPt` from Section 3), the asset-registry config file (below — now mainly a fallback vault list + hand overrides, not the primary source of truth it was originally designed as), an RPC rotator (below). Snapshot-history store (section 6) and CR-check consolidation are both explicitly deferred, per your call.
5. **Deferred, per your call:** `api/cr-check.js`'s duplication of `server/cr-monitor.js`'s CR logic — you've noted the CR system itself is somewhat in flux separately, so this is pushed to a future phase rather than bundled into this migration.

### 7b. Asset-registry config file — rebuilt 2026-07-28, now CLMM-anchored with real, full discovery

**Redesigned per your direction: discovery now starts from CLMM markets specifically**, not a bulk vault/market scan of everything. Flow, fully live-tested:

1. `fetchProgramAccountsMarketThree` — bulk-fetch every CLMM market (25 found).
2. **Filter to non-expired** (`financials.expirationTs > now`) — 15 remain. This is a client-side filter; **confirmed there's no way to ask the RPC to do this for us** (see the dedicated note below — Solana's `getProgramAccounts` only supports exact-byte-match filters, not numeric range comparisons, so "only give me non-expired ones" isn't something the server can do).
3. **A second filter was needed, discovered live, not anticipated up front: non-expired isn't the same as actually active.** One of the 15 (an extra CLMM market for ONYC's vault, at a different internal `seedId` than the real one) had `statusFlags: 0` and zero `ptBalance`/`syBalance` — an empty shell account, not a real market anyone can trade. Added a second filter (`ptBalance > 0 || syBalance > 0`) → **14 genuinely live, active markets remain.** Recommend requiring both conditions in the real fetcher, not just expiry.
4. For each of the 14, get the market's own `vault` field (no separate vault bulk-fetch needed — sidesteps `fetchProgramAccountsVault`'s bug entirely, see Section 1), load the vault, resolve its name via `mintPt` metadata, and **derive + existence-check both the legacy AMM and OrderBook addresses via PDA** (Section 5) from that same vault.

**Result — real, current, complete, 2026-07-28:** 14 live markets: `hyloSOL`, `xSOL`, `hyUSD`, `eUSX`, `rkuSOL`, `bulkSOL`, `kUSDC`, `stSLX`, `ONYC`, `hySOL+`, `srONyc` (**twice — see below**), `USD.tel`, `USX`. **Every single one of the 14 has `marketAddress: null`** — no legacy AMM exists for any currently-live market. This is a clean, concrete confirmation of the v1→v2 shift: current markets are 100% CLMM(+OrderBook where present), zero legacy AMM among them. (One caveat: this only tells us "none found at `seedId: 0`" — plausible it's genuinely absent rather than at a different seed, given how recent these markets are, but not 100% ruled out.)

**Multi-maturity, tested against a real case.** `srONyc` has **two simultaneous live maturities** (`14NOV26` and `10SEP26`) — a genuine case, not a data artifact (confirmed by checking their distinct vault/CLMM addresses). Per your instruction, the registry key is now **`{baseSymbol}-{maturityCode}`** (e.g. `"srONyc-14NOV26"`, `"srONyc-10SEP26"`) instead of a bare token symbol, and each key gets its **own full copy of `static`** — so when a new maturity of an existing token appears, it's a new key with duplicated `static` fields, never a collision or an overwrite. (First pass at this used a bare `symbol-maturity` key without the activity filter and *did* silently overwrite one real entry with the empty-shell one — exactly why the activity filter above matters.)

```jsonc
{
  "ONyc-10SEP26": {
    "static": { "displayName": "ONYC", "rawName": "PT-ONyc-10SEP26", "logo": null, "category": "USD", "flavor": "generic", "pointsPerDay": null },
    "maturity": { "vaultAddress": "...", "clmmAddress": "...", "marketAddress": null, "orderbookAddress": "...", "maturityDate": "2026-09-10" }
  },
  "srONyc-14NOV26": { "static": { "displayName": "srONyc", ... }, "maturity": { ..., "maturityDate": "2026-11-14" } },
  "srONyc-10SEP26": { "static": { "displayName": "srONyc", ... }, "maturity": { ..., "maturityDate": "2026-09-10" } }
}
```
`static` (renamed from the earlier design's single-token-keyed version) is still exclusively hand-edited; `maturity` (renamed from `currentMaturity`, since "current" no longer implies singular-per-token) is what auto-refresh would touch when a market rolls to a new maturity — appending a new key rather than overwriting, and never deleting an old one until it's actually expired.

**A parsing detail worth knowing:** name-extraction regex needed widening mid-test to allow `.` in symbols (`"USD.tel"` broke the first version) — a reminder that Exponent's naming isn't perfectly uniform (`"PT-X-..."` vs `"Exponent PT-X-..."` prefixes both appear) and the real fetcher's parser should stay permissive rather than assume a fixed format.

**OrderBook coverage, confirmed at the new, full scale:** 10 of 14 have one, 4 don't (`stSLX`, `srONyc-14NOV26`, `USD.tel`, and — from the earlier 4-token check — `eUSX` was the exception then, now resolved as having none at the current maturity checked). Confirms "not every asset has all three venues" with real, current, comprehensive data rather than a 4-token sample.

### Is there a way to ask the RPC for only non-expired markets?

**No — checked directly, this isn't just an SDK gap.** `fetchProgramAccountsMarketThree`/`MarketTwo` only accept `{commitment}` as an option. More fundamentally, Solana's `getProgramAccounts` RPC method only supports exact-byte-match (`memcmp`) filters, not numeric range/comparison filters — there's no way to ask "give me accounts where this timestamp field is greater than X." Expiry is just a stored value compared against wall-clock time at read time, not a flag the program flips, so the only way to get "live only" is to fetch everything and filter client-side afterward (as done above) — same RPC cost either way, just a filter step after decoding.

### 7c. RPC handling — done 2026-07-28

`server/.env` has the trading bot's read RPC URLs (10 rotating Helius endpoints via `READ_RPC_URLS`, plus a primary `RPC_URL`). **`server/rpcRotator.js`** is built and live-tested — a direct port of the bot's `RpcRotator` class (`bot-engine.ts`) and its `READ_RPC_URLS` comma-split parsing (`runner.ts`), exposing `createReadRotator()` (round-robins the full pool, used for anything doing many reads) and `getPrimaryConnection()` (a single connection off `RPC_URL`, for one-off calls). Confirmed working against the real endpoint (fetched a live current slot). Uses `dotenv` (newly added to `server/package.json`) to load `.env`, matching the bot project's own convention.

### 8. Cleanup opportunities (found during the 2026-07-23 architecture review, not blocking anything)

Confirmed dead/orphaned (not imported by any live entry point): `server/scraper-exponent.js`, `scraper-exponent-simple.js`, `scraper-exponent-phase1.js`, `scraper-xsol-metrics.js` (duplicate of `scraper-xsol-phase0.js`), `scrape-and-update.js`, `scrape-with-phase0.js`, `analyze-exponent-card.js`, `debug-exponent-card.js`, `debug-exponent-html.js`, the ~25 `server/test-*.js` files, `server/index.js` (a standalone RateX-only REST API nothing currently calls — its own `server/vercel.json`/`railway.json`/`nixpacks.toml` deployment targets are also disconnected from the live product), and `src/services/manualRefresh.ts` (an earlier, superseded draft of the same idea now living in `ratexApi.ts`). Also genuinely empty/junk: `suggestions/` (dir, had content once, deleted), `txt.txt`, `COMPLETE_SETUP_GUIDE.md`, `install-dependencies.bat`. None of this blocks the migration — worth a pass once we're actively touching this code, not before.

### 9. Pros vs Playwright (updated 2026-07-28 for the API-primary + RPC-fallback design)

| | Playwright (current) | API-primary + RPC-fallback (planned) |
|---|---|---|
| Bot detection risk | Medium (Vercel can tighten) | None — confirmed the API endpoint isn't behind the same Vercel checkpoint as the HTML pages |
| Speed | ~30-60s (browser) | Sub-second for the ~80% of assets the API covers; ~8s total including RPC fallback for the rest (measured, 15 assets) |
| Asset name discovery | Automatic (HTML) | Automatic — API returns `tokenName`/`underlyingAsset.name` directly; Metaplex/maintained-list (section 3) only exercised by the RPC fallback |
| Points per day | Available (scraped) | **Mostly automatic** — API's `pointsBoost.points_per_day` (Section 0); registry override only for the cases it's `null` |
| Yield Exposure / leverage | Not previously scraped | **Automatic** — API's `yieldExposure` field (Section 0/4), no formula needed |
| Underlying APY | Not previously scraped | **Automatic and correct** — API's `underlyingApy` (Section 0), matches a live screenshot exactly; our own on-chain formula was confirmed wrong and is now fallback-only |
| Full market list | Automatic (whatever's on the page) | API covers 12/15 known live markets automatically; RPC bulk-fetch (section 1) — **128 markets, 100 unique vaults, 98 named** — fully covers the rest as fallback |
| HTML/UI dependency | Yes (breaks on v1→v2 redesign) | No — but the API endpoint itself is undocumented/reverse-engineered, a different (lighter) version of the same fragility |
| Setup complexity | Low | Medium |
| Runtime reliability | Medium | High for the API's coverage, High (verified) for the RPC fallback |

### 10. Verification checklist before shipping (updated 2026-07-28)

- [ ] Compare the live ONYC numbers in Section 6b (`ptApy` = 14.127%, etc.) against Exponent's site at the same moment — **you check this, numbers are ready above.**
- [x] Underlying APY — **done 2026-07-28, resolved via the API, not our own on-chain formula** (Section 0): `underlyingApy` matches your hyloSOL screenshot (`5.87%`) essentially exactly. Our own `currentSyExchangeRate`-since-inception formula is confirmed wrong (gave `25.14%`) and is no longer used for any asset the API covers — only the RPC-fallback path for gap assets still relies on it, a known, scoped-down limitation.
- [x] Pick one live CLMM market, compute `impliedApy` from `Ticks.currentSpotPrice`, compare the same way — **done 2026-07-28, and the first formula tried was wrong.** `(Math.exp(currentSpotPrice) - 1) * 100` gave absurd 200%+ results. Correct formula, confirmed two independent ways (the SDK's own internal `vaultAssertion.js` code, and bot-engine.ts's already-proven SIMULATE logic): `(currentSpotPrice - 1) * 100`. ONYC's CLMM: 14.11%, vs. its legacy AMM's confirmed-correct 14.14% — 0.03pp apart. All 14 live markets recomputed and land close to the original screenshot's values for the same/similar assets.
- [x] Leverage/"Yield Exposure" — **done 2026-07-28, resolved via the API rather than the SDK**: `yieldExposure` field returned directly (Section 0), no formula needed. `MarketCalculator.proportionPtInAsset` remains unread — only relevant for the RPC-fallback path's gap-fill assets, which currently ship `leverage: null`.
- [x] Run the Metaplex metadata check from section 3 against real mints — **done 2026-07-23**, see section 3 for the result (use `mintPt`, not `mintYt`).
- [x] Re-test `fetchProgramAccountsVault` against a real dedicated RPC endpoint — **done 2026-07-28: still fails, same error, on Helius too** — but moot: bulk-fetching *markets* instead (`fetchProgramAccountsMarketTwo`/`Three`) and reading each market's own `vault` field gives the full list of 100 vaults with zero errors — see Section 1's updated note.
- [x] Confirm full market/vault discovery end-to-end with real names — **done 2026-07-28: 128 markets (103 AMM + 25 CLMM) → 100 unique vaults → 98 resolved names via `mintPt` metadata**, in under 1.2s for the bulk-fetch step. 2 individual-vault edge cases (unknown flavor, malformed account) — handle gracefully, don't block on them.
- [x] Confirm OrderBook's `seedId` — **done 2026-07-28: `seedId: 0` confirmed exact match for ONYC** (see Section 5).
- [ ] Profile the full raw-bytes-to-JSON pipeline for CPU time (Section 6d only covered the post-decode portion) — blocked until Section 1's decode bug is understood, since that's the same decode path.

### 11. RPC Endpoint

**Now using the trading bot's actual Helius RPC** (copied into `server/.env`, 2026-07-28 — see Section 7c), not the free public endpoint originally suggested here — the free public endpoint's `getProgramAccounts` limitations turned out not to be the whole story (Section 1), but individual-address loads work identically well on either, and the real endpoint is what all live numbers in this document come from. The bot project's `rpc.ironforge.network` endpoint remains a second option if needed. Store credentials as a secret (GitHub Actions secret today; a Cloudflare Worker secret if we move compute there — see Scheduling section) — never commit `server/.env` (already gitignored).

---

## 📋 Planned: Scheduling & Deployment Rework

### What's actually running today (verified 2026-07-23, corrects some assumptions)

- The cron in `.github/workflows/scrape-ratex.yml` runs **every 5 minutes** (`*/5 * * * *`), not every 10.
- There is no single circular "loop" — there are two separate trigger paths. **Path A (informational):** after every scrape, `scrape-once.js` calls a Vercel endpoint that sends Telegram yield alerts — this never re-triggers GitHub Actions. **Path B (the actual re-trigger mechanism):** visiting the site checks if the Gist is >10 minutes stale and, if so, calls GitHub's `workflow_dispatch` API directly from the browser.

### ⚠️ Security issue found, bundled into this rework per your call — fixed 2026-07-28

Path B's re-trigger (`triggerWorkflowRefresh()` in `src/services/ratexApi.ts`) read a client-side env var, `VITE_GITHUB_WORKFLOW_TOKEN`. Vite bundles every `VITE_*` variable into the public JS shipped to browsers — a GitHub token with workflow-dispatch rights was sitting in the site's source, extractable by anyone.

**Fixed:** `triggerWorkflowRefresh()` and `checkAndRefreshIfStale()` removed entirely from `ratexApi.ts` (not just left unused — the token-reading code path is gone), along with their call sites in `src/pages/Home.tsx` and `src/pages/StrategyDashboard.tsx`. The Hylo Exponent Worker (`workers/`, below) now triggers `scrape-ratex.yml` reliably every 5 minutes server-side via a `GITHUB_WORKFLOW_TOKEN` Worker secret — never shipped to a browser, and no longer dependent on a visitor happening to load the page while data is stale. `tsc -b` clean after the removal. Also deleted `src/services/manualRefresh.ts` — an unused, never-imported file (confirmed via repo-wide grep) containing the *same* anti-pattern with a second exposed token (`VITE_GITHUB_TOKEN`) — no reason to leave a dead copy of the exact issue just fixed lying around.

### Why GitHub Actions alone isn't fully reliable (this is the "sometimes delays" you already noticed, quantified)

- GitHub explicitly documents that scheduled runs are "eligible to run," not guaranteed — during busy periods (commonly the top of every hour) delays of 5-30 minutes are typical.
- Separately, **GitHub auto-disables a scheduled workflow entirely after 60 days with no commits to the default branch** — a harder failure mode than a delay; it stops firing until someone notices and re-enables it.
- Vercel's own native Cron Jobs can't replace this on the free (Hobby) tier — Hobby caps at **once per day minimum**, with timing only guaranteed within the hour. So the original choice to use GitHub Actions instead of Vercel Cron wasn't a mistake — Vercel's free tier genuinely can't do 5-minute updates.

### Cloudflare Workers Cron Triggers — the detailed breakdown you asked for

- **Is it free?** Yes. Free tier: **100,000 requests/day**, up to **5 Cron Triggers per account** (3 per individual Worker), reset at midnight UTC.
- **Will it run every 5 minutes? Any limit on that?** Yes, cleanly — the minimum granularity is **1 minute**, so a `*/5 * * * *` schedule is well within range. At 5-minute intervals that's 288 runs/day — nowhere close to the 100k/day request cap, so the request quota is a non-issue for this use case.
- **The real limit to know about: CPU time, not request count.** Free tier caps each invocation at **10ms of CPU time**. This sounds tiny, but the important nuance is that Cloudflare only counts *active JavaScript execution* against this limit — time spent waiting on a network response (like an RPC call or a GitHub API call) does **not** count. So a Worker whose job is mostly "wait for a response, then do a little bit of work with it" can comfortably fit in 10ms; a Worker doing heavy computation across many markets' worth of data might not. This is genuinely worth testing directly rather than assuming either way before committing to using Cloudflare as the actual compute layer.
- **Paid tier**, if the 10ms limit turns out to bite: $5/month raises the cap to 30 seconds (or 15 minutes for hourly-or-slower schedules) — no longer strictly free, so only relevant if the free tier genuinely doesn't fit.

**Decided — both, split by data source, not an either/or:**

- **RateX (smaller lift): unchanged compute, reliable trigger only.** Stays on GitHub Actions' existing 5-minute cron for the actual scrape; a Cloudflare Worker's only job is calling `workflow_dispatch` reliably on that schedule — a single outbound call, essentially no CPU time, safely within the free 10ms regardless of the CLMM-compute question above. Replaces both the flaky native GH trigger and the insecure browser-side one. GitHub Actions isn't dropped — RateX's Puppeteer scraper still needs a real browser environment.
- **Exponent (bigger lift): moves to Cloudflare entirely, targeting 1-minute cadence.** Important technical fact: GitHub Actions' native `schedule:` cron has a documented **minimum interval of 5 minutes** — 1-minute cadence isn't just unreliable there, it's not natively possible. Cloudflare Workers Cron Triggers support 1-minute granularity natively. So a separate Worker runs every minute, does the RPC fetch/compute for Exponent directly, writes to the same Gist, and runs the yield-alert check — no GitHub Actions involved. Needs Section 6d's CPU-time question fully resolved first.
- **Live-on-visit fetching — deprioritized per your call, 2026-07-28.** The original idea was: when someone loads the site, also fetch fresh Exponent data directly at that moment. **Decided: not required** — a reliable 5-minute RateX trigger plus the Worker's own 1-minute Exponent cadence is considered sufficient freshness for now. Moved to Future Phases at the end of this document; revisit only if the 1-minute cadence turns out not to be fresh enough in practice.

### ✅ Built and locally tested 2026-07-28: `workers/` — the Hylo Exponent Worker

**One consolidation worth flagging: a single Worker, not two.** The plan above describes RateX-trigger and Exponent-compute as if they might be separate Workers — they don't need to be. Cloudflare's free tier allows up to 3 Cron Triggers *per Worker*, so one Worker with two schedules (branching on `event.cron` in its `scheduled()` handler) does both jobs with one deployment, one `wrangler.toml`, one set of secrets. Simpler to manage, same functionality.

**A second, more consequential decision: `server/scrape-once.js` is left completely unchanged, not stripped down to RateX-only.** The original framing ("Exponent moves to Cloudflare entirely, no GitHub Actions involved") would mean removing Exponent from `scrape-once.js` — but that removes the only remaining automated path to the RPC/SDK fallback (`fetch-exponent-rpc.js`) for a genuine, extended Exponent API outage, since the new Worker deliberately doesn't carry that fallback (see below). Keeping `scrape-once.js` exactly as-is means: the Worker adds *faster* Exponent updates (1-minute) on top of the existing 5-minute GH Actions cadence, and if the Worker ever silently stopped working entirely, the site degrades to the pre-Worker 5-minute cadence rather than going stale forever. Both writers touch the same Gist file safely because each only ever replaces its *own* source's entries (`source: 'exponent'` vs. everything else) — see the merge function below.

**Structure:**
```
workers/
├── wrangler.toml          Worker config: 2 cron triggers, GIST_ID var, secrets documented (not stored)
├── package.json            wrangler as the only devDependency
└── src/
    ├── index.js             scheduled() handler, branches on event.cron; fetch() is a health check
    ├── exponent-fetch.js     Workers-port of fetch-exponent-api.js's API-primary path — deliberately
    │                          API-only, no RPC/SDK fallback (avoids bundling @solana/web3.js +
    │                          @exponent-labs/exponent-sdk into a Worker for this first cut — see below)
    ├── yt-metrics.js          Verbatim port of scraper.js's calculateYtMetrics/calculateMaturesIn/
    │                          calculateDaysToMaturity + their calculateYtPrice/calculateYtPriceExponent/
    │                          formatPercentage/formatYtPrice helpers — all pure Date/Math, zero Node
    │                          APIs, confirmed to run unmodified under both plain Node and workerd
    ├── gist.js                Authenticated GitHub API read/write (not the public raw URL, to avoid
    │                          any CDN cache lag on the read side of a read-modify-write cycle) +
    │                          mergeExponentAssets(), which replaces only source==='exponent' entries
    ├── github-trigger.js      Server-side port of triggerWorkflowRefresh() — same endpoint/payload,
    │                          reads env.GITHUB_TOKEN (a Worker secret) instead of a bundled client var
    ├── yield-alert.js         Server-side port of scrape-once.js's triggerYieldAlertCheck() — a plain
    │                          GET to the existing Vercel endpoint, called after every successful
    │                          Gist update so the 1-minute Exponent job gets the same Telegram/email
    │                          alert coverage the 5-minute RateX+Exponent run always had
    └── asset-registry.json   Bundled copy of server/asset-registry.json, imported as a JSON module
                               (`with { type: 'json' }`) for the static-field overrides (displayName/
                               logo/pointsPerDay) — static-at-deploy-time is an acceptable tradeoff
                               since these fields are hand-edited rarely; redeploy to pick up changes
```

**Why no RPC/SDK fallback inside the Worker:** `fetch-exponent-rpc.js` needs `@solana/web3.js` + `@exponent-labs/exponent-sdk`, which adds real bundling-compatibility risk (Node-API-shaped internals, WASM, etc.) for a first Workers cut. Since `scrape-once.js` already covers a full API outage on its own cadence (see above), the Worker's job stays simple: on API failure or an empty response, skip that minute's update entirely (log a warning, touch nothing) — the exact same graceful-degradation shape already used for xSOL Phase 0 in `scrape-once.js` ("preserve existing metrics from Gist" on failure), not a new pattern.

**One GitHub token, reused, per your call.** `gist.js` and `github-trigger.js` both read the same `env.GITHUB_TOKEN` secret rather than two separate ones — this single PAT needs both `gist` scope (Gist read/write) and `workflow` scope (the dispatch trigger). If the existing `GIST_TOKEN` GitHub Actions secret already has `workflow` scope too, the exact same token value works here — no new token to create. If not, generating one classic PAT with both scopes checked (see the deployment steps below) replaces two.

**Tested locally, 2026-07-28, via `wrangler dev --test-scheduled` (no real deploy, no real secrets, nothing written to the production Gist):**
- The Worker bundles and boots cleanly under `workerd` — confirms the JSON-module import and all-ESM module graph are compatible, not just a Node assumption.
- `fetch()` handler responds `200 OK`.
- Triggering the Exponent cron (`curl .../cdn-cgi/handler/scheduled?cron=*+*+*+*+*`) correctly routed to `runExponentUpdate()`, which made a real network call to the GitHub API and failed with `401 Bad credentials` — expected and correct, since no `GITHUB_TOKEN` secret is configured locally; the error was caught and logged, not an unhandled crash. (`triggerYieldAlertCheck()` is never reached in this test, since the Gist call fails first — deliberately not tested against the real Vercel endpoint, since a successful call there can send real Telegram/email alerts to real subscribers.)
- Triggering the RateX-trigger cron (`cron=*/5+*+*+*+*`) correctly routed to `triggerRateXWorkflow()`, same real-network-call-then-graceful-401 result.
- Re-ran both of the above after the token-consolidation and yield-alert changes — identical, correct behavior.
- Separately, `exponent-fetch.js` + `gist.js`'s merge logic were run directly under plain Node (real Exponent API call, a fake existing-Gist object with one RateX + one stale Exponent entry): confirmed the RateX entry survives untouched, the stale Exponent entry gets replaced, and `xsolMetrics` is preserved — 12 real assets fetched, matching the same live numbers already validated in the `fetch-exponent-api.js` section above (hyloSOL implied 12.09%, underlying 5.87%).

**Bug found on first real deploy, 2026-07-29: missing asset icons.** Once actually deployed, Exponent asset cards started showing a bare-letter placeholder instead of real icons. Confirmed live via the raw Gist: the Worker's `YT-hyloSOL-12AUG26` entry had `projectBackgroundImage: null` / `assetSymbolImage: null`.

**First pass — a stopgap, not the real fix, correctly called out as such:** added `enrichVisualAssets()` to `gist.js`, falling back to a RateX entry for the same `baseAsset` (rate-x.io's own icon for a different platform's PT/YT representation of the same underlying asset), then the previous Gist entry, then `null` — mirroring `scrape-once.js`'s own fallback chain. This got icons showing again, but it begged the obvious question: **why isn't Exponent's own icon being used for an Exponent-sourced record?**

**Real root cause, traced end-to-end 2026-07-29:** Exponent's site API (Section 0) has no icon/image field anywhere in its schema — confirmed by re-reading the full field list. The actual icon lives on-chain: the `mintPt` token's Metaplex metadata has a `uri` pointing to a JSON file, whose `image` field is the real SVG. Verified live for hyloSOL: `mintPt` metadata → `uri: https://raw.githubusercontent.com/valentinmadrid/exponent-icons/refs/heads/main/hyloSOL-Income-11AUG26.json` → that JSON's `image: https://raw.githubusercontent.com/valentinmadrid/exponent-icons/refs/heads/main/PT-hyloSOL.svg`. **Tried guessing this URL directly from the token symbol first** (`PT-{symbol}.svg`, skipping the JSON hop) — only matched 5 of 10 assets tested, so it's genuinely not derivable without resolving the real metadata chain per-asset.

**A second finding along the way, worth knowing:** re-running discovery across all 14 live markets showed Exponent has been migrating icons *off* the third-party `valentinmadrid` GitHub repo and onto their own `cdn.exponent.finance` domain for newer assets (`rkuSOL`, `BulkSOL`, `kUSDC`, `srONyc`, `USD.tel` all resolved to `cdn.exponent.finance/pt-tokens/...`) — meaning the third-party-dependency risk flagged back in Section 3 is shrinking over time, not growing.

**The real fix:** `server/fetch-exponent-rpc.js`'s `getPtMetadata(connection, mintPt)` (renamed/expanded from the old name-only `getPtName`) now resolves both the display name and the icon in one on-chain read — parsing Metaplex's `uri` field alongside `name`, then fetching that URI's JSON for `image`. `discoverLiveMarkets()` now sets `staticFields.logo` from this (hand-set registry values still always win first). Ran a full discovery pass: **all 14 live markets resolved a real, verified-resolving icon URL** — `asset-registry.json` updated and synced into `workers/src/asset-registry.json`.

**Worker-side priority fixed to match:** `enrichVisualAssets()` now only applies its RateX/old-Gist fallback when `projectBackgroundImage` is still empty after `exponent-fetch.js`'s own registry-based lookup — so Exponent's own icon wins whenever the registry has one, and the RateX/old-Gist chain is purely a gap-filler for assets the registry doesn't cover yet (e.g. `fragSOL`, the one asset the site API knows about that our own registry doesn't — a separate, smaller coverage gap, not an icon-resolution problem). Verified end-to-end: 11 of 12 API-covered assets now carry a real, resolving Exponent icon directly; a synthetic test with a conflicting RateX entry for hyloSOL confirmed the registry's Exponent icon takes priority over it.

**One more fix, per your follow-up:** `discoverLiveMarkets()` was calling `getPtMetadata()` unconditionally on every single run, even for a vault whose name+icon were already cached in the registry from a previous run — pure wasted RPC + URI-fetch calls, since both are immutable once a PT mint exists. Rewrote it to look up each vault against the existing registry (keyed by vault address, known before a name can be parsed) *before* deciding whether to call `getPtMetadata()` at all: a cached hit (both `rawName` and `logo` already present) skips the metadata read and URI fetch entirely and reuses the cached values; only a genuine miss (a vault never seen before, or a previous resolution that came back empty) triggers the real lookup — whose result then gets written back to the registry as before, so it's cached from then on. **Verified live with debug instrumentation** (added temporarily, confirmed all 14 correct cache hits, then removed): re-running discovery against the now-populated registry produced zero `getPtMetadata()` calls, all 14 icons still correct. (Total run time didn't visibly drop between the two runs — the CLMM bulk fetch + 14× `Vault.load()` + 28× AMM/OB existence checks dominate regardless, and normal RPC latency variance between runs is larger than the 28 round-trips saved; the cache-hit logging is the real confirmation, not the clock.) **Worth being explicit about scope, since it caused confusion:** none of this — the CLMM bulk fetch, the 14 `Vault.load()` calls, the metadata/icon caching — runs as part of the Worker's normal 1-minute job. `exponent-fetch.js` (the Worker's hot path) never touches RPC at all; it's a plain `fetch()` to the site API plus a lookup against the bundled registry JSON. `discoverLiveMarkets()` only runs as GH Actions' deep fallback during a genuine Exponent API outage, or when manually invoked to seed/refresh the registry (which is what this session's testing was).

**Bug found and fixed 2026-07-29, separate from icons: Exponent assets missing from their own project filter.** "All" showed every Exponent asset correctly, but selecting a specific project filter (e.g. "Hylo") made them disappear. Root cause, traced in `src/pages/StrategyDashboard.tsx`'s `getProjectForAsset()`: the filter does an exact match, `asset.projectName === 'Hylo'`, but `mapApiEntryToAssetRecord()` was setting `projectName` to the **token's own display name** (`"hyloSOL"`) rather than a **project/platform** name (`"Hylo"`) — conflating "what to call this asset" with "what group it belongs to." `"hyloSOL" !== "Hylo"`, so it silently failed the filter while still passing the "show everything" case.

ONyc/srONyc appeared unaffected only by accident: the frontend has a hardcoded special-case, `assetName.includes('ONyc')`, and `"srONyc".includes("ONyc")` is `true`, so both get force-mapped to `'Onre'` regardless of their actual `projectName` — not because their `projectName` was ever correct.

**Fix:** the site API's `platform` field (a clean, stable identifier — `"hylo"`, `"onrefinance"`, `"raiku"`, `"solstice"`, `"bulk"`, `"fragmetric"`, confirmed via live API dumps for hyloSOL/ONyc/srONyc) is now translated through a small `PLATFORM_TO_PROJECT` map (`{hylo: 'Hylo', onrefinance: 'Onre'}`) into the exact bucket name `FILTER_PROJECTS` expects, added identically to both `server/fetch-exponent-api.js` and `workers/src/exponent-fetch.js`. Platforms with no map entry (`raiku`, `solstice`, `bulk`, `fragmetric`) fall back to the token's display name as before, which correctly lands them in "Others" — same behavior an unrecognized RateX project already gets. `baseAsset` (used for card titles, icon cross-matching) is untouched — only `projectName` changed. **Verified against the live API:** hyloSOL/hyUSD/hySOL+/xSOL → `"Hylo"`; ONyc/srONyc → `"Onre"` (now directly correct, not by accident); fragSOL/rkuSOL/eUSX/bulkSOL/USX/stSLX → unchanged (their own token name, correctly unmatched).

**Not built yet / deliberately out of scope for this pass:**
- **Actually deploying.** See the step-by-step deployment guide immediately below.
- **CPU-time headroom**, not re-measured against the final API-only Worker: Section 6d's 0.57ms/market profile was for the CLMM-decode path this Worker no longer runs at all in the common case (one `fetch()` + a JSON map instead) — almost certainly comfortably under the 10ms free-tier cap now, but not re-profiled with a real Cloudflare invocation, only reasoned about.

### How to actually deploy this Worker

Needs your Cloudflare account — nothing below was run for you, since it requires credentials only you have and the final step is a real production action.

1. **Get a Cloudflare account** (free tier is enough — Workers Cron Triggers are available on it). Sign up or log in at [dash.cloudflare.com](https://dash.cloudflare.com/sign-up). No card required for the free plan.
2. **Get the GitHub token ready.** Check whether the existing `GIST_TOKEN` GitHub Actions secret (Settings → Secrets and variables → Actions, on `github.com/NammaFi/Hylo`) is a classic PAT with `workflow` scope in addition to `gist` — you'd know this if you generated it yourself. If you're not sure, the safest move is generating a fresh one: go to [github.com/settings/tokens](https://github.com/settings/tokens) → "Generate new token (classic)" → check both `gist` and `workflow` → generate → copy the value once (GitHub only shows it that one time).
3. **From this machine, in the `workers/` directory, log in to Cloudflare:**
   ```
   cd workers
   npx wrangler login
   ```
   This opens a browser tab to authorize the CLI against your Cloudflare account — approve it there.
4. **Deploy first:**
   ```
   npx wrangler deploy
   ```
   Wrangler prints the deployed Worker's URL and confirms the two Cron Triggers were registered. (Order matters here — `wrangler secret put` before the Worker exists will prompt to create an empty placeholder Worker first, which works but is a confusing detour. Deploying first means the secret step below has something real to attach to.)
5. **Then set the one secret this Worker needs:**
   ```
   npx wrangler secret put GITHUB_TOKEN
   ```
   Paste the token from step 2 when prompted. (`GIST_ID` doesn't need this — it's already a plain, non-secret value in `wrangler.toml`.)
6. **Verify it's alive:**
   - Dashboard: [dash.cloudflare.com](https://dash.cloudflare.com) → Workers & Pages → `hylo-exponent-worker` → **Triggers** tab should show both `* * * * *` and `*/5 * * * *`.
   - Live logs: `npx wrangler tail` streams real invocations as they happen — watch for a clean `Updated Gist: N Exponent assets` line within the first minute, and a RateX dispatch success within 5.
   - Gist: check `https://gist.github.com/NammaFi/d3a1db6fc79e168cf5dff8d3a2c11706` — `lastUpdated` should start moving every minute.
7. **If something fails:** a `401` on the Gist calls means the token's `gist` scope is missing or the token itself is wrong; a `404` specifically on the workflow-dispatch call (not 401) usually means the token lacks `workflow` scope — GitHub returns 404 rather than 401/403 for that specific case, so don't read it as "wrong URL."

### Other flagged items

- `api/cr-check.js` duplicating `server/cr-monitor.js`'s CR logic — **deferred to a future phase**, per your note that the CR system itself is somewhat in flux separately. (For whenever it's revisited: the reason it can't just import from `server/` is that Vercel's `api/` functions and the standalone `server/` app build/deploy completely separately — the real fix would be extracting the shared logic into its own root-level module both sides can import.)

### Direct answers to a few specific questions

- **Does Router split against the legacy AMM too?** No — Router's split-quote optimization only ever considers OrderBook and CLMM ("orderbooks and CLMMs only," per the SDK's own doc comment). The legacy AMM is never part of Router's math. For a blended "best Implied Yield across all 3 venues" figure, we'd combine Router's OB/CLMM output with a separately-fetched legacy-AMM figure ourselves.
- **`CollectTreasuryInterestKind` / `CollectTreasuryEmissionKind`** — admin-only actions for Exponent's own protocol treasury to sweep its share of fees/emissions out of a vault. Unrelated to yield timing for YT holders.
- **`computeExistingPositionBudgetEffect`** — a CLMM liquidity-position management calculation (from `@exponent-labs/market-three-math`), for adjusting an existing concentrated-liquidity position's token budgets. Also unrelated to yield timing.
- **LP position in-range/out-of-range alerts** — `MarketThree.getUserLpPositions(owner, market)` returns a position's tick range; combined with `Ticks.currentTick`, that's enough to tell whether a CLMM LP position is in-range or out-of-range. Flagged as a real, useful future-phase alert feature, out of scope for the current migration.

### Future phases (explicitly deferred, not forgotten)

Gathered here so they don't stay scattered across the document as inline asides:

- **Live-on-visit Exponent fetching** — an HTTP endpoint on the Worker the frontend calls on page load for genuinely-live numbers, independent of the 1-minute cron's own lag. **Deprioritized 2026-07-28, per your call**: "not required if github actions run reliably every 5 min through cloudflare calls." Revisit only if the current cadence proves not fresh enough.
- **CLMM LP position in-range/out-of-range alerts** — `MarketThree.getUserLpPositions` + `Ticks.currentTick` tell you whether a position needs rebalancing. Flagged as useful, not started.
- **`api/cr-check.js` / `server/cr-monitor.js` duplication** — deferred since the CR system itself is in flux separately (see "Other flagged items" above).
- **Snapshot-history store** (Section 6) — needed for CLMM/Tranching fee-APY-over-time, TVL-over-time, coverage-ratio charts. Needs a place to keep more than the latest snapshot (extra dated Gist files, a small DB, or Cloudflare KV/D1 now that Exponent has a Worker anyway).
- **Yield Exposure / leverage formula independent verification** — solved for the common case via the API's own `yieldExposure` field (Section 0/4); `MarketCalculator.proportionPtInAsset` remains unread, only relevant for the RPC-fallback path's rare gap-fill assets.

### Exponent project sync (action item, supersedes "don't touch the Exponent folder" for this specific case)

**Done 2026-07-28.** Bumped `@exponent-labs/exponent-sdk` (+ pinned companions) from `0.9.20` → `0.9.21` → `0.9.23` (the true latest, once `pnpm install` flagged it) in `strategy-recipes/package.json`, `npx tsc --noEmit` clean both times (only the 4 baseline errors). Copied `SDK_INTRODUCTION.md` into `recipes/my-bot/` for reference there, adapted for that project's context. Given CLAUDE.md flags `SCHEDULED_YIELD_LOOP` as high-risk, this got the same care as any other bot-engine.ts change — tsc clean, confirmed rather than assumed.

---

## Notes

- `scraper-exponent.js` (original Puppeteer scraper) is **preserved** as a last-resort fallback.
- The Playwright approach reuses all existing data extraction logic (same regex patterns, same maturity parsing, same YT metrics calculation via `calculateYtMetrics`).
- This document supersedes its own earlier claim that "if Exponent launches v2 at a new URL, update the `goto` calls" is sufficient — the RPC-based approach above is what actually makes this migration resilient to a real v1→v2 change, not a one-line URL update.
- Every technical claim in the "RPC-Based Scraper" section above that's marked verified was checked directly against the installed `@exponent-labs/exponent-sdk` package on 2026-07-23 (then version `0.9.21`) or live-tested on 2026-07-28 (against `0.9.21`, then re-confirmed the package itself updates cleanly to `0.9.23` the same day — the specific fields/functions verified weren't individually re-checked against `0.9.23`, though patch-level bumps rarely remove APIs). Anything not marked verified should be treated as a hypothesis to test, not a confirmed fact — see the verification checklist (section 10).
