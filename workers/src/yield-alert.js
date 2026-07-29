// Server-side port of scrape-once.js's triggerYieldAlertCheck() — a plain GET to the existing
// Vercel endpoint that does the actual threshold-check + Telegram/email alert sending. Nothing
// alert-specific lives in this Worker; it just calls the same endpoint scrape-once.js already
// calls after every Gist update, so a 1-minute Exponent update gets the same alerting coverage a
// 5-minute RateX+Exponent run always has.

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
