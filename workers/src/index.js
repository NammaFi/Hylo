// Hylo Exponent Worker — two jobs on two Cron Triggers (see wrangler.toml), consolidated into
// one Worker since Cloudflare's free tier allows up to 3 crons per Worker and there's no benefit
// to splitting them into separate deployments:
//
//   * * * * *   (every 1 min) -> fetch Exponent's own site API, merge into the shared Gist,
//                                  touching only `source: 'exponent'` entries, then run the same
//                                  yield-alert check scrape-once.js runs after every update.
//                                  API-only, no RPC fallback here by design — see
//                                  exponent-fetch.js's header.
//   */5 * * * * (every 5 min) -> trigger the RateX GitHub Actions workflow server-side, replacing
//                                  the insecure client-side VITE_GITHUB_WORKFLOW_TOKEN trigger.
//
// server/scrape-once.js (GH Actions, still on its own 5-min cron) is UNCHANGED — it keeps doing
// both RateX + Exponent, with the full RPC fallback, as the resilience baseline. This Worker only
// adds faster Exponent updates in between those runs; if this Worker's job silently stopped
// entirely, the site would just fall back to the existing 5-minute cadence, not go stale forever.
import { fetchExponentAssets } from './exponent-fetch.js';
import { calculateYtMetrics, calculateMaturesIn, calculateDaysToMaturity } from './yt-metrics.js';
import { getGist, updateGist, mergeExponentAssets, enrichVisualAssets } from './gist.js';
import { triggerRateXWorkflow } from './github-trigger.js';
import { triggerYieldAlertCheck } from './yield-alert.js';

const EXPONENT_CRON = '* * * * *';
const RATEX_TRIGGER_CRON = '*/5 * * * *';

async function runExponentUpdate(env) {
  const freshAssets = await fetchExponentAssets({ calculateYtMetrics, calculateMaturesIn, calculateDaysToMaturity });
  if (!freshAssets) {
    console.warn('Skipping Exponent Gist update this run — API unavailable or returned no markets');
    return;
  }

  const existingData = await getGist(env);
  const enrichedAssets = enrichVisualAssets(freshAssets, existingData);
  const merged = mergeExponentAssets(existingData, enrichedAssets);
  await updateGist(env, merged);
  console.log(`Updated Gist: ${freshAssets.length} Exponent assets, ${merged.assetsCount} total`);

  await triggerYieldAlertCheck();
}

export default {
  async scheduled(event, env, ctx) {
    if (event.cron === EXPONENT_CRON) {
      ctx.waitUntil(
        runExponentUpdate(env).catch(err => console.error('Exponent update failed:', err.message))
      );
    } else if (event.cron === RATEX_TRIGGER_CRON) {
      ctx.waitUntil(
        triggerRateXWorkflow(env).catch(err => console.error('RateX trigger failed:', err.message))
      );
    } else {
      console.warn(`Unrecognized cron fired: ${event.cron}`);
    }
  },

  // Plain health-check response. Live-on-visit fetching (fetch fresh Exponent data the moment
  // someone loads the site) is deprioritized per your call — the 1-minute cron plus a reliably
  // triggered 5-minute RateX run is considered sufficient for now. Revisit as a future phase if
  // that turns out not to be fresh enough in practice.
  async fetch(request, env, ctx) {
    return new Response('Hylo Exponent Worker is running.\n', {
      status: 200,
      headers: { 'Content-Type': 'text/plain' },
    });
  },
};
