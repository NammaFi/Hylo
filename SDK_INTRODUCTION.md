# Exponent SDK — Introduction

This document explains the `@exponent-labs/exponent-sdk` package we just installed into `server/`, in plain language. It's written so you don't need to be a developer to understand what the SDK can do for us and why it matters for replacing our current web-scraping approach.

**Package installed:** `@exponent-labs/exponent-sdk` version `0.9.23` (the latest version on the public npm registry, updated 2026-07-28 from `0.9.21`). It lives at `server/node_modules/@exponent-labs/exponent-sdk`. It's a public package — no special login or API key was needed to download it, anyone can `npm install` it. The trading bot in the separate Exponent project is now on the same `0.9.23` (bumped from `0.9.20` on 2026-07-28, `tsc --noEmit` clean both times).

Everything in this SDK talks **directly to the Solana blockchain** (via an RPC connection, the same kind of connection our bot project already uses). There is no scraping, no browser automation, and no dependency on Exponent's website staying visually the same. If Exponent redesigns their web page tomorrow, nothing here breaks — because we're not reading their page, we're reading the same on-chain data their page reads.

---

## 1. Why this matters for us

Our current `server/` scrapers (the many `scraper-exponent-*.js` files) open a real Chrome browser, load `app.exponent.finance`, and pick data off the rendered page. That approach is fragile: it breaks if Exponent changes a CSS class or page layout, it's slow (a full browser has to boot and render), and it's the reason we were told the site needs updating for Exponent's v2 launch.

The SDK replaces the "browser + guesswork" step with direct, structured reads: give it a market's address, and it hands back exact numbers (price, APY, liquidity, expiry) — no HTML parsing involved. It's also how the SDK is used in our existing Solana trading bot project, so we already have proven, working code we can learn from.

**One important capability up front, confirmed live** (details in Section 9): the SDK *does* have a "give me every market that exists" function, and it works — tested against the real Exponent deployment: **103 legacy AMM markets + 25 CLMM markets, resolving to 100 unique YT markets, 98 of them successfully named.** It's tucked away under a subpath import rather than the main package, so it's easy to miss (I missed it myself on a first pass, and initially reached for the wrong bulk-fetch function too — see the correction note in Section 9). OrderBook addresses aren't bulk-fetchable the same way, but derive via PDA from a known vault instead (also Section 9, confirmed live). This is the confirmed, tested answer to your question about the Exponent markets screenshot.

---

## 2. Vocabulary — the concepts that show up everywhere

Exponent's product (in both v1 and v2) is a **yield-tokenization** protocol, conceptually similar to Pendle Finance. A few terms recur throughout the SDK:

| Term | Meaning |
|---|---|
| **Base asset** | The real underlying token, e.g. USDC-like stablecoins, SOL, or a liquid-staking token. |
| **SY (Standardized Yield)** | A wrapped version of the base asset that auto-accrues yield (like a interest-bearing receipt token). Depositing the base asset mints SY. |
| **PT (Principal Token)** | Represents "the base asset amount, delivered at a future maturity date, with the yield stripped out." Trades at a discount to the base asset today (that discount is where "Implied APY" comes from — the bigger the discount, the higher the implied yield). |
| **YT (Yield Token)** | Represents "all the yield the underlying will generate between now and maturity," with none of the principal. This is the leveraged-yield-exposure instrument — buying $1 of YT gives exposure to the yield stream of many dollars of the underlying (this is exactly the "Yield Exposure — 122.72x" style number in your screenshot). |
| **Vault** | The on-chain object that manages one specific base-asset/SY relationship: minting SY, tracking the exchange rate, and the maturity date PT/YT settle at. |
| **Market** | The trading venue where PT and YT (via SY) are bought and sold. Exponent has **three kinds** of markets/venues (explained in Section 6-8): a legacy AMM, a CLMM, and an OrderBook. |
| **Maturity / expiration** | The date a market's PT+YT settle back into 1:1 base asset. After maturity, PT redeems for the full base asset and YT is worthless (its yield window has closed). |
| **Implied APY** | The annualized yield rate implied by the current PT discount (or, on the OrderBook, literally the price traders are quoting). This is the single most important number for a yield-market dashboard — it's the first column in your screenshot. |
| **Flavor** | Which underlying yield-source protocol backs a given vault's SY — e.g. Marginfi, Kamino, Jito Restaking, Perena, or a "Generic" catch-all. Roughly maps to the little protocol name/logo you see under each market's ticker in the screenshot (e.g. "BULK Staked SOL", "Hylo Leveraged SOL"). |

---

## 3. The three trading venues (this is the v1 → v2 story)

This is the part most relevant to why our project needs updating. The SDK has **three separate classes** for the three venue types, and they map directly to what your CLAUDE.md / bot project already established:

| SDK class | Venue | Generation | What it is |
|---|---|---|---|
| `Market` | Legacy AMM | **v1** | The original automated-market-maker curve (Notional/Pendle-style "rate scalar / rate anchor" bonding curve). Still live for some older markets, but Exponent isn't launching new markets on it. |
| `MarketThree` | CLMM (Concentrated Liquidity Market Maker) | **v2** | The current, actively-used venue for new yield markets. Liquidity providers concentrate their capital in specific APY ranges (like Uniswap V3 price ranges, but for interest rates). |
| `Orderbook` | OrderBook | **v2** | A traditional limit-order book — traders post buy/sell offers at specific implied-APY prices, and offers get matched. |

**Practically:** if a market in our list is an older/legacy one, we load it with `Market`. If it's a current-generation market, we load it with `MarketThree` and/or `Orderbook` — a single underlying asset (like ONYC in the bot project) can have both a CLMM market *and* an OrderBook *and* (rarely, for old assets) a legacy AMM market simultaneously, all trading the same PT/YT. The `Router` class (Section 8) is what combines quotes across whichever of these exist for a given asset.

*(Trivia, not important: internally the legacy AMM's on-chain account type is literally named "MarketTwo" — you may see that name in some type definitions. It's the same thing as the `Market` class; just an old internal name from Exponent's own program history.)*

---

## 4. Setting up: `Environment` and the connection

File: `build/environment.d.ts`

```ts
type Environment = {
  marginfiSyProgramId, kaminoSyProgramId, coreProgramId,
  jitoRestakingSyProgramId, perenaSyProgramId, genericSyProgramId,
  exponentVaultsProgramId
}
const LOCAL_ENV: Environment   // the pre-built mainnet constant
```

This is just configuration — a bundle of Solana program addresses the SDK needs to know which on-chain programs to talk to. You never build this yourself; you import the ready-made `LOCAL_ENV` constant (the same one our bot project already imports) and pass it into every `load()` call below. Despite the name, this is the **mainnet** configuration, not a local test network — "LOCAL_ENV" is just what Exponent happened to name their exported constant.

Alongside `Environment`, every SDK call also needs a `Connection` object — this is a standard Solana web3.js concept (an RPC endpoint to read on-chain data from), not something special to Exponent. Our bot project already has RPC rotation logic (`RpcRotator`) we can reuse directly.

---

## 5. `Vault` — the SY wrapper for one asset

File: `build/vault.d.ts`

Think of a Vault as "the record for one specific yield-bearing asset" — e.g. there's one Vault for ONYC, one for eUSX, one for hyloSOL, etc. You load it by its on-chain address:

```ts
Vault.load(env, connection, address, options?) → Promise<Vault>
```

Once loaded, the properties you'll actually use for a dashboard are:

- **`currentSyExchangeRate`** — the live exchange rate between the base asset and its SY wrapper. This number grows over time as yield accrues (for an auto-compounding asset) — it's the core "how much has this actually earned" figure.
- **`expirationTimestamp`** / **`expirationDate`** — when this market's PT/YT matures (a raw Unix timestamp and a convenient `Date` object, respectively). Maps directly to the "16SEP26 · 54 days" style info in your screenshot.
- **`mintSy`**, **`mintPt`**, **`mintYt`** — the Solana token-mint addresses for the SY/PT/YT tokens themselves. You need these if you ever want to look up someone's token balance directly.
- **`flavor`** — tells you which yield-source protocol (Marginfi/Kamino/etc.) backs this vault (see Section 2).
- **`syEmissions`** / **`vaultEmissions`** — extra reward-token emissions on top of the base yield, if the vault has any (some assets pay bonus rewards, not just the base yield).

### Vault trading/position methods, in full detail

Every method below builds a Solana transaction instruction — it doesn't run anything by itself, it hands back something a wallet would still need to sign and send. Hylo's current read-only dashboard doesn't call any of these, but you asked for full understanding since there are broader plans ahead, so here's what each one actually does:

- **`ixStrip({syIn, depositor, ptDst, ytDst, sySrc})`** — the core "create YT" operation: takes SY the depositor already holds and splits it into an equal-value pair of PT + YT. This is how YT comes into existence in the first place.
- **`ixStripFromBase({owner, amountBase, baseSrc, sySrc, ptDst, ytDst})`** — the convenient "one-step" version: starts from the raw base asset (e.g. plain USDC), mints SY from it automatically, then strips that SY into PT + YT — so the caller never has to hold SY themselves.
- **`ixMerge({pyIn, depositor, ptSrc, ytSrc, syDst})`** — the reverse of `ixStrip`: takes back an equal amount of PT + YT and recombines them into SY.
- **`ixMergeToBase({owner, payer, amountPy, ptSrc, ytSrc, syDst, baseDst})`** — the one-step reverse of `ixStripFromBase`: merges PT + YT back to SY, then immediately redeems that SY back into the base asset.
- **`ixInitializeYieldPosition({owner})`** — a one-time setup step: creates the on-chain account that tracks a wallet's accrued/claimable yield for this vault. Needed once before a wallet can hold YT or claim interest from it.
- **`ixCollectInterest({owner, amount, syDst})`** — claims already-accrued yield from a yield position, paid out in SY.
- **`ixWrapperCollectInterest({claimer, tokenSyDst})`** — the same claim, wrapped so the claimer can receive it more conveniently (handles the SY-to-base redemption step automatically instead of leaving the claimer holding raw SY).
- **`ixCollectEmission({owner, emissionIndex, amount, emissionDst})`** — claims a bonus reward-token emission earned via a YT position (separate from the base yield itself — see `syEmissions`/`vaultEmissions` above).
- **`ixAddStandaloneEmission({signer, emissionMint, ...})`** — *admin-only*: adds a brand-new bonus-reward-emission stream to the vault. Requires Exponent's own admin authority, not something Hylo (or any third party) could call.
- **`ixConfigureVault({signer, action})`**, **`ixCollectTreasuryInterest`**, **`ixCollectTreasuryEmission`** — *admin-only*, covered in Section 12 (Exponent's own protocol settings/treasury sweep — not callable by anyone else).

---

## 6. `Market` — the legacy AMM (v1) venue

File: `build/market.d.ts`

Load with `Market.load(env, connection, address, vault?, options?)`. The vault parameter is optional — if you don't pass one, it'll load it internally, but passing an already-loaded `Vault` (Section 5) avoids a redundant network call.

The read-only numbers you'd actually use for a dashboard, all available as simple properties (no calculation needed on our end):

- **`ptApr`** / **`ptApy`** — the annualized yield rate, expressed two ways (APR = simple annualized rate, APY = compounded). **This is almost certainly the exact "Implied APY" column** in the screenshot, for any market that's still on the legacy AMM.
- **`currentPtPriceInAsset`** — how many units of the base asset it costs to buy 1 PT right now.
- **`currentPtPriceInSy`** — same idea, priced in SY instead of the base asset.
- **`ptDiscount`** — how far below "face value" PT is trading (the raw discount that *produces* the implied APY above).
- **`liquidityPoolTvl`** — total value locked in the pool. Likely maps to "Total Market Size" in the screenshot.
- **`lpPriceInAsset`** — the price of one LP (liquidity-provider) token, in the base asset.
- **`secondsRemaining`** — countdown to maturity, in seconds (easy to turn into "54 days" style display).
- **`feeTreasuryBps`** / **`feeRatePtTrade`** / **`feeTreasuryRate`** — the trading fee rates.
- **`liquidityAvailable(isBuy, sizePt)`** — a method (not a property) that tells you how much PT can actually be traded right now in a given direction, given current liquidity. This could be the source of the smaller "Liquidity" figure in the screenshot (as distinct from the bigger "Total Market Size" TVL figure).

There's also `toJson()`, which dumps almost everything above (plus more) into one plain object in a single call — genuinely convenient for a dashboard that wants "all the numbers for this market" in one shot rather than reading each property individually. Its fields are individually commented in the SDK's own source (e.g. `"How many SY are required to buy 1 PT"`, `"Proportion of PT in terms of assets"`) so it's self-explanatory if you ever look at the raw output.

### Market trading/liquidity methods, in full detail

**Directional trading (buy/sell PT or YT):**
- **`ixBuyPt({trader, amountPt, maxSySpend, tokenPt?, tokenSy?})`** — buy an exact amount of PT, paying with SY, capped at a maximum SY spend (the slippage guard — the trade fails rather than overspend).
- **`ixSellPt({trader, amountPt, minSyReceive, ...})`** — sell an exact amount of PT for SY, with a minimum-receive floor as the slippage guard.
- **`ixBuyYt({trader, ytOut, maxSyIn, ...})`** / **`ixSellYt({trader, ytIn, minSyOut, ...})`** — the same idea, for YT instead of PT.
- **`ixTradePt({trader, traderPt, syConstraint, isBuy, ...})`** — a lower-level combined buy/sell, chosen by a boolean flag rather than two separate methods; `ixBuyPt`/`ixSellPt` are the friendlier wrappers around this.
- **`ixWrapperBuyPt` / `ixWrapperSellPt` / `ixWrapperBuyYt` / `ixWrapperSellYt`** — "wrapper" versions of all of the above that work directly in the **base asset** (e.g. plain USDC) instead of requiring the trader to already hold SY — the program mints/redeems SY internally as part of the same transaction.

**Being a liquidity provider (LP):**
- **`ixDepositLiquidity({ptInIntent, syInIntent, minLpOut, depositor, ...})`** — deposit a PT + SY pair, receive LP tokens representing your share of the pool. The amounts are "intended maximums" since exact ratios can shift slightly before the transaction lands; `minLpOut` is the slippage guard.
- **`ixWithdrawLiquidity({lpIn, withdrawer, minPtOut, minSyOut, ...})`** — burn LP tokens, get back a PT + SY pair.
- **`ixProvideLiquidityNoPriceImpact` / `ixProvideLiquidityBase` / `ixProvideLiquidityClassic`** — three different ways to become an LP starting from the base asset instead of already holding PT + SY, differing in how the program assembles the PT/SY pair internally (a no-price-impact-optimized route, an auto-buy route, and a classic route where you also specify the PT amount yourself).
- **`ixWithdrawLiquidityToBase` / `ixWithdrawLiquidityClassic`** — withdraw LP back into the base asset directly, vs. back into raw PT + SY.
- **`ixInitLpPosition({owner, feePayer?})`** — one-time setup: creates the on-chain account tracking a wallet's LP position in this market.
- **`ixDepositLp` / `ixWithdrawLp`** — stake or unstake already-held LP tokens into/out of the farming module, to start or stop earning bonus farm rewards on top of trading fees.
- **`claimFarmEmissions({owner, mint, tokenProgram, ...})`** — claim staked-LP farming rewards for a specific reward token.
- **`ixCollectMarketEmission`** — claim bonus emission rewards tied to market/LP participation more broadly (distinct from farm-specific emissions).
- **`ixWrapperCollectInterest`** — same claim-interest idea as Vault's version, wrapped for base-asset convenience.

**Admin/maintenance only** (Exponent's own team, not callable by Hylo or any third party): `ixModifyMarketSetting`, `ixModifyFarm` (configure a farm's reward rate), `addFarm` (create a new farm reward stream), `ixAddStandaloneEmission`, `realloc_market` (expand the on-chain account's storage allocation, a maintenance operation for when a new field needs more space).

---

## 7. `MarketThree` — the CLMM (v2) venue

File: `build/marketThree.d.ts`

This is Exponent's own description in their code comments: *"CLMM (Concentrated Liquidity Market Maker) market client for the Exponent protocol. Provides instruction builders for trading PT/YT tokens, managing concentrated liquidity positions, and administering market settings."*

Load with `MarketThree.load(env, connection, address, vault?, ticks?, options?)`. Notice the extra `ticks` parameter compared to `Market` — CLMM liquidity is spread across price "ticks" (ranges), so reading a CLMM market properly means also reading its **Ticks** account (the SDK fetches this automatically if you don't supply one).

**Important difference from `Market`:** MarketThree does **not** have a simple `ptApy`/`currentPtPriceInAsset` property. Because liquidity is spread across a range of ticks rather than one single curve, there isn't one single "current price" sitting in a property the way there is for the legacy AMM — the current price/rate has to be derived from the ticks data, via `Ticks.currentSpotPrice`.

**The Implied APY formula, confirmed live 2026-07-28 — and my first attempt at it was wrong.** `Ticks.currentSpotPrice`'s own doc comment describes it as "(ln implied rate)," which reasonably reads as "take the natural log and exponentiate it back to get the rate." **That reading is wrong.** The correct formula, confirmed two independent ways — the SDK's own compiled source (`marketThree.d.ts`'s own `@param` doc on a related method: *"Current spot price in format of 1 + percentage / 100"*; `exponentVaults/vaultAssertion.js` literally computes `impliedApyDecimal = currentSpotPrice - 1` internally) and the trading bot's own already-proven SIMULATE code (`bot-engine.ts`: `clmmInitialIY = (clmmInitialSpot - 1) * 100`) — is simply:
```
impliedApy = (currentSpotPrice - 1) * 100
```
No exponential needed at all. Tested against real live data: ONYC's CLMM came out to 14.11%, against its legacy AMM's independently-confirmed 14.14% (0.03 percentage points apart, plausible for two different venues) — and every one of the 14 live markets landed close to the figures in the original screenshot for the same/similar assets (rkuSOL 6.74% vs. 6.81%, eUSX 6.46% vs. 6.34%, USX 4.88% vs. 5.59%). Safe to use.

- **`secondsRemaining`**, **`feeTreasuryBps`**/**`feeTreasuryRate`** — same meaning as in `Market`.
- **`static calcTvlInBaseToken({ financials, currentSpotPrice, syExchangeRate, timestampUnix? })`** — computes total-value-locked, split into PT liquidity and SY liquidity. This is the CLMM equivalent of `Market`'s `liquidityPoolTvl`.
- **`static calcGlobalFeeRate(snapshotCurrent, snapshotHistory)`** — computes the realized fee rate earned between two points in time (requires you to have kept two snapshots — see the note on history-tracking below).
- **`static calculateHistoricalFeeApy({ feeGrowthDeltaSy, feeGrowthDeltaPt, avgLiquidity, hoursElapsed })`** — turns fee growth into an annualized fee APY.
- **`liquidityUnitPriceInAsset({ lowerTickKey, upperTickKey, ... })`** — price per unit of liquidity for a given tick range.
- **`static calcEstimatedYieldForPosition(...)`** — "if I had a hypothetical LP position between these two snapshots, how much would it have earned."

**The catch:** several of the most useful CLMM analytics (fee APY, TVL-over-time, yield estimates) are explicitly designed to compare **two snapshots** of `MarketSnapshotData` (one now, one from earlier). That means to get rich CLMM stats, we benefit from **keeping our own history of snapshots** over time — which is a natural fit for what our scraper-and-store pipeline already does every 10 minutes, just storing the right on-chain fields instead of scraped HTML.

`getUserLpPositions(owner, market)` and the `getExistingPosition...` family are for a specific wallet's CLMM liquidity positions. **Flagged as a real future-phase feature**: combined with `Ticks.currentTick`, this tells you whether a CLMM LP position is currently in-range or out-of-range — a genuinely useful alert, not part of the current migration.

### MarketThree trading/liquidity methods, in full detail

Same categories as the legacy `Market` class (Section 6), with the CLMM-specific twist that liquidity positions and some trades are scoped to a **tick range** (a band of implied-APY prices), and several methods accept an optional `lnImpliedApyLimit` — a CLMM-specific price-limit slippage guard, in addition to the usual amount-based ones.

**Directional trading:**
- **`ixBuyPt({trader, amountSy, outConstraint, tokenPt?, tokenSy?, lnImpliedApyLimit?})`** / **`ixSellPt({trader, amountPt, outConstraint, ...})`** — buy/sell PT for SY, specifying the input amount.
- **`ixBuyPtExactOut({trader, amountPt, maxSyIn, ...})`** / **`ixSellPtExactOut({trader, amountSy, maxPtIn, ...})`** — the inverse framing: specify the exact output you want, cap the input you're willing to spend.
- **`ixBuyYt` / `ixSellYt`** — the same idea for YT, with the same input-amount and exact-out variants.
- **`ixTradePt({trader, traderAmount, outConstraint, swapDirection, ...})`** / **`ixTradePtExactOut(...)`** — lower-level combined swap, direction chosen via `SwapDirection.SyToPt`/`PtToSy` rather than separate buy/sell methods; the friendlier `ixBuyPt`/`ixSellPt` wrap these.
- **`ixWrapperBuyPt` / `ixWrapperSellPt` / `ixWrapperBuyYt` / `ixWrapperSellYt`** — base-asset-denominated versions, same idea as the legacy Market's wrappers: the program mints/redeems SY internally so the trader works directly in the base asset.

**Being a concentrated-liquidity provider:**
- **`ixDepositLiquidity({ptInIntent, syInIntent, lowerTickKey, upperTickKey, depositor, ...})`** — deposit into a **specific tick range** (a band of implied-APY prices you're providing liquidity across) — this is the key CLMM difference from the legacy AMM's single-curve deposit.
- **`ixWithdrawLiquidity({lpIn, withdrawer, lpPosition, minPtOut, minSyOut, ...})`** — redeem liquidity from a specific position (identified by `lpPosition`, since a CLMM position is its own account, not a fungible LP token the way the legacy AMM's is).
- **`ixWrapperProvideLiquidity` / `ixProvideLiquidityClassic` / `ixProvideLiquidityBase`** — base-asset-starting variants for creating a *new* concentrated-liquidity position across a chosen APY range (`lowerTickApy`/`upperTickApy`), differing in how the PT/SY pair gets assembled internally — same three-way split as the legacy Market's liquidity-provision methods.
- **`ixAddLiquidity({owner, ptInIntent, syInIntent, lpPosition, ...})`** — add more liquidity to an **existing** position, rather than creating a new one.
- **`ixWithdrawLiquidityToBase` / `ixWithdrawLiquidityClassic`** — withdraw a position back into the base asset directly, vs. back into raw PT + SY.
- **`getUserLpPositions(owner, market)`** — read-only: lists a wallet's existing CLMM positions (their tick ranges) — this is the one covered above as a future alerting-feature lead.
- **`claimFarmEmission({owner, farmMint, lpPosition, ...})`** — claim farming rewards tied to a specific concentrated-liquidity position.
- **`ixMarketAccureEmissions({owner, lpPosition})`** — accrual bookkeeping step for a position's emissions (distinct from claiming — this updates the position's accrued-but-not-yet-claimed record).

**Admin/maintenance only:** `ixModifyMarketSetting`, `ixAddFarm`/`ixModifyFarm` (farm reward configuration), `buildModifyMarketSettingIx` (a variant that works even if the market's address-lookup-table is broken — an admin repair tool).

---

## 8. `Orderbook` — the OrderBook (v2) venue

Files: `build/orderbook/orderbook.d.ts`, `build/orderbook/math.d.ts`, `build/orderbook/types.d.ts`

Load with `Orderbook.load(env, connection, address, options?, vault?)`. Once loaded:

- **`getQuote({ priceApy?, inAmount, unixNow, direction, syExchangeRate })`** — "if I traded this much in this direction, what would I get, and what fees would I pay." Useful for showing an indicative execution price.
- **`getOffers()`** — returns every live offer sitting in the book (`{ type, priceApy, amount, expiryAt, createdAt, isVirtual }` for each). This is the raw bid/ask depth — from this you could derive a "best bid" / "best offer" implied APY, which is likely how Exponent's own UI decides the OrderBook's contribution to a market's headline Implied APY.
- **`secondsRemaining`**, **`makerFeeRate`**, **`takerFeeRate`** — same idea as the other venues.
- **`getAllUserOrderbookBalances()`** / **`getUserOrderbookBalances(user)`** / **`getUserOpenOrders(user)`** — per-wallet balances and open orders sitting in the book. Relevant only for a "your positions" feature, not the market list.

A standalone, very useful helper lives in `orderbook/math.ts` and is also re-exported at the very top level of the whole package (a signal Exponent considers it broadly useful, not orderbook-specific):

- **`calcPriceInAssetsByAPYPt(priceApy, secUntilMaturity)`** — converts an Implied APY number into the equivalent PT price. This is the formula connecting the human-friendly "%" number to the underlying price math, and could be useful if we ever need to sanity-check or recompute an APY figure ourselves.
- **`getPtToSyRate`** / **`getYtToSyRate`** — similar conversions for PT/YT-to-SY rates.

### Orderbook trading methods, in full detail

- **`ixPostOffer({trader, price, amount, offerType, offerOption, virtualOffer, expirySeconds, offerIdx?, ...})`** — place a **limit order**: an offer to buy or sell at a specific implied-APY price, sitting in the book until it's filled or expires. `offerType` picks the direction (see `OfferTradeDirection`/`OfferType` in Section 8 vocabulary); `virtualOffer` marks an offer backed by a position the trader doesn't have to pre-fund in full (a "virtual" collateral mechanism); `expirySeconds` sets how long it stays live.
- **`ixMarketOffer({trader, maxPriceApy, amount, minAmountOut, offerType, virtualOffer, ...})`** — place a **market order**: take whatever the best currently-available price is, up to a worst-acceptable-price cap (`maxPriceApy`) and a minimum-amount-out floor — fills immediately against existing resting offers rather than waiting in the book.
- **`ixRemoveOffer({trader, offerIdx, ...})`** — cancel a previously-placed resting order, identified by its index.
- **`ixWrapperPostOffer` / `ixWrapperMarketOffer` / `ixWrapperRemoveOffer`** — base-asset-denominated wrappers for the three methods above, same "handles SY mint/redeem internally" convenience pattern as the other venues.
- **`ixWrapperCollectInterest({trader, mintSy, ...})`** — claim accrued yield, same idea as the other venues' interest-collection methods.
- **`ixWrapperWithdrawFunds({trader, mintSy, ptAmount, ytAmount, syAmount, ...})`** — withdraw PT/YT/SY sitting in the orderbook's escrow back to the wallet (e.g. proceeds from filled orders, or unused collateral behind a cancelled order).
- **`getNextOfferIndex()`** — read-only: the next offer index the orderbook will allocate — useful bookkeeping if you're about to post an order and need to know its future index.

**Admin/maintenance only:** `ixSetConfigurationOptions`/`ixSetConfigurationOption` (configure minimum lot size, price-tick precision, maker/taker fee rates, the address-lookup-table, or CPI accounts — one setting per call), `buildSetConfigurationOptionIx` (a variant usable with just the orderbook's address and admin key, without loading the full account), `ixWrapperCollectAdminFee`/`ixCollectAdminEmission` (protocol fee/emission sweep), `ixRemoveExpiredOffers` (a maintenance sweep that clears expired orders out of the book).

---

## 9. `Router` — combining all three venues, and the answer to your screenshot question

File: `build/router.d.ts`

This is the class our existing trading bot uses heavily (`Router.getSplitQuote`). It combines whichever of `Market`, `Orderbook`, and `MarketThree` (+ ticks) exist for one asset, and answers "what's the best price across all of them, possibly splitting the trade across more than one venue at once."

```ts
Router.load(connection, {
  vault?, env,
  legacyMarketsParams?: [{ address, options? }],
  orderbookParams?:      [{ address, options? }],
  clmmParams?:           [{ marketThreeAddress }],
})
```

Every venue list in that signature is an array of addresses. Reading `Router.load`, `Market.load`, `MarketThree.load`, `Orderbook.load`, and `Vault.load` in isolation, you'd reasonably conclude (as I first did, incorrectly — see the correction box below) that the SDK has no way to discover markets, only to read ones you already know about.

> **Correction:** an earlier draft of this document said flatly "no discovery mechanism exists." That was wrong, and I want to flag the mistake rather than quietly fix it, since you're relying on this doc being accurate. My first pass searched for functions named `fetchAll...Accounts`, all of which do require a known address list — but I missed a *differently-named* family of functions that do exactly the opposite. I only caught this because Hylo's own `IMPLEMENTATION_PHASES.md` (written earlier by someone on this project, evidently after real research) named the correct functions directly, which prompted me to go back and re-check the installed package against that claim rather than trust either source blindly. Section 9 below is the corrected version.

### So — can we get the full list from your screenshot? Yes, mostly.

The SDK ships a **separate family of functions**, one level deeper than the classes above, that do exactly the "give me everything" job — they're just not re-exported from the main package, so they're easy to miss. They live under subpath imports:

```ts
import { fetchProgramAccountsMarketTwo,  EXPONENTCORE_PROGRAM_ID } from '@exponent-labs/exponent-sdk/client/core'
import { fetchProgramAccountsMarketThree, EXPONENTCLMM_PROGRAM_ID } from '@exponent-labs/exponent-sdk/client/clmm'
import { fetchProgramAccountsVault } from '@exponent-labs/exponent-sdk/client/core'

const allLegacyMarkets = await fetchProgramAccountsMarketTwo(connection, EXPONENTCORE_PROGRAM_ID)   // every v1 AMM market, no addresses needed
const allClmmMarkets   = await fetchProgramAccountsMarketThree(connection, EXPONENTCLMM_PROGRAM_ID)  // every v2 CLMM market, no addresses needed
const allVaults        = await fetchProgramAccountsVault(connection, EXPONENTCORE_PROGRAM_ID)        // every vault, no addresses needed
```

Each takes just a connection and a program ID (both of which the SDK exports as ready-made constants — you don't look them up yourself), and hands back **every single account of that type that exists on-chain**, each already deserialized into a plain object (`{ address, data }`). Internally these do exactly what a block explorer does (ask the RPC for every account belonging to a program, filtered to one specific account layout) — the SDK has just already done the hard part of building that filter correctly, so we never have to touch raw byte discriminators ourselves.

I confirmed this pattern exists for **legacy AMM markets** (`fetchProgramAccountsMarketTwo`), **CLMM markets** (`fetchProgramAccountsMarketThree`), and **vaults** (`fetchProgramAccountsVault`) by reading the actual installed package's type declarations directly — not by trusting any doc, including this one's earlier draft.

**A real bug found in `fetchProgramAccountsVault` — and a much better way around it, both confirmed live 2026-07-28.** Calling `fetchProgramAccountsVault` fails with `Codec [u32] cannot decode empty byte arrays` — reproduced on both a free public RPC and a real, dedicated Helius endpoint, so it's a genuine SDK-decoder edge case, not an RPC-quality problem. But it turns out we never need to call it: **`fetchProgramAccountsMarketTwo` and `fetchProgramAccountsMarketThree` both work perfectly** — tested live: **103 legacy AMM markets + 25 CLMM markets, both in under 1.2 seconds combined, zero errors.** Every market account carries its own `vault: PublicKey` field, so collecting the unique vaults referenced across all 128 markets gives **100 unique YT markets — the full current Exponent lineup — without ever touching the broken vault bulk-fetch.**

**Names, tested at real scale, not just a 3-vault spot check.** Loaded all 100 discovered vaults individually (`Vault.load` — confirmed reliable at this scale) and resolved names via each vault's `mintPt` Metaplex metadata (the fix described below): **98 of 100 resolved cleanly** — e.g. `PT-ONyc-10SEP26`, `PT-xSOL-07DEC25`, `Exponent PT-fragSOL-31OCT25`, spanning flavors `generic`/`kamino`/`marginfi`/`jitoRestaking`/`perena`. Two individual-vault edge cases surfaced, worth handling gracefully (skip-and-log, not crash-the-whole-batch): one vault decoded with an "Unknown flavor" (likely a flavor type newer than this SDK build, or a deprecated/test vault), one hit a raw buffer offset-out-of-range error (likely a genuinely different/older account shape).

None of `MarketTwoAccountData`, `MarketThreeAccountData`, or `VaultAccountData` contain a human-readable name anywhere on their own — you get mint addresses and raw numbers. The fix: look up each vault's `mintPt` mint's **Metaplex token metadata** (the standard Solana way of attaching a name/symbol/logo to a token) — confirmed rich and reliable at scale above, no manual maintenance needed, no new dependency beyond deriving a PDA and reading one more account per asset (`mintYt`, tried first, has none at all — see the Implementation Plan's Section 3 for that finding).

**OrderBook — no bulk-fetch function exists, but the address doesn't need one.** `client/orderbook/accounts/` has no "every orderbook" fetcher — but its address is a PDA derivable directly from a vault (`ExponentOrderbookPDA.orderbook({vault, seedId})`, from `@exponent-labs/exponent-pda`), confirmed live: `seedId: 0` produced an exact match for ONYC's real OrderBook address. The legacy AMM and CLMM addresses derive the same way (`ExponentPDA.market`, `ExponentCLMMPDA.market`) — so once a vault is known (from the market-level bulk fetch above), every venue's address is computable for free, no maintained list needed for any of them.

**One practical constraint worth knowing: rate limiting.** Looping through 100 sequential `Vault.load` + Metaplex-lookup calls on a single RPC connection triggered several `429 Too Many Requests` from Helius (auto-retried, so it still completed, just slower). At this scale, spreading calls across multiple rotating RPC endpoints (see the Implementation Plan's RPC rotator) isn't optional — it's what keeps ~200+ calls from hitting a single key's rate limit.

**Refined further, 2026-07-28: CLMM-anchored discovery, expiry needs a second filter, and multi-maturity is real.** Rebuilt the discovery flow to start from CLMM markets specifically (`fetchProgramAccountsMarketThree`) rather than both venues at once, per how Hylo actually wants to use this (CLMM as the primary/anchor venue, AMM and OrderBook as supplementary data for the same vault). Filtering to non-expired (`financials.expirationTs > now`) isn't quite enough on its own — one of the 25 CLMM markets for ONYC's vault turned out to be an **empty shell account** (`statusFlags: 0`, zero `ptBalance`/`syBalance`, a different internal `seedId` than the real market) that hadn't expired by timestamp but was never actually active. Adding an activity check (`ptBalance > 0 || syBalance > 0`) alongside the expiry filter gets to the genuinely correct set: **14 live, active CLMM markets, as of 2026-07-28.** Also confirmed **`srONyc` has two simultaneous live maturities** — a real case (not a duplicate/bug), validating that the registry needs to key by (symbol, maturity) rather than by bare token symbol (see the Implementation Plan's registry design). And: **every one of the 14 has no legacy AMM at all** — a clean, concrete confirmation that current markets are 100% CLMM/OrderBook, no v1 AMM among them.

**No RPC-level "only non-expired" filter exists, and this is a Solana-wide limitation, not an SDK gap.** `getProgramAccounts` only supports exact-byte-match filters, not numeric range comparisons — there's no way to ask the server "expirationTs greater than now." Every bulk fetch always returns everything; filtering happens client-side after decoding.

**Bottom line, fully confirmed rather than theorized:** bulk-fetch CLMM markets, filter to non-expired *and* active, collect the vaults they reference, resolve names via `mintPt` metadata, derive every other venue address via PDA. No scraping, no maintained address list, no undocumented API dependency.

`Router` also exposes:
- **`RouterQuoteDirection`** enum: `BASE_TO_YT`, `BASE_TO_PT`, `YT_TO_BASE`, `PT_TO_BASE` — which direction a quote is for.
- **`RouterTradeSource`** enum: `MARKET` (legacy AMM), `ORDERBOOK`, `CLMM` — tags which venue a given route came from.
- **`getQuote(...)`** — single best venue. **`getSplitQuote(...)`** — best price possibly split across multiple venues at once (returns a `SplitQuote` with a `routes[]` breakdown of how much went where).

---

## 10. Checking a wallet's own holdings: `YtPosition`, `SyPosition`, `LpPosition`

These map to the "Your Positions" tab in Exponent's UI (separate from the "Yield Markets" list), and to the same idea as our bot's existing `CHECK_BALANCE` feature.

- **`YtPosition`** (file: `ytPosition.d.ts`) — a wallet's YT holdings for one vault.
  - `YtPosition.loadByOwner(env, connection, owner, vault)` — exactly what our bot's `runCheckBalance` already uses.
  - `YtPosition.loadAllByOwner(env, connection, owner, vaults[])` — the same, but for several vaults in one call — useful if we ever want "show this wallet's YT across every asset" in one go.
  - `.ytBalance` — the raw YT balance.
  - `.getClaimableInterest(currentIndex)` — how much yield this position could currently claim.
  - `.getClaimableEmissions()` — any bonus reward tokens claimable.

- **`SyPosition`** — built via `makeSyPosition(fetcher, flavor, syProgramId, owner)`, a lower-level helper that needs a bit more setup (an `ExponentFetcher` instance) than `YtPosition`. Likely only worth using if `YtPosition` alone doesn't cover something we need.

- **`LpPosition`** (file: `lpPosition.d.ts`) — a wallet's liquidity-provider position, but **only for the legacy `Market` (AMM) venue**. CLMM liquidity positions are tracked differently, through `MarketThree.getUserLpPositions(owner, market)` instead — worth remembering, since it's easy to assume `LpPosition` covers both and it doesn't.

---

## 11. Tranching Markets — a separate, newer product (the "New" tab in your screenshot)

Files: `build/tranching/tranching.d.ts` (the `TranchingMarket` class), plus `types.d.ts`, `stats.d.ts`, `position_stats.d.ts`, `historical.d.ts`, `math.d.ts`, `conversion.d.ts`

Your screenshot's top navigation shows a second tab: **"Tranching Markets [New]"**. This is a genuinely different product from the Yield Markets (PT/YT) system described in Sections 5-10 — not a third venue for the same instrument, but a different financial instrument entirely. You said you'd be using this in the future, so here it is in the same depth as everything above.

### The mental model — Senior/Junior tranches, not PT/YT

A Tranching Market takes one pool of a yield-bearing asset (SY) and splits *depositors* into two risk tiers, instead of splitting the *asset* into principal/yield the way PT/YT does:

- **Senior** depositors get a lower, more protected yield. If the underlying asset ever loses value, Senior is shielded first.
- **Junior** depositors get a higher yield in exchange for absorbing losses first — Junior is the "buffer" that protects Senior.
- **NAV (Net Asset Value)** comes in two forms everywhere in this API: **raw NAV** (the tranche's actual current value) and **effective NAV** (raw NAV adjusted for the protection relationship between the two tranches — this is the number that actually matters for pricing LP tokens and computing APY).
- **Coverage ratio** — how much Junior capital exists relative to Senior capital, as a safety buffer. **Utilization** — how much of that buffer is currently "in use" backing Senior's protection.
- **The "return model"** — the on-chain configuration that governs exactly how yield and losses get redistributed between Senior and Junior (you'll see `TrancheReturnModel` referenced throughout; it's supplied by the market itself, not something you construct).

### Loading a market — `TranchingMarket` class

```ts
TranchingMarket.load(connection, address, env?, options?) → Promise<TranchingMarket>
TranchingMarket.deriveAddresses(seedId, programId?)   // derive the market/return-model/LP-mint/escrow addresses from a seed, without a network call
```

### Reading the current numbers — plain getters (no calculation needed)

- **`getSrNetAssetValue()`** / **`getJrNetAssetValue()`** — raw NAV per tranche. **`getSrEffNetAssetValue()`** / **`getJrEffNetAssetValue()`** — effective (protection-adjusted) NAV per tranche.
- **`getMarketSize()`** / **`getEffectiveMarketSize()`** — total size of the market, raw and effective. Likely the direct source for a "Total Market Size" figure if we add Tranching to the dashboard.
- **`getTargetCoverageRatio()`** (a decimal, e.g. `0.2222` = 22.22%) and its raw-fixed-point sibling `getTargetCoverageRatioRaw()`.
- **`getSrLpCapacity()`** / **`getJrLpCapacity()`** — total LP capacity per tranche. **`getSrRemainingLpCapacity()`** / **`getJrRemainingLpCapacity()`** — how much of that capacity is still open for new deposits.
- **`getSrLpPriceNetAsset()`** / **`getJrLpPriceNetAsset()`** — the price of one LP token in each tranche, in net-asset terms.
- **`getSrMaxCapacityNetAssetValue()`** / **`getJrMaxCapacityNetAssetValue()`**, **`getSrRemainingCapacityNetAssetValue()`** / **`getJrRemainingCapacityNetAssetValue()`** — capacity expressed in NAV terms instead of LP-token terms.
- **`currentSyExchangeRate`**, **`mintBase`**, **`mintLpSenior`** / **`mintLpJunior`**, **`tokenSyEscrow`**, **`syProgram`** — the same kind of plumbing/reference fields you've seen on Vault/Market.
- **"Synced" variants** (`getSyncedSrLpCapacity(syExchangeRate?)`, `getSyncedSrMaxCapacityNetAssetValue(...)`, etc.) — every capacity getter above has a `getSynced...` twin that recomputes the same number at a *different* SY exchange rate you supply, without needing a fresh on-chain read. Useful for "what would this look like right now" without waiting on a new RPC round-trip.

### APY and protection calculators

- **`calculateJuniorApy(underlyingApy)`** / **`calculateSeniorApy(underlyingApy)`** — feed in the underlying asset's yield rate (a decimal, `0.1` = 10%), get back each tranche's actual marginal APY.
- **`calculateJuniorApyAfterDeposit(args)`** / **`calculateSeniorApyAfterDeposit(args)`** — same, but answering "what would the APY become *if* a deposit of this size happened right now" (useful for a "preview before you deposit" style feature, less relevant for a pure market-list dashboard).
- **`calculateSeniorProtection()`** / **`calculateSeniorProtectionAfterDeposit(args)`** — how much downside protection Senior currently has (`protectionPerBaseToken`, `maxDrawdownBeforeSeniorLossPct`), and how a hypothetical deposit would change it.

### Loss-scenario simulators (top-level exports from `tranching/stats.ts`)

A set of "what-if" functions that model a hypothetical market-wide loss and show the fallout: **`calculateSimulatedSeniorApyAfterLoss`**, **`calculateSimulatedSeniorImpactAfterLoss`** (returns either `{status: "protected"}` or `{status: "loss", seniorImpactPercent}`), **`calculateSimulatedJuniorImpactAfterLoss`**, **`calculateSimulatedSeniorPerformanceAfterLoss`** (bundles APY + impact together). These are risk-communication tools — likely how Exponent's own UI shows "here's what happens to your money if the underlying drops X%."

### Position-level stats (`tranching/position_stats.ts`)

For a specific wallet's holding in a tranche, not the market as a whole: **`calculateTranchingPositionNetValue`** (mark an LP amount to current NAV), **`calculateTranchingJuniorEffectiveYieldBoost`** (Junior's APY premium over the plain underlying yield), **`calculateTranchingSeniorEffectiveProtection`** (Senior's downside protection in actual token terms), and **`calculateTranchingPositionStats`** (a bundle of whichever of the above apply, based on which side the position is on). Only relevant for a "your positions" feature, not the market list.

### Historical / charting helpers (`tranching/stats.ts` + `historical.ts`)

A family of functions that all take an array of past snapshots and turn them into ready-to-plot `{timestamp, value}` points: **`calculateHistoricalTrancheApySeries`**, **`buildSyRateSeries`**, **`calculateCoverageRatioSeries`**, **`buildUtilizationSeries`**, **`buildRiskPremiumSeries`**, **`calculateShareApySeries`**, and **`buildLossAbsorbedHistogram`** (buckets losses into fixed time windows). Plus **`calculateHistoricalTranchingMarketState`** / **`calculateHistoricalTranchingLpPriceNetAsset`**, which replay the market's own NAV-sync math against a historical SY exchange rate. **Same theme as CLMM in Section 7: these all need us to have kept our own history of snapshots** — nothing here works from a single live read alone.

### Low-level math/conversion helpers (`math.ts`, `conversion.ts`) — you likely won't call these directly

`math.ts` (`calculateTrancheApyFromNavState`, `calculateTranchingUtilizationRaw`, `calculateJuniorReturnShareRaw`, `calculateSyValueAllocatedRaw`, `calculateLpOut`, plus generic bigint helpers `mulDivCeilBigInt`/`mulDivFloorBigInt`/`minBigInt`) holds the raw formulas the higher-level calculators above are built from. `conversion.ts` (`tranchingToNumber`, `tranchingNumberFromRaw`, `tranchingNumberToRaw`, `tranchingFromNumber`) converts between plain JS numbers/bigints and Exponent's own fixed-point `Number` representation used throughout the Tranching API. You'd only reach for these if one of the higher-level functions above didn't already do what you need.

### TranchingMarket trading methods, in full detail

- **`ixDeposit({user, trancheSide, amountIn, minLpOut?, tokenSrc, tokenLpDst, ...})`** — deposit into a tranche (`trancheSide` picks Senior or Junior), working directly in LP-token terms.
- **`ixWithdraw({user, trancheSide, lpAmountIn, minAmountOut?, tokenLpSrc, tokenDst, ...})`** — burn LP tokens for that tranche, get back the underlying.
- **`ixWrapperDeposit({user, trancheSide, amountBase, minLpOut?, ...})`** / **`ixWrapperWithdraw({user, trancheSide, lpAmountIn, minBaseOut?, ...})`** — the base-asset-denominated wrapper versions, same convenience pattern as the other venues.
- **`ixUpdateMarket()`** — a maintenance/crank instruction that syncs the market's NAV state (similar in spirit to the Kamino `Refresh*` crank transactions seen in the Implementation Plan's yield-timing investigation) — keeps the on-chain NAV current so the next deposit/withdraw prices correctly.
- **`lpMint(trancheSide)`** / **`lpAta(trancheSide, owner)`** — read-only helpers: the LP mint address for a tranche side, and a given owner's associated token account for it.

**Admin-only** (Exponent's own team): `ixInitializeTranchingMarket` (create a brand-new Tranching market), `ixMintProtocolFeeShares` (mint the protocol's accumulated fee share as LP tokens), `ixSetMarketPaused` (pause/unpause the market), `static deriveSyCpiAccountsForInitialize` (setup helper for creating a market).

### Good news: the same discovery pattern from Section 9 works here too

I confirmed `fetchProgramAccountsExponentTranchingMarket(connection, programId)` exists (same "no addresses needed" pattern as `fetchProgramAccountsMarketTwo`/`fetchProgramAccountsMarketThree`), importable from `@exponent-labs/exponent-sdk/client/tranching` alongside its own `EXPONENTTRANCHING_PROGRAM_ID` constant (also re-exported at the very top level of the whole package, so `import { EXPONENTTRANCHING_PROGRAM_ID } from '@exponent-labs/exponent-sdk'` works directly, no subpath needed for the ID itself). So Tranching Markets can be auto-discovered the same reliable way as legacy AMM and CLMM markets — the same two caveats apply, though: no human-readable name on the raw account, and the richer historical stats need us to keep our own snapshot history over time.

---

## 12. A few remaining corners

Everything trading/liquidity-related is now covered in full detail alongside each class above (Sections 5-8, 11). What's left here is genuinely peripheral to Hylo's use case — admin-authority-gated (literally uncallable by anyone outside Exponent's own team), or a different concern entirely:

- **`CodamaEventDecoder`** and the `exponentEvents`/`clmmEvents`/`tranchingEvents` namespaces — decode raw on-chain transaction logs into structured events (e.g., "a trade just happened"). Useful for a live activity feed or historical trade indexing, not for a periodic market-snapshot dashboard. (This is the same kind of decoding used by the `onchain-tx-decode` skill in the trading-bot project, for reference.)
- **Admin-only functions**, gated behind Exponent's own protocol-admin signing authority — `getExponentAdminStatePda`, `adminAction`/`marketAdminAction`, `CollectTreasuryInterestKind`/`CollectTreasuryEmissionKind` (confirmed: treasury fee/emission sweeping, unrelated to yield timing for YT holders), and every class's `ixModify...`/`ixConfigure...`/`ixSetMarketPaused`/`ixInitializeTranchingMarket`-style method. These aren't just "advanced" — Hylo (or any third party) could never call them regardless of future plans, since they require a signing key only Exponent's team holds.
- **`flavors.ts` internals** (`serializeFlavorKamino`, `makeFlavorMarginfiSync`, etc.) — low-level (de)serialization for the yield-source integrations mentioned in Section 2. You'd only touch these directly if `Vault.flavor` alone didn't give you enough detail about the underlying protocol.
- **`@exponent-labs/market-three-math`'s re-exported functions** — `computeExistingPositionBudgetEffect` (confirmed: mirrors the on-chain `compute_existing_position_budget_effect` helper — given an existing CLMM position and a caller-provided max PT/SY budget, computes how much of that budget the position's own "crossing equalization" step would consume before an idempotent add-liquidity call spends the rest; relevant only if building CLMM LP-management tooling), plus `computeExistingPositionEqualization`/`computeRequiredUserMaxForExistingPositionEqualization` (related position-rebalancing math, same LP-management scope).

The `exponentVaults` subsystem is real and substantial, but different enough from everything above that it gets its own section, at the end (Section 15) — per your request.

---

## 13. Best-effort mapping to your screenshot's columns

Educated mapping based on the properties above — **flagged clearly where I'm inferring rather than certain**, since I haven't cross-checked these against Exponent's actual frontend source:

| Screenshot column | Likely source | Confidence |
|---|---|---|
| Implied APY | **Confirmed 2026-07-23, formula corrected and fully validated 2026-07-28: CLMM-derived specifically**, `impliedApy = (Ticks.currentSpotPrice - 1) * 100` (Section 7/9) — this is the number Hylo actually displays/alerts on, not the legacy AMM's `ptApy` (still fetched/saved alongside, per the Implementation Plan, just not the headline figure) | **High, fully confirmed** — matches ONYC's legacy AMM `ptApy` (14.11% vs 14.14%) and the original screenshot's real values for multiple assets |
| Days-to-maturity / date | `Vault.expirationDate` / `.expirationTimestamp` | High |
| Total Market Size | `Market.liquidityPoolTvl` or `MarketThree.calcTvlInBaseToken(...)` | High |
| Liquidity (the smaller figure) | `Market.liquidityAvailable(isBuy, sizePt)`, or an aggregate across venues via `Router` | Medium — needs verifying against one live example |
| Yield Exposure ("122.72x") | Likely derived, roughly `1 / (1 - Market.ptDiscount)` or `1 / YT-price-in-asset` — i.e., how much yield exposure $1 of YT buys | **Low-medium — I have not confirmed the exact formula Exponent uses; verify against a known example before relying on it** |

---

## 14. Quick reference: where everything lives

```
server/node_modules/@exponent-labs/exponent-sdk/build/
├── environment.d.ts       Section 4  — network config (LOCAL_ENV)
├── vault.d.ts              Section 5  — Vault class
├── market.d.ts              Section 6  — legacy AMM (v1)
├── marketThree.d.ts          Section 7  — CLMM (v2)
├── orderbook/                Section 8  — OrderBook (v2) + APY math helpers
├── router.d.ts               Section 9  — cross-venue quotes/splits
├── ytPosition.d.ts, syPosition.d.ts, lpPosition.d.ts   Section 10 — wallet positions
├── tranching/                 Section 11 — Tranching Markets (separate, "New")
├── exponentVaults/            Section 15 — separate Strategy Vaults product
├── flavors.d.ts                Section 2/12 — yield-source identification
├── CodamaEventDecoder.d.ts, codamaEvents.d.ts   Section 12 — event log decoding
└── client/                     Low-level generated program clients underlying all of the above.
    ├── core/    ⭐ Section 9 — fetchProgramAccountsMarketTwo, fetchProgramAccountsVault (market/vault discovery)
    ├── clmm/    ⭐ Section 9 — fetchProgramAccountsMarketThree (CLMM market discovery)
    ├── orderbook/, vaults/, tranching/   Supporting types only for our purposes — no bulk-discovery function found for OrderBook's own accounts (Section 9)
```

Note the two starred paths above are the one part of `client/` we DO need directly — everything else under `client/` is low-level generated plumbing the higher-level classes use internally, and you shouldn't need to touch it.

If anything above turns out to be wrong once we start wiring it up for real (SDK docs can lag behind reality), the fix is simple: open the relevant `.d.ts` file listed above and read it directly — that's exactly what I did to write this document, and it's the authoritative source, not this write-up.

---

## 15. `exponentVaults` — a separate, larger product (moved here per your request)

Files: `build/exponentVaults/` (dozens of files — `vault.ts`, `aumCalculator.ts`, `vaultAssertion.ts`, `loopscale-vault.ts`, `jupiter-lend.ts`, `kamino-markets.ts`, `kamino-farms.ts`, `orca-whirlpool.ts`, `titan-quote.ts`, `proposals/`, `policies/`, `squadsVaultTxnResolver/`, and more)

This is a genuinely different Exponent product from everything in Sections 1-14 — not another PT/YT venue, but **automated, multi-strategy leveraged-yield vaults**: a wallet deposits into a strategy vault, and the vault itself automatically deploys that capital across other DeFi protocols (Kamino lending/farms, Jupiter Lend, Loopscale, Orca Whirlpool, Titan) to generate yield, all governed by an on-chain policy/proposal system. Unrelated to the Yield Markets (PT/YT) dashboard this document otherwise focuses on — included here for completeness, at a lighter level of detail than Sections 5-11, since it's a different product line entirely.

### The mental model

- **`ExponentVault`** — the core class, analogous to `Vault`/`Market` elsewhere but for a strategy vault: tracks the vault's holdings, its policies, and its governance state.
- **A vault's capital gets deployed via integrations with external protocols** — each integration (Kamino, Jupiter Lend, Loopscale, Orca Whirlpool, Titan) has its own file with program IDs, instruction builders, and account-layout constants (e.g. `KAMINO_LENDING_PROGRAM_ID`, `createJupiterEarnDepositInstruction`, `deriveLoopscaleStrategyAddress`).
- **Policies** (`policies/`) — an on-chain permissioning system that constrains what a vault manager is allowed to do (e.g. "this manager may only deposit into Kamino, only up to this size, only into this specific reserve"). `createKaminoDepositPolicy`, `createOrderbookPolicy`, `createClmmPolicy`, etc. build these constraint definitions.
- **Proposals** (`proposals/`) — a Squads-style multisig governance flow for approving vault actions: `createInitProposalInstruction` → `createStakeVoteInstruction`/`createUnstakeVoteInstruction` (voting) → `createActivateProposalInstruction` → `createExecuteProposalInstruction` → `createFinalizeProposalInstruction`, with `createCancelProposalInstruction` available along the way. `ProposalStatus`/`VoteChoice` track where a proposal is in that lifecycle.
- **`VaultAssertion`** — an automated condition-checking system (`VaultAssertionConditionKind`, and specific condition types like `KaminoLtvCondition`, `ClmmPriceCondition`, `OrderbookPriceCondition`, `SyExchangeRateCondition`) — lets the vault verify real-time conditions across its various integrations before allowing an action, e.g. "only proceed if this Kamino position's loan-to-value is still below X."
- **`AumCalculator`** — computes the vault's total Assets Under Management across all its deployed positions (its own class, with a `PositionType` enum for the different position kinds it can value).
- **`InstantWithdrawalCapacity`** — models how much a user could withdraw immediately vs. having to wait for the vault to unwind a position first.
- **Scope refresh** (`scope-refresh.ts`) — builds the same kind of "refresh this oracle/reserve price before acting" crank instructions seen in the Kamino transaction logs from the Implementation Plan's yield-timing investigation (Section 6c there) — a recurring pattern across Solana lending integrations, not unique to this subsystem.
- **`findFreshVaultSquadsAccounts`** — resolves the current Squads multisig accounts associated with a vault (Squads is the underlying multisig program the proposal/voting system is built on).

### Why this is out of scope for Hylo today

Everything above serves *managing and governing an automated strategy vault* — a fundamentally different product from *displaying Yield Market data*. None of Hylo's current or near-term plans (per the Implementation Plan) touch this. It's documented here at this lighter level, rather than left out entirely, purely so you have a map of it if it ever becomes relevant.
