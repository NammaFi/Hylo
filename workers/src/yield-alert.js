// Server-side port of scrape-once.js's triggerYieldAlertCheck() — a plain GET to the existing
// Vercel endpoint that does the actual threshold-check + Telegram/email alert sending. Nothing
// alert-specific lives in this Worker; it just calls the same endpoint scrape-once.js already
// calls after every Gist update, so a 1-minute Exponent update gets the same alerting coverage a
// 5-minute RateX+Exponent run always has.

// Claimable-yield alerts (2026-11-14): the same kind of plain GET, to the sibling endpoint
// api/claim-check.js (reads the wallet's YT positions from the chain, runs the burst rules, sends the
// Telegram messages). Called on every 1-minute cron tick, independent of the Exponent API update above,
// so an API hiccup never skips a tick. A failure here only logs: it never affects the other jobs.
export async function triggerClaimCheck() {
  try {
    const res = await fetch('https://hylo-community-hub.vercel.app/api/claim-check');
    if (!res.ok) {
      console.warn(`Claim check returned ${res.status}`);
      return;
    }
    const result = await res.json();
    if (result.ok) {
      console.log(`Claim alerts: ${result.checked} pairs checked, ${result.sent} burst messages, ${result.armed} armed, ${result.claimed} claimed, ${result.errors} errors`);
    } else {
      console.warn(`Claim check: ${result.error || 'unknown error'}`);
    }
  } catch (err) {
    console.warn(`Claim check failed: ${err.message}`);
  }
}

export async function triggerYieldAlertCheck() {
  try {
    const res = await fetch('https://hylo-community-hub.vercel.app/api/yield-check');
    if (!res.ok) {
      console.warn(`Yield alert check returned ${res.status}`);
      return;
    }
    const result = await res.json();
    if (result.ok) {
      console.log(`Yield alerts: ${result.checked} checked, ${result.alerts} alerts sent`);
    } else {
      console.warn(`Yield alert check: ${result.error || 'unknown error'}`);
    }
  } catch (err) {
    console.warn(`Yield alert check failed: ${err.message}`);
  }
}
