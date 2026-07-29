// Gist read/write, structured so this Worker only ever touches the "exponent"-sourced slice of
// the assets array. RateX entries (written independently by server/scrape-once.js on its own GH
// Actions cadence) are read back untouched and re-written as-is — this Worker never overwrites
// them and never needs to coordinate/lock with the other writer, since each writer only ever
// replaces its own source's entries wholesale.
//
// Auth: reuses env.GITHUB_TOKEN — the SAME token as github-trigger.js's workflow-dispatch call
// (see that file's header for the scope requirement), which itself can be the exact same GitHub
// PAT already stored as the GIST_TOKEN secret in .github/workflows/scrape-ratex.yml, as long as
// that PAT already has `workflow` scope alongside `gist` — no new token needed in that case.

const GITHUB_API = 'https://api.github.com';

export async function getGist(env) {
  const res = await fetch(`${GITHUB_API}/gists/${env.GIST_ID}`, {
    headers: {
      'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'Hylo-Exponent-Worker',
    },
  });
  if (!res.ok) {
    throw new Error(`Failed to read gist: ${res.status} ${await res.text()}`);
  }
  const gist = await res.json();
  const content = gist.files?.['ratex-assets.json']?.content;
  if (!content) return { lastUpdated: null, assetsCount: 0, assets: [], xsolMetrics: null };
  return JSON.parse(content);
}

export async function updateGist(env, data) {
  const res = await fetch(`${GITHUB_API}/gists/${env.GIST_ID}`, {
    method: 'PATCH',
    headers: {
      'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
      'Accept': 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'Hylo-Exponent-Worker',
    },
    body: JSON.stringify({
      files: {
        'ratex-assets.json': {
          content: JSON.stringify(data, null, 2),
        },
      },
    }),
  });
  if (!res.ok) {
    throw new Error(`Failed to update gist: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

/**
 * Replace only the `source === 'exponent'` entries in the existing Gist with a freshly-fetched
 * set, leaving every other entry (RateX, and anything else that might show up later) untouched.
 */
export function mergeExponentAssets(existingData, freshExponentAssets) {
  const preservedAssets = (existingData.assets ?? []).filter(a => a.source !== 'exponent');
  return {
    ...existingData,
    lastUpdated: new Date().toISOString(),
    assets: [...preservedAssets, ...freshExponentAssets],
    assetsCount: preservedAssets.length + freshExponentAssets.length,
  };
}
