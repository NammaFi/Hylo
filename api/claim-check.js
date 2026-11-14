/**
 * Vercel Serverless Function — Claimable-Yield Alert Checker
 *
 * Sibling of yield-check.js (which does the implied-yield alerts). Reads the wallet's Exponent YT
 * positions from the chain, computes the claimable yield and runs the alert rules (arm on enable,
 * increase since the baseline starts 10 one-per-minute messages, a claim resets). All logic lives
 * in ../lib/claim-core.js; this file only wires the real network dependencies.
 *
 * Called by: the Cloudflare Worker's 1-minute cron (workers/src/yield-alert.js -> triggerClaimCheck).
 *
 * GET /api/claim-check
 *
 * Environment variables:
 *   YIELD_BOT_TOKEN  — Bot token for @yieldtrading_bot            (already set for yield-check)
 *   ALERTS_GIST_ID   — Shared alerts Gist                          (already set)
 *   GIST_TOKEN       — GitHub token with Gist permissions          (already set)
 *   CLAIM_RPC_URL    — Solana RPC URL (a Helius key; ONE getMultipleAccounts call per minute)   (NEW)
 *
 * Config file (written ONLY by yield-manager.html): claim-alert-config.json in the alerts Gist.
 * State file (written ONLY by this function):       claim-alert-state.json in the alerts Gist.
 * The existing cr-alert-subscribers.json is never touched.
 */

import { runClaimCheck, makeRealDeps } from '../lib/claim-core.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const missing = ['YIELD_BOT_TOKEN', 'ALERTS_GIST_ID', 'GIST_TOKEN', 'CLAIM_RPC_URL'].filter((k) => !process.env[k]);
  if (missing.length) {
    console.error('Claim check: missing env ' + missing.join(', '));
    return res.status(200).json({ ok: false, error: 'missing environment variable(s): ' + missing.join(', ') });
  }

  try {
    const result = await runClaimCheck(makeRealDeps(process.env));
    if (!result.ok) console.error('Claim check error:', result.error);
    else console.log(`Claim check: ${result.checked} pairs checked, ${result.sent} burst messages, ${result.armed} armed, ${result.claimed} claimed, ${result.errors} errors`);
    // counters only: no wallet, no amounts in the public response
    return res.status(200).json(result);
  } catch (error) {
    console.error('Claim check fatal error:', error);
    return res.status(500).json({ ok: false, error: 'internal error' });
  }
}
