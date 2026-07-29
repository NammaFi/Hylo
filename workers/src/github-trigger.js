// Server-side replacement for src/services/ratexApi.ts's triggerWorkflowRefresh(), which read a
// client-exposed VITE_GITHUB_WORKFLOW_TOKEN (Vite bundles every VITE_* var into public JS — a
// real, live security issue, see IMPLEMENTATION_PHASES.md). This Worker holds a token as a
// server-side secret (env.GITHUB_TOKEN) instead, and triggers the scrape on its own reliable
// 5-minute schedule rather than waiting for a visitor's browser to notice stale data — same
// GitHub endpoint/payload as the code it replaces, just never shipped to a browser.
//
// Reuses the SAME env.GITHUB_TOKEN as gist.js's read/write calls (per your call to reuse tokens
// rather than mint a second one) — this single PAT needs both `gist` scope (for the Gist calls)
// and `workflow` scope (for this dispatch call). If the existing GIST_TOKEN GitHub Actions secret
// already has `workflow` scope too, copy that exact value in as this Worker's GITHUB_TOKEN secret
// and nothing new needs to be created. If a 403/404 shows up here specifically (scope-related —
// GitHub returns 404, not 401, for a dispatch call when the token lacks `workflow` scope), the
// existing token needs its scope widened, or a new classic PAT needs `gist` + `workflow` checked
// at https://github.com/settings/tokens.

export async function triggerRateXWorkflow(env) {
  const res = await fetch(
    'https://api.github.com/repos/NammaFi/Hylo/actions/workflows/scrape-ratex.yml/dispatches',
    {
      method: 'POST',
      headers: {
        'Accept': 'application/vnd.github+json',
        'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        'User-Agent': 'Hylo-Exponent-Worker',
      },
      body: JSON.stringify({ ref: 'main' }),
    }
  );

  if (res.status === 204) {
    console.log('RateX workflow dispatch triggered');
    return true;
  }
  console.warn(`RateX workflow dispatch failed: ${res.status} ${await res.text()}`);
  return false;
}
