/* ============================================================
   data-loader.js — public_data.json / public_config.json 読み込み
   ------------------------------------------------------------
   完全に静的なfetchのみ。APIキーは一切扱わない(公開専用の設計、
   個人モードは実装しない方針のため)。
   ============================================================ */

/**
 * @param {string} path
 * @returns {Promise<object>}
 */
async function fetchJson(path) {
  // GitHub Pagesのキャッシュに阻まれて更新が反映されないのを避けるため、
  // 現在時刻をクエリに付けてキャッシュを回避する。データ自体は30分おき
  // にしか変わらないので、頻繁なfetchによる帯域浪費は起きない
  // (呼び出し頻度は呼び出し側のポーリング設計に委ねる)。
  const res = await fetch(`${path}?_=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${path} の取得に失敗しました (HTTP ${res.status})`);
  return res.json();
}

/**
 * @returns {Promise<{channels: object, videos: object, lastUpdated: string|null}>}
 */
export async function loadPublicData() {
  return fetchJson('public_data.json');
}

/**
 * @returns {Promise<{defaultMilestoneStep:number, soonThresholdDays:number, channels:object}>}
 */
export async function loadPublicConfig() {
  return fetchJson('public_config.json');
}
