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
 * Fill in visual-asset fields (icon/background/project name) for freshly-fetched Exponent assets
 * that don't already have one. Priority: Exponent's own icon (exponent-fetch.js already set
 * projectBackgroundImage/assetSymbolImage from asset-registry.json's `static.logo`, resolved via
 * the real Metaplex-metadata → icon chain in fetch-exponent-rpc.js's getPtMetadata — NOT
 * guessable, NOT from the site API, which has no icon field at all) always wins when present.
 * Only when it's missing (a newly-discovered asset not yet in the registry) do we fall back to a
 * RateX entry for the same baseAsset (rate-x.io hosts its own icons, a different platform's
 * artwork for the same underlying asset), then whatever the previous Gist entry for this exact
 * asset key already had, then null.
 *
 * Without any of this, every Exponent record ships with null icons (before the registry had real
 * logos, `static.logo` was never filled in) — once this Worker's 1-minute writes overtook
 * scrape-once.js's own RateX-fallback icon logic, icons vanished within a minute of every GH
 * Actions run — confirmed live 2026-07-29 (hyloSOL: null both fields).
 */
export function enrichVisualAssets(freshExponentAssets, existingData) {
  const existingAssets = existingData.assets ?? [];
  const ratexByBaseAsset = new Map(
    existingAssets
      .filter(a => a.source === 'ratex' && a.baseAsset)
      .map(a => [a.baseAsset.toLowerCase(), a])
  );
  const oldByAssetKey = new Map(existingAssets.map(a => [a.asset, a]));

  return freshExponentAssets.map(asset => {
    if (asset.projectBackgroundImage) {
      return asset; // already has Exponent's own icon (registry static.logo) — keep it
    }
    const ratexMatch = ratexByBaseAsset.get(asset.baseAsset?.toLowerCase());
    if (ratexMatch?.projectBackgroundImage) {
      return {
        ...asset,
        projectBackgroundImage: ratexMatch.projectBackgroundImage,
        projectName: ratexMatch.projectName,
        assetSymbolImage: ratexMatch.assetSymbolImage,
      };
    }
    const oldAsset = oldByAssetKey.get(asset.asset);
    if (oldAsset?.projectBackgroundImage) {
      return {
        ...asset,
        projectBackgroundImage: oldAsset.projectBackgroundImage,
        projectName: oldAsset.projectName,
        assetSymbolImage: oldAsset.assetSymbolImage,
      };
    }
    return asset;
  });
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
