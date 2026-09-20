/* ============================================================
   chart.js — 推移グラフ描画(canvas)
   ------------------------------------------------------------
   カード内で開閉するミニグラフ。元ツールの仕様(README)に合わせ、
   青=再生数(累積・左軸)、緑=勢い(24h移動平均・右軸)、オレンジ帯+破線=
   直近72時間の回帰区間、を描く。ホバーで日付・再生数・勢いを表示する。

   依存はcanvas 2D contextのみ(Chart.js等のライブラリは使わない —
   単純なスパークライン用途にライブラリを追加するのは過剰なため、
   DESIGN_CONSTRAINTS.mdの「依存関係は必要最小限」に合わせた)。
   ============================================================ */
import { leastSquaresFit } from './milestone.js';

const REGRESSION_WINDOW_SEC = 72 * 3600;
const MOMENTUM_SAMPLE_STEP = 3600; // 勢い系列を1時間刻みでサンプルする

function computeMomentumSeries(history) {
  // 各点について、その時刻を中心にした24h移動平均の傾き(views/day)を計算する。
  // 単純化のため「直前24h窓の平均勢い」を各点に割り当てる。
  const out = [];
  for (let i = 0; i < history.length; i++) {
    const t = history[i].t;
    const windowStart = t - 24 * 3600;
    let j = i;
    while (j > 0 && history[j - 1].t >= windowStart) j--;
    if (j === i) continue; // 窓内に他の点がない
    const spanSec = t - history[j].t;
    if (spanSec <= 0) continue;
    const deltaViews = history[i].views - history[j].views;
    out.push({ t, momentum: (deltaViews / spanSec) * 86400 });
  }
  return out;
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {Array<{t:number, views:number}>} history 古い→新しい順
 */
export function drawHistoryChart(canvas, history) {
  if (!history || history.length < 2) {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    return;
  }

  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 300;
  const cssH = canvas.clientHeight || 120;
  canvas.width = cssW * dpr;
  canvas.height = cssH * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, cssW, cssH);

  const pad = { t: 10, r: 44, b: 18, l: 44 };
  const gw = cssW - pad.l - pad.r;
  const gh = cssH - pad.t - pad.b;

  const tMin = history[0].t;
  const tMax = history[history.length - 1].t;
  const tSpan = Math.max(1, tMax - tMin);

  const viewsMin = Math.min(...history.map((p) => p.views));
  const viewsMax = Math.max(...history.map((p) => p.views));
  const viewsSpan = Math.max(1, viewsMax - viewsMin);

  const momentumSeries = computeMomentumSeries(history);
  const momentumVals = momentumSeries.map((p) => p.momentum).filter((v) => isFinite(v));
  const momentumMax = momentumVals.length ? Math.max(...momentumVals, 0) : 1;
  const momentumMin = momentumVals.length ? Math.min(...momentumVals, 0) : 0;
  const momentumSpan = Math.max(1, momentumMax - momentumMin);

  const xOf = (t) => pad.l + ((t - tMin) / tSpan) * gw;
  const yViewsOf = (v) => pad.t + gh - ((v - viewsMin) / viewsSpan) * gh;
  const yMomentumOf = (v) => pad.t + gh - ((v - momentumMin) / momentumSpan) * gh;

  // 回帰区間(直近72h)の帯
  const regressionCutoff = tMax - REGRESSION_WINDOW_SEC;
  const regressionPoints = history.filter((p) => p.t >= regressionCutoff);
  if (regressionPoints.length >= 1) {
    const bandX = xOf(Math.max(tMin, regressionCutoff));
    ctx.fillStyle = 'rgba(246,198,99,0.10)';
    ctx.fillRect(bandX, pad.t, cssW - pad.r - bandX, gh);
  }

  // 回帰直線(破線)
  const fit = leastSquaresFit(regressionPoints.length >= 2 ? regressionPoints : history);
  if (fit) {
    ctx.save();
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = 'rgba(246,198,99,0.85)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    const x1 = regressionPoints.length >= 2 ? regressionPoints[0].t : history[0].t;
    const x2 = tMax + tSpan * 0.15; // 少し右へ延長して「予測」感を出す
    const y1 = fit.slope * x1 + fit.intercept;
    const y2 = fit.slope * x2 + fit.intercept;
    ctx.moveTo(xOf(x1), yViewsOf(clampToRange(y1, viewsMin, viewsMax * 1.3)));
    ctx.lineTo(Math.min(xOf(x2), cssW - pad.r + 20), yViewsOf(clampToRange(y2, viewsMin, viewsMax * 1.3)));
    ctx.stroke();
    ctx.restore();
  }

  // 再生数の折れ線(青、左軸)
  ctx.beginPath();
  ctx.strokeStyle = '#5aa8e0';
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  history.forEach((p, i) => {
    const x = xOf(p.t), y = yViewsOf(p.views);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  // 勢みの折れ線(緑、右軸)
  if (momentumSeries.length >= 2) {
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(90,200,120,0.85)';
    ctx.lineWidth = 1.5;
    momentumSeries.forEach((p, i) => {
      const x = xOf(p.t), y = yMomentumOf(p.momentum);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }

  // 終点ラベル
  const lastPt = history[history.length - 1];
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'right';
  const lastDate = new Date(lastPt.t * 1000);
  ctx.fillText(
    `${lastDate.getMonth() + 1}/${lastDate.getDate()} ${String(lastDate.getHours()).padStart(2, '0')}:${String(lastDate.getMinutes()).padStart(2, '0')}`,
    cssW - pad.r,
    pad.t + 10
  );
}

function clampToRange(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * canvas上のマウス位置から最も近い履歴点を見つけ、日付・再生数・勢いを返す。
 * ホバー時のツールチップ表示に使う。
 * @returns {{t:number, views:number, momentumPerDay:number} | null}
 */
export function findNearestPoint(canvas, history, clientX) {
  if (!history || history.length < 2) return null;
  const rect = canvas.getBoundingClientRect();
  const cssW = rect.width;
  const pad = { l: 44, r: 44 };
  const gw = cssW - pad.l - pad.r;
  const relX = clientX - rect.left;
  const ratio = Math.max(0, Math.min(1, (relX - pad.l) / gw));

  const tMin = history[0].t;
  const tMax = history[history.length - 1].t;
  const targetT = tMin + ratio * (tMax - tMin);

  let nearest = history[0];
  let bestDiff = Infinity;
  history.forEach((p) => {
    const diff = Math.abs(p.t - targetT);
    if (diff < bestDiff) { bestDiff = diff; nearest = p; }
  });

  const momentumSeries = computeMomentumSeries(history);
  let nearestMomentum = NaN;
  let bestMDiff = Infinity;
  momentumSeries.forEach((p) => {
    const diff = Math.abs(p.t - nearest.t);
    if (diff < bestMDiff) { bestMDiff = diff; nearestMomentum = p.momentum; }
  });

  return { t: nearest.t, views: nearest.views, momentumPerDay: nearestMomentum };
}
