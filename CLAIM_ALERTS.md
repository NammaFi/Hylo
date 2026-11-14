# Claimable-yield Telegram alerts

Alerts on the **claimable yield** of a wallet's Exponent YT positions, next to the existing implied-yield alerts.
Everything is managed from `yield-manager.html` (tab **Claimable Yield**); the same bot (@yieldtrading_bot) sends the messages.

## How it works

```
Worker cron (every 1 min) --> Vercel api/claim-check.js --> Telegram
                                  | reads  claim-alert-config.json  (alerts Gist; written ONLY by yield-manager.html)
                                  | reads/writes claim-alert-state.json (alerts Gist; written ONLY by claim-check)
                                  | one getMultipleAccounts (positions + vaults) + the Exponent markets API (rate)
```

* Claimable = exactly what the Exponent SDK's `getClaimableInterest` returns (verified identical to the raw unit on 45 live positions):
  asset units, net of the 5.5 % vault fee. USD assets are dollars; SOL assets are converted with the Jupiter SOL price (the threshold is typed in dollars);
  any other asset (hyUSD, STRC, ...) is shown and compared in its own units.
* Rate used = the larger of the Exponent API's `syExchangeRate` and the vault's stored rate (what the SDK does).
* **Arming:** saving a pair as enabled makes the *claimable at that moment* its baseline (silent, one "armed" message). A new wallet re-arms every pair.
* **Alert:** claimable - baseline >= the pair's minimum increase (blank = any increase above $0.001) starts a burst:
  one message per minute, 10 messages (`n/10`), then silence; the baseline becomes the claimable at the last message and the pair waits for a further increase.
* **Claim:** the claimable falling below half of its previous value on two consecutive checks = claimed: burst stops, baseline resets, one "CLAIMED" message.
* One wallet for all assets (the box in the tab, default FCC8...BCTm). Disabled pairs are removed from the config; re-enabling re-arms.

## Files

| File | Role |
|---|---|
| `lib/claim-core.js` | all logic (PDA, decode, claimable formula, state machine, runner, real network deps) |
| `api/claim-check.js` | Vercel endpoint (thin wrapper), counters-only public response |
| `workers/src/yield-alert.js`, `workers/src/index.js` | `triggerClaimCheck()` called on every 1-minute cron tick |
| `../yield-manager.html` (outside the repo) | the control surface (new tab; the implied-yield tab is unchanged) |

## Deploy (in this order)

1. Vercel project env: add **`CLAIM_RPC_URL`** = a Solana RPC URL (a dedicated Helius key; about 1,440 calls/day). `YIELD_BOT_TOKEN`, `ALERTS_GIST_ID`, `GIST_TOKEN` are already there. Redeploy Vercel (commit + push as usual).
2. `cd workers && npx wrangler deploy` (adds the claim-check call to the 1-minute cron).
3. Reload `yield-manager.html`, open the **Claimable Yield** tab, enable pairs, Save.

Check: `https://hylo-community-hub.vercel.app/api/claim-check` answers `{"ok":true,...}` (counters only). Missing env -> `{"ok":false,"error":"missing environment variable(s): ..."}`.
The tab's status strip shows when the checker last ran (it writes at least every 5 minutes, and at every change).

## Notes

* Detection time = up to 1 minute (cron) + the time until the vault shows the new yield (Scope tokens such as ONyc / srONyc: the first transaction that refreshes the vault; SOL tokens: the stake-pool update).
* An outage of the RPC / API for 15 minutes sends one warning message, and one note when it recovers.
* Constants (top of `lib/claim-core.js`): `BURST_MESSAGES` 10, `DUST_USD` 0.001, `MIN_SEND_GAP_MS` 50 s, `FAIL_WARN_STREAK` 15, `HEARTBEAT_MS` 5 min.
* `yield-manager.html` contains the GitHub token in plain text (as before): keep the file local, never commit or share it.
* Tests live in `C:\Work\Exponent\backups\2026-11-14_claim-alert-tests\` (README inside).
