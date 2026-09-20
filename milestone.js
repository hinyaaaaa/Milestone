/* ============================================================
   milestone.js — マイルストーン予測・勢い計算
   ------------------------------------------------------------
   純粋関数のみで構成する(DOM/Three.js/fetch等への依存を一切持たない)。
   入力: 動画の履歴配列 [{t: unixSec, views: number}, ...](古い→新しい順)
   出力: 次のマイルストーン・到達予測日時・勢い(万/日換算)

   予測ロジックは元ツール(kanade-milestone)のREADMEに明記された方式を
   踏襲する: 「直近72時間の区間に対する最小二乗近似直線」を使い、
   その直線がマイルストーン再生数に到達する時刻を線形に外挿する。
   ============================================================ */

const REGRESSION_WINDOW_SEC = 72 * 3600; // 直近72時間
const MOMENTUM_WINDOW_SEC = 24 * 3600;   // 勢い計算に使う移動平均の窓

/**
 * 履歴配列から直近windowSec秒以内の点だけを抜き出す。
 * @param {Array<{t:number, views:number}>} history
 * @param {number} nowSec
 * @param {number} windowSec
 */
function windowedPoints(history, nowSec, windowSec) {
  const cutoff = nowSec - windowSec;
  return history.filter((p) => p.t >= cutoff);
}

/**
 * 最小二乗法で単回帰(views = slope * t + intercept)を求める。
 * @param {Array<{t:number, views:number}>} points
 * @returns {{slope:number, intercept:number} | null} 点が2点未満ならnull
 */
export function leastSquaresFit(points) {
  const n = points.length;
  if (n < 2) return null;

  let sumT = 0, sumV = 0, sumTT = 0, sumTV = 0;
  points.forEach((p) => {
    sumT += p.t;
    sumV += p.views;
    sumTT += p.t * p.t;
    sumTV += p.t * p.views;
  });
  const denom = n * sumTT - sumT * sumT;
  if (denom === 0) return null; // 全点が同一時刻(理論上は起きないが安全策)

  const slope = (n * sumTV - sumT * sumV) / denom;
  const intercept = (sumV - slope * sumT) / n;
  return { slope, intercept };
}

/**
 * 現在の再生数から見て、次に到達するマイルストーン(milestoneStepの倍数)を返す。
 * 既にちょうど倍数の場合は、その次の倍数を返す(「次に目指す節目」という定義のため)。
 * @param {number} currentViews
 * @param {number} milestoneStep
 */
export function nextMilestone(currentViews, milestoneStep) {
  if (!(milestoneStep > 0)) return null;
  const n = Math.floor(currentViews / milestoneStep) + 1;
  return n * milestoneStep;
}

/**
 * 直近の「達成済み」マイルストーン(現在の再生数以下で最大の倍数)を返す。
 * 達成後48時間以内かどうかの色分け判定に使う。
 * @param {number} currentViews
 * @param {number} milestoneStep
 */
export function lastAchievedMilestone(currentViews, milestoneStep) {
  if (!(milestoneStep > 0) || currentViews < milestoneStep) return null;
  return Math.floor(currentViews / milestoneStep) * milestoneStep;
}

/**
 * 履歴から「勢い」(1日あたりの再生数増加ペース)を24時間移動平均で計算する。
 * 窓内に十分な点がない場合は、ある範囲で近似する(データが浅い動画向けの
 * フォールバック)。
 * @param {Array<{t:number, views:number}>} history
 * @param {number} nowSec
 * @returns {number} 1日あたりの増加数(views/day)。データ不足ならNaN。
 */
export function computeMomentum(history, nowSec) {
  const windowed = windowedPoints(history, nowSec, MOMENTUM_WINDOW_SEC);
  if (windowed.length >= 2) {
    const first = windowed[0];
    const last = windowed[windowed.length - 1];
    const spanSec = last.t - first.t;
    if (spanSec <= 0) return NaN;
    const deltaViews = last.views - first.views;
    return (deltaViews / spanSec) * 86400;
  }
  // フォールバック: 全履歴の最初と最後の2点だけで近似する
  if (history.length >= 2) {
    const first = history[0];
    const last = history[history.length - 1];
    const spanSec = last.t - first.t;
    if (spanSec <= 0) return NaN;
    return ((last.views - first.views) / spanSec) * 86400;
  }
  return NaN;
}

/**
 * マイルストーン到達予測(ETA)を計算する。
 * @param {Array<{t:number, views:number}>} history 古い→新しい順
 * @param {number} milestoneStep
 * @param {number} [nowSec] 省略時は現在時刻
 * @returns {{
 *   currentViews: number,
 *   milestone: number,
 *   viewsRemaining: number,
 *   momentumPerDay: number,
 *   etaSec: number | null,       // 予測到達時刻(unix秒)。予測不能ならnull
 *   achievedRecently: boolean,   // 過去48時間以内に(直前の)節目を達成したか
 *   achievedWithin24h: boolean,  // 過去24時間以内(48h超では薄いゴールドにするための区別)
 *   progressRatio: number,       // 前の節目から次の節目までの進捗(0〜1)
 * } | null} 履歴が空ならnull
 */
export function computeMilestoneState(history, milestoneStep, nowSec = Math.floor(Date.now() / 1000)) {
  if (!history.length) return null;
  const currentViews = history[history.length - 1].views;
  const milestone = nextMilestone(currentViews, milestoneStep);
  const viewsRemaining = milestone - currentViews;
  const momentumPerDay = computeMomentum(history, nowSec);

  const regressionPoints = windowedPoints(history, nowSec, REGRESSION_WINDOW_SEC);
  const fit = leastSquaresFit(regressionPoints.length >= 2 ? regressionPoints : history);

  let etaSec = null;
  if (fit && fit.slope > 0) {
    // views = slope*t + intercept → t = (milestone - intercept) / slope
    const candidate = (milestone - fit.intercept) / fit.slope;
    if (candidate > nowSec) etaSec = candidate;
  }

  const prevMilestone = milestone - milestoneStep;
  const achievedAt = findAchievementTime(history, prevMilestone);
  const achievedRecently = achievedAt != null && nowSec - achievedAt <= 48 * 3600;
  const achievedWithin24h = achievedAt != null && nowSec - achievedAt <= 24 * 3600;

  const progressRatio = milestoneStep > 0
    ? Math.max(0, Math.min(1, (currentViews - prevMilestone) / milestoneStep))
    : 0;

  return {
    currentViews,
    milestone,
    viewsRemaining,
    momentumPerDay,
    etaSec,
    achievedRecently,
    achievedWithin24h,
    progressRatio,
  };
}

/**
 * 履歴の中で、再生数が指定した節目を初めて超えた時刻を探す。
 * @param {Array<{t:number, views:number}>} history
 * @param {number} milestoneViews
 * @returns {number | null}
 */
function findAchievementTime(history, milestoneViews) {
  if (milestoneViews <= 0) return null;
  for (let i = 0; i < history.length; i++) {
    if (history[i].views >= milestoneViews) return history[i].t;
  }
  return null;
}

/** 万単位の日本語表記に整形する(例: 1234567 → "123.5万") */
export function formatManUnit(n) {
  if (!isFinite(n)) return '—';
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  return `${sign}${(abs / 10000).toFixed(1)}万`;
}

/** 再生数を3桁カンマ区切りで整形する */
export function formatViews(n) {
  if (!isFinite(n)) return '—';
  return Math.floor(n).toLocaleString('ja-JP');
}
