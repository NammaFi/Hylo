/**
 * Manual refresh functionality for triggering backend workflow
 * 
 * To use this in your frontend:
 * 1. Add a "Refresh Data" button
 * 2. Call triggerRefresh() when clicked
 * 3. User waits ~30-60 seconds while scraper runs
 * 4. Then fetch fresh data from backend
 */

const GITHUB_OWNER = 'NammaFi';
const GITHUB_REPO = 'Hylo';
const WORKFLOW_NAME = 'scrape-ratex.yml';

/**
 * Trigger backend workflow to refresh data
 * NOTE: This requires a GitHub token with workflow permissions
 * You'll need to add GITHUB_TOKEN to your Vercel environment variables
 */
export async function triggerRefresh() {
  const token = import.meta.env.VITE_GITHUB_TOKEN;
  
  if (!token) {
    console.warn('No GitHub token configured - manual refresh disabled');
    throw new Error('Manual refresh not configured. Data auto-updates every 5 minutes.');
  }
  
  try {
    const response = await fetch(
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/workflows/${WORKFLOW_NAME}/dispatches`,
      {
        method: 'POST',
        headers: {
          'Authorization': `token ${token}`,
          'Accept': 'application/vnd.github.v3+json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          ref: 'main' // or 'web_scraping_start' depending on your branch
        })
      }
    );
    
    if (!response.ok) {
      throw new Error(`Failed to trigger refresh: ${response.status}`);
    }
    
    console.log('✅ Refresh triggered! Data will update in ~30-60 seconds');
    return true;
  } catch (error) {
    console.error('Error triggering refresh:', error);
    throw error;
  }
}

/**
 * Check if a workflow is currently running
 */
export async function isRefreshInProgress() {
  try {
    const response = await fetch(
      `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/workflows/${WORKFLOW_NAME}/runs?status=in_progress&per_page=1`
    );
    
    if (!response.ok) return false;
    
    const data = await response.json();
    return data.total_count > 0;
  } catch {
    return false;
  }
}

/**
 * Example usage in a React component:
 * 
 * const handleRefresh = async () => {
 *   setLoading(true);
 *   try {
 *     await triggerRefresh();
 *     
 *     // Wait for scraper to complete (~30-60 seconds)
 *     await new Promise(resolve => setTimeout(resolve, 45000));
 *     
 *     // Fetch fresh data
 *     const freshData = await fetchAllAssets();
 *     setAssets(freshData);
 *   } catch (error) {
 *     console.error('Refresh failed:', error);
 *   } finally {
 *     setLoading(false);
 *   }
 * };
 */
