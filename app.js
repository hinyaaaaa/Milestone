/* ============================================================
   app.js — メイン画面のオーケストレーション(v3: 仮想化対応)
   ------------------------------------------------------------
   公開専用SPA(個人モード・APIキー入力は実装しない)。
   public_data.json / public_config.json を読み込み、カード一覧を
   描画する。フィルタ(チャンネル軸: 全て/かなた/奏/おかゆ)と
   ソート(再生数/投稿日/注目/勢い)を独立して組み合わせられる。

   【v3で追加: 行仮想化(virtualization)】
   「初回に全動画を一括読み込み・一括DOM生成するのは重すぎる」との
   指摘への対応。件数が数百規模になると、backdrop-filter付きの
   glass-cardを全部同時にDOM化するだけで初回描画が大きく遅延する
   (content-visibility:autoは「描画コスト」は減らせても「DOM生成
   コスト」自体は減らせないため、根本対策にならない)。

   方式: カードをグリッドの「行」単位でグループ化し、スクロール位置
   から見えている行の範囲(+前後バッファ数行)だけを実際にDOM化する。
   それ以外の行は高さだけを確保したプレースホルダーのdivにする。
   列数は画面幅とカード最小幅から実測して決める(CSS側のauto-fillを
   使うと、JS側から「今何列か」を知る手段がなくなり仮想化と噛み合わ
   ないため、列数の計算はJS側に一本化した — style.css側は
   card-min-widthの値だけを持ち、実際のtemplate-columnsはここで
   インラインstyleとして設定する)。

   行の高さはカードの内容(グラフ開閉等)で可変なため、実際にDOM化
   した行のBoundingClientRectを都度計測してキャッシュし、次回の
   スクロール位置計算に使う(固定行高を仮定しない)。

   自動更新: ⟳ボタンでON/OFF。ONの間は30分ごとにデータを再取得する
   (元ツール踏襲。データ自体がAction側で30分おきにしか更新されない
   ため、それより短い間隔にする意味は薄い)。
   ============================================================ */
import { loadPublicData, loadPublicConfig } from './data-loader.js';
import { computeMilestoneState, formatManUnit, formatViews } from './milestone.js';
import { drawHistoryChart, findNearestPoint } from './chart.js';

const AUTO_REFRESH_MS = 30 * 60 * 1000;

// 仮想化パラメータ
const CARD_MIN_WIDTH_PX = 300;   // style.css側の値と合わせる(1カラムの最小幅)
const CARD_MIN_WIDTH_PX_WIDE = 320; // 1600px以上での最小幅(style.cssのワイド版に合わせる)
const GRID_GAP_PX = 16;
const ESTIMATED_ROW_HEIGHT_PX = 400; // 実測前の初期見積もり(カード1枚のおおよその高さ)
const BUFFER_ROWS = 2; // 画面外に余分に確保しておく行数(上下それぞれ)

let state = {
  config: null,
  data: null,
  channelFilter: 'all',       // 'all' | チャンネルキー
  sortMode: 'views',          // 'views' | 'date' | 'featured' | 'momentum'
  autoRefreshOn: false,
  autoRefreshTimer: null,
  openCardIds: new Set(),     // グラフを開いているカードのvideoId集合
};

// 仮想化用の可変状態(renderとは別に持つ。フィルタ/ソートが変わる
// たびにentriesとrowsは作り直すが、スクロール位置自体は極力保つ)
let virt = {
  entries: [],           // 現在のフィルタ/ソート適用後の全エントリ
  columns: 1,
  rowHeights: new Map(), // rowIndex -> 実測px高さ(無ければESTIMATED_ROW_HEIGHT_PX)
  rowOffsets: [],        // rowIndex -> 累積オフセットpx(先頭からの距離)
  renderedRange: { start: -1, end: -1 }, // 現在実DOM化している行の範囲
  scheduled: false,      // rAFの二重スケジュール防止(スクロール処理用)
};

const el = {
  grid: document.getElementById('card-grid'),
  channelTabs: document.getElementById('channel-tabs'),
  sortSelect: document.getElementById('sort-select'),
  refreshBtn: document.getElementById('refresh-btn'),
  lastUpdated: document.getElementById('last-updated'),
  emptyState: document.getElementById('empty-state'),
};

function computeVideoState(videoId, video, config) {
  const channelCfg = config.channels[video.channel];
  const milestoneStep = channelCfg ? channelCfg.milestoneStep : config.defaultMilestoneStep;
  const ms = computeMilestoneState(video.history, milestoneStep);
  return { videoId, video, milestoneState: ms };
}

function buildEntries() {
  const { data, config } = state;
  if (!data || !config) return [];
  return Object.entries(data.videos)
    .map(([videoId, video]) => computeVideoState(videoId, video, config))
    .filter((e) => e.milestoneState != null);
}

function filterEntries(entries) {
  if (state.channelFilter === 'all') return entries;
  return entries.filter((e) => e.video.channel === state.channelFilter);
}

function sortEntries(entries) {
  const arr = [...entries];
  if (state.sortMode === 'views') {
    arr.sort((a, b) => b.milestoneState.currentViews - a.milestoneState.currentViews);
  } else if (state.sortMode === 'date') {
    arr.sort((a, b) => new Date(b.video.publishedAt) - new Date(a.video.publishedAt));
  } else if (state.sortMode === 'momentum') {
    arr.sort((a, b) => (b.milestoneState.momentumPerDay || 0) - (a.milestoneState.momentumPerDay || 0));
  } else if (state.sortMode === 'featured') {
    // 注目: 達成済み(直近48h) → もうすぐ(soonThresholdDays以内) → その他、の3セクション
    const rank = (e) => {
      if (e.milestoneState.achievedRecently) return 0;
      if (isSoon(e.milestoneState)) return 1;
      return 2;
    };
    arr.sort((a, b) => {
      const ra = rank(a), rb = rank(b);
      if (ra !== rb) return ra - rb;
      return b.milestoneState.currentViews - a.milestoneState.currentViews;
    });
  }
  return arr;
}

function isSoon(ms) {
  if (ms.etaSec == null) return false;
  const daysLeft = (ms.etaSec - Date.now() / 1000) / 86400;
  const threshold = (state.config && state.config.soonThresholdDays) || 3;
  return daysLeft >= 0 && daysLeft <= threshold;
}

function cardColorClass(ms) {
  if (ms.achievedRecently) {
    return ms.achievedWithin24h ? 'card-achieved-24h' : 'card-achieved-48h';
  }
  if (isSoon(ms)) return 'card-soon';
  return '';
}

/**
 * カード上部に出す「注目」バッジの文言を返す。null なら非表示。
 * 縁取りの色分けだけに頼らない複合的な階層表現。
 */
function statusBadgeLabel(ms) {
  if (ms.achievedRecently) {
    return ms.achievedWithin24h ? '🎉 24時間以内に達成' : '✨ 48時間以内に達成';
  }
  if (isSoon(ms)) return '🔥 まもなく到達';
  return null;
}

/**
 * ETA(到達予測)のラベルを返す。
 * 【v3修正: 「予測不能」の原因対応】
 * 収集開始直後(履歴が1〜2点しかない)は回帰が成立せず常にetaSecが
 * nullになり、常に「予測不能」と表示されてしまっていた。これは
 * バグではなく仕様通りの挙動だが、ユーザーには「壊れている」ように
 * 見えるため、milestoneState側からデータ点数を受け取り、
 * 「予測不能(=データはあるが横ばい/減少で予測できない)」と
 * 「データ収集中(=そもそも予測に足る点数がまだ無い)」を文言で
 * 区別する。
 */
function formatEtaLabel(ms) {
  if (ms.etaSec == null) {
    if (ms.historyPointCount < 2) return 'データ収集中…';
    if (ms.historyPointCount < 3) return 'データ収集中(あと少し)';
    return '予測不能(伸びが横ばい)';
  }
  const d = new Date(ms.etaSec * 1000);
  const now = new Date();
  const diffDays = Math.round((d - now) / 86400000);
  const dateLabel = `${d.getMonth() + 1}/${d.getDate()}`;
  if (diffDays <= 0) return `本日中 (${dateLabel})`;
  return `${dateLabel} 頃 (あと${diffDays}日)`;
}

function formatPublishedDate(iso) {
  const d = new Date(iso);
  const now = new Date();
  const diffDays = Math.floor((now - d) / 86400000);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}（${diffDays}日前）`;
}

function formatDuration(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str || '';
  return d.innerHTML;
}

function buildCard(entry) {
  const { videoId, video, milestoneState: ms } = entry;
  const channelCfg = state.config.channels[video.channel] || {};
  const themeColor = channelCfg.themeColor || '#e7b94c';

  const card = document.createElement('div');
  card.className = `glass-card ${cardColorClass(ms)}`;
  card.style.setProperty('--theme', themeColor);
  card.dataset.videoId = videoId;

  const progressPct = Math.round(ms.progressRatio * 100);
  const momentumLabel = isFinite(ms.momentumPerDay) ? `+${formatManUnit(ms.momentumPerDay)}/日` : '—';
  const badgeLabel = statusBadgeLabel(ms);
  const badgeHtml = badgeLabel
    ? `<div class="card-status-badge">${badgeLabel}</div>`
    : `<div class="card-status-badge-placeholder"></div>`;

  card.innerHTML = `
    <a class="card-thumb-link" href="https://www.youtube.com/watch?v=${videoId}" target="_blank" rel="noopener" aria-label="${escapeHtml(video.title)}をYouTubeで開く">
      <img class="card-thumb" src="${video.thumbnail}" alt="${escapeHtml(video.title)}のサムネイル" loading="lazy">
      <span class="card-duration">${formatDuration(video.durationSec)}</span>
    </a>
    <div class="card-body">
      ${badgeHtml}
      <div class="card-channel-tag">${channelCfg.displayName || video.channel}</div>
      <div class="card-title">${escapeHtml(video.title)}</div>
      <div class="card-stats-row">
        <button class="card-views-btn" data-role="toggle-chart" aria-label="推移グラフを表示・非表示">${formatViews(ms.currentViews)} 回</button>
        <button class="card-momentum-btn" data-role="toggle-chart" aria-label="推移グラフを表示・非表示">${momentumLabel}</button>
      </div>
      <div class="card-milestone">
        <div class="card-milestone-row">
          <span>次の節目: ${formatViews(ms.milestone)}</span>
          <span>残り ${formatViews(ms.viewsRemaining)}</span>
        </div>
        <div class="card-progress-track"><div class="card-progress-fill" style="width:${progressPct}%"></div></div>
        <div class="card-eta">${formatEtaLabel(ms)}</div>
      </div>
      <div class="card-footer-row">
        <span class="card-published">${formatPublishedDate(video.publishedAt)}</span>
        <button class="card-tweet-btn" data-role="tweet" title="ツイート" aria-label="この動画についてツイートする">🐦</button>
      </div>
      <div class="card-chart-wrap" data-role="chart-wrap" hidden>
        <canvas class="card-chart" data-role="chart-canvas"></canvas>
        <div class="card-chart-tooltip" data-role="chart-tooltip" hidden></div>
      </div>
    </div>
  `;

  const toggleBtns = card.querySelectorAll('[data-role="toggle-chart"]');
  toggleBtns.forEach((btn) => btn.addEventListener('click', () => toggleChart(videoId, card, video.history)));

  const tweetBtn = card.querySelector('[data-role="tweet"]');
  tweetBtn.addEventListener('click', () => openTweetIntent(video, ms, videoId));

  if (state.openCardIds.has(videoId)) {
    const wrap = card.querySelector('[data-role="chart-wrap"]');
    wrap.hidden = false;
    requestAnimationFrame(() => renderChartInto(card, video.history));
  }

  return card;
}

function toggleChart(videoId, card, history) {
  const wrap = card.querySelector('[data-role="chart-wrap"]');
  const isOpen = !wrap.hidden;
  if (isOpen) {
    wrap.hidden = true;
    state.openCardIds.delete(videoId);
  } else {
    wrap.hidden = false;
    state.openCardIds.add(videoId);
    renderChartInto(card, history);
  }
  // 開閉による行の高さ変化は、その行を監視しているResizeObserverが
  // 自動的に検知して位置を補正するため、ここで明示的に何かをする
  // 必要は無い(以前はここで手動の再測定をスケジュールしていたが、
  // ResizeObserver導入によりその手動処理は不要になった)。
}

function renderChartInto(card, history) {
  const canvas = card.querySelector('[data-role="chart-canvas"]');
  const tooltip = card.querySelector('[data-role="chart-tooltip"]');
  drawHistoryChart(canvas, history);

  canvas.onmousemove = (e) => {
    const pt = findNearestPoint(canvas, history, e.clientX);
    if (!pt) { tooltip.hidden = true; return; }
    const d = new Date(pt.t * 1000);
    const dateLabel = `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    const momentumLabel = isFinite(pt.momentumPerDay) ? `+${formatManUnit(pt.momentumPerDay)}/日` : '—';
    tooltip.textContent = `${dateLabel} ／ ${formatViews(pt.views)}回 ／ ${momentumLabel}`;
    tooltip.hidden = false;
  };
  canvas.onmouseleave = () => { tooltip.hidden = true; };
}

function openTweetIntent(video, ms, videoId) {
  const text = `${video.title}\n再生数: ${formatViews(ms.currentViews)}回`;
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const tweetUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`;
  window.open(tweetUrl, '_blank', 'noopener');
}

/* ============================================================
   仮想化コア
   ------------------------------------------------------------
   #card-gridの子要素は「行コンテナ(.virt-row)」のみとし、各行の中に
   その行が担当する列数分のカード(または高さ確保用のプレースホルダー)
   を入れる。行コンテナ自体はabsolute配置にしてtranslateYで積み上げる
   ことで、間の行を完全にDOMから外しても後続行の位置がずれないように
   している(単純にdisplay:noneで間引く方式だと、後続要素の位置計算が
   ブラウザに委ねられず自前で管理する必要が生じて複雑になるため、
   絶対配置+高さ管理の方式を採る)。
   ============================================================ */

function computeColumns() {
  const gridWidth = el.grid.clientWidth || window.innerWidth;
  const minWidth = window.innerWidth >= 1600 ? CARD_MIN_WIDTH_PX_WIDE : CARD_MIN_WIDTH_PX;
  const cols = Math.max(1, Math.floor((gridWidth + GRID_GAP_PX) / (minWidth + GRID_GAP_PX)));
  return cols;
}

function rowCount() {
  return Math.ceil(virt.entries.length / virt.columns);
}

function rowHeight(rowIndex) {
  return virt.rowHeights.get(rowIndex) || ESTIMATED_ROW_HEIGHT_PX;
}

/** 各行の開始オフセット(px)を先頭から積算して作り直す。 */
function rebuildRowOffsets() {
  const n = rowCount();
  const offsets = new Array(n + 1);
  offsets[0] = 0;
  for (let i = 0; i < n; i++) {
    offsets[i + 1] = offsets[i] + rowHeight(i) + GRID_GAP_PX;
  }
  virt.rowOffsets = offsets;
}

function totalGridHeight() {
  const n = rowCount();
  return virt.rowOffsets[n] != null ? virt.rowOffsets[n] - GRID_GAP_PX : 0;
}

/** 現在のスクロール位置から、画面に見えている行の範囲を求める。 */
function computeVisibleRowRange() {
  const rect = el.grid.getBoundingClientRect();
  const viewportTop = -rect.top;
  const viewportBottom = viewportTop + window.innerHeight;

  const n = rowCount();
  let startRow = 0, endRow = n - 1;

  // 二分探索するほどの行数を想定しないため(数百動画でも数十〜百数十行程度)、
  // 線形走査で十分に軽い。もし将来的に行数が数千規模になるなら二分探索へ
  // 切り替える余地を残す。
  for (let i = 0; i < n; i++) {
    if (virt.rowOffsets[i + 1] > viewportTop) { startRow = i; break; }
    startRow = i + 1;
  }
  for (let i = startRow; i < n; i++) {
    if (virt.rowOffsets[i] > viewportBottom) { endRow = i - 1; break; }
    endRow = i;
  }

  startRow = Math.max(0, startRow - BUFFER_ROWS);
  endRow = Math.min(n - 1, endRow + BUFFER_ROWS);
  return { start: startRow, end: endRow };
}

function makeRowContainer(rowIndex) {
  const row = document.createElement('div');
  row.className = 'virt-row';
  row.dataset.rowIndex = String(rowIndex);
  row.style.position = 'absolute';
  row.style.left = '0';
  row.style.right = '0';
  row.style.top = `${virt.rowOffsets[rowIndex]}px`;
  row.style.display = 'grid';
  row.style.gridTemplateColumns = `repeat(${virt.columns}, 1fr)`;
  row.style.gap = `${GRID_GAP_PX}px`;

  const startIdx = rowIndex * virt.columns;
  for (let c = 0; c < virt.columns; c++) {
    const entry = virt.entries[startIdx + c];
    if (!entry) break; // 最終行の余り(列数に満たない)
    row.appendChild(buildCard(entry));
  }
  return row;
}

/** 実際にDOM化されている行の高さを計測してキャッシュを更新する。変化があればtrueを返す。 */
function measureRenderedRows() {
  let changed = false;
  el.grid.querySelectorAll('.virt-row').forEach((rowEl) => {
    const rowIndex = Number(rowEl.dataset.rowIndex);
    const measured = rowEl.getBoundingClientRect().height;
    if (measured > 0) {
      const prev = virt.rowHeights.get(rowIndex);
      if (prev == null || Math.abs(prev - measured) > 1) {
        virt.rowHeights.set(rowIndex, measured);
        changed = true;
      }
    }
  });
  return changed;
}

let virtualRenderForce = false;
function scheduleVirtualRender(force = false) {
  if (force) virtualRenderForce = true;
  if (virt.scheduled) return;
  virt.scheduled = true;
  requestAnimationFrame(() => {
    virt.scheduled = false;
    performVirtualRender(virtualRenderForce);
    virtualRenderForce = false;
  });
}

/**
 * 【行の重なりバグの根本原因と修正】
 * 検証の結果、以下の2つの問題が重なって発生していた:
 *
 * 1. サムネイル画像+可変長タイトル+バッジ有無が絡む複雑なレイアウト
 *    では、DOM構築後にrequestAnimationFrameを何回か待っても、
 *    ブラウザのレイアウト計算がいつ確定するかを予測できない
 *    (環境やコンテンツによって収束までの所要フレーム数が変わる)。
 *    固定回数のrAFループで様子見する方式を試したが、少なすぎれば
 *    間に合わず、多くすれば無駄な待ち時間(最大1秒以上)が生じるという
 *    トレードオフから抜け出せなかった。
 *
 * 2. さらに、直前の測定ループが完了する前に新しいDOM再構築が発生すると
 *    新旧のループが同じDOMを競合して書き換える問題もあった。
 *
 * 対策: 「何回rAFを待てば十分か」を推測するのをやめ、
 * ResizeObserverを使う。これはブラウザ自身が要素の実際のサイズ変化を
 * 検知した"その瞬間"に確実にコールバックを呼ぶ仕組みなので、
 * 何フレームかかるかを推測する必要が無くなり、かつ最速で反応できる。
 * 世代(generation)による多重発火防止は、DOM再構築のたびに
 * observeし直すことで自然に解消される(古い行のobserveは
 * unobserve/disconnectで確実に止める)。
 */
let rowResizeObserver = null;

function ensureRowResizeObserver() {
  if (rowResizeObserver) return rowResizeObserver;
  rowResizeObserver = new ResizeObserver((entries) => {
    let changed = false;
    entries.forEach((entry) => {
      const rowEl = entry.target;
      const rowIndex = Number(rowEl.dataset.rowIndex);
      // ResizeObserverはborder-boxサイズを返すコールバックもあるが、
      // ブラウザ間の実装差を避けるため、ここではgetBoundingClientRectで
      // 素直に読み直す(entry.contentRect等の細部の差異に依存しない)。
      const measured = rowEl.getBoundingClientRect().height;
      if (measured > 0) {
        const prev = virt.rowHeights.get(rowIndex);
        if (prev == null || Math.abs(prev - measured) > 1) {
          virt.rowHeights.set(rowIndex, measured);
          changed = true;
        }
      }
    });
    if (changed) {
      rebuildRowOffsets();
      el.grid.style.height = `${totalGridHeight()}px`;
      el.grid.querySelectorAll('.virt-row').forEach((rowEl) => {
        const idx = Number(rowEl.dataset.rowIndex);
        rowEl.style.top = `${virt.rowOffsets[idx]}px`;
      });
    }
  });
  return rowResizeObserver;
}

function performVirtualRender(force) {
  if (!virt.entries.length) return;

  const range = computeVisibleRowRange();
  const sameRange = !force && range.start === virt.renderedRange.start && range.end === virt.renderedRange.end;

  if (!sameRange) {
    const observer = ensureRowResizeObserver();
    // 画面外に出す行のobserveを解除する(メモリリーク防止、かつ
    // 見えなくなった行のサイズ変化を無視するため)。
    observer.disconnect();

    el.grid.innerHTML = '';
    for (let r = range.start; r <= range.end; r++) {
      const rowEl = makeRowContainer(r);
      el.grid.appendChild(rowEl);
      observer.observe(rowEl);
    }
    virt.renderedRange = range;

    // observeした直後の初回コールバックで、DOM構築直後の暫定サイズが
    // 一度は必ず報告される。その後、画像デコードやフォント確定で
    // サイズが変わればResizeObserverが自動的に再度通知してくれるため、
    // 手動でのポーリング(rAFループ)は一切不要になった。
  } else {
    // 行の入れ替えが無い場合(グラフ開閉等)でも、念のため現在の実測値で
    // オフセットを同期しておく。
    measureRenderedRows();
    rebuildRowOffsets();
    el.grid.style.height = `${totalGridHeight()}px`;
  }
}

function onScrollOrResize() {
  scheduleVirtualRender(false);
}

function initVirtualization() {
  el.grid.style.position = 'relative';
  window.addEventListener('scroll', onScrollOrResize, { passive: true });
  window.addEventListener('resize', () => {
    const newColumns = computeColumns();
    if (newColumns !== virt.columns) {
      virt.columns = newColumns;
      // 列数が変わると各行の担当エントリ自体が変わるため、高さの見積もりも
      // リセットして作り直す(古い高さを引き継ぐと段組みがずれるため)。
      virt.rowHeights.clear();
      rebuildRowOffsets();
      el.grid.style.height = `${totalGridHeight()}px`;
    }
    onScrollOrResize();
  }, { passive: true });
}

/** フィルタ/ソート変更、初回データ取得時に呼ぶ「全面作り直し」。 */
function render() {
  const entries = sortEntries(filterEntries(buildEntries()));
  virt.entries = entries;

  if (!entries.length) {
    el.grid.innerHTML = '';
    el.grid.style.height = '';
    el.emptyState.hidden = false;
    return;
  }
  el.emptyState.hidden = true;

  virt.columns = computeColumns();
  // フィルタ/ソートで中身が変わるため、高さの見積もりは一旦クリアして
  // 初期見積もり値からやり直す(古いエントリの高さを新しいエントリに
  // 誤って流用しないため)。
  virt.rowHeights.clear();
  virt.renderedRange = { start: -1, end: -1 };
  rebuildRowOffsets();
  el.grid.style.height = `${totalGridHeight()}px`;
  performVirtualRender(true);
}

function renderChannelTabs() {
  el.channelTabs.innerHTML = '';
  const makeTab = (key, label) => {
    const isActive = state.channelFilter === key;
    const btn = document.createElement('button');
    btn.className = 'channel-tab glass-pill' + (isActive ? ' active' : '');
    btn.textContent = label;
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', String(isActive));
    btn.addEventListener('click', () => {
      state.channelFilter = key;
      renderChannelTabs();
      render();
    });
    return btn;
  };
  el.channelTabs.appendChild(makeTab('all', '全て'));
  Object.entries(state.config.channels).forEach(([key, cfg]) => {
    el.channelTabs.appendChild(makeTab(key, cfg.displayName));
  });
}

function updateLastUpdatedLabel() {
  if (!state.data || !state.data.lastUpdated) {
    el.lastUpdated.textContent = '最終更新: —';
    return;
  }
  const d = new Date(state.data.lastUpdated);
  el.lastUpdated.textContent = `最終更新: ${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

async function refreshData() {
  try {
    state.data = await loadPublicData();
    updateLastUpdatedLabel();
    render();
  } catch (e) {
    console.error('データ再取得に失敗しました', e);
  }
}

function setAutoRefresh(on) {
  state.autoRefreshOn = on;
  el.refreshBtn.classList.toggle('active', on);
  el.refreshBtn.title = on ? '自動更新: ON(クリックでOFF)' : '自動更新: OFF(クリックでON)';
  if (state.autoRefreshTimer) {
    clearInterval(state.autoRefreshTimer);
    state.autoRefreshTimer = null;
  }
  if (on) {
    state.autoRefreshTimer = setInterval(refreshData, AUTO_REFRESH_MS);
  }
}

el.refreshBtn.addEventListener('click', () => setAutoRefresh(!state.autoRefreshOn));
el.sortSelect.addEventListener('change', () => {
  state.sortMode = el.sortSelect.value;
  render();
});

async function init() {
  try {
    initVirtualization();
    const [config, data] = await Promise.all([loadPublicConfig(), loadPublicData()]);
    state.config = config;
    state.data = data;
    renderChannelTabs();
    updateLastUpdatedLabel();
    render();
  } catch (e) {
    console.error('初期化に失敗しました', e);
    el.emptyState.hidden = false;
    el.emptyState.textContent = 'データの読み込みに失敗しました。時間をおいて再度お試しください。';
  }
}

init();
