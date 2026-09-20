/* ============================================================
   app.js — メイン画面のオーケストレーション
   ------------------------------------------------------------
   公開専用SPA(個人モード・APIキー入力は実装しない)。
   public_data.json / public_config.json を読み込み、カード一覧を
   描画する。フィルタ(チャンネル軸: 全て/かなた/奏/おかゆ)と
   ソート(再生数/投稿日/注目/勢い)を独立して組み合わせられる。

   自動更新: ⟳ボタンでON/OFF。ONの間は30分ごとにデータを再取得する
   (元ツール踏襲。データ自体がAction側で30分おきにしか更新されない
   ため、それより短い間隔にする意味は薄い)。
   ============================================================ */
import { loadPublicData, loadPublicConfig } from './data-loader.js';
import { computeMilestoneState, formatManUnit, formatViews } from './milestone.js';
import { drawHistoryChart, findNearestPoint } from './chart.js';

const AUTO_REFRESH_MS = 30 * 60 * 1000;

let state = {
  config: null,
  data: null,
  channelFilter: 'all',       // 'all' | チャンネルキー
  sortMode: 'views',          // 'views' | 'date' | 'featured' | 'momentum'
  autoRefreshOn: false,
  autoRefreshTimer: null,
  openCardIds: new Set(),     // グラフを開いているカードのvideoId集合
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
 * 縁取りの色分けだけに頼らない複合的な階層表現(自己採点での指摘対応)。
 */
function statusBadgeLabel(ms) {
  if (ms.achievedRecently) {
    return ms.achievedWithin24h ? '🎉 24時間以内に達成' : '✨ 48時間以内に達成';
  }
  if (isSoon(ms)) return '🔥 まもなく到達';
  return null;
}

function formatEtaLabel(etaSec) {
  if (etaSec == null) return '予測不能';
  const d = new Date(etaSec * 1000);
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
  const badgeHtml = badgeLabel ? `<div class="card-status-badge">${badgeLabel}</div>` : '';

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
        <div class="card-eta">${formatEtaLabel(ms.etaSec)}</div>
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

function escapeHtml(str) {
  const d = document.createElement('div');
  d.textContent = str || '';
  return d.innerHTML;
}

function render() {
  const entries = sortEntries(filterEntries(buildEntries()));
  el.grid.innerHTML = '';
  if (!entries.length) {
    el.emptyState.hidden = false;
    return;
  }
  el.emptyState.hidden = true;
  const frag = document.createDocumentFragment();
  entries.forEach((entry) => frag.appendChild(buildCard(entry)));
  el.grid.appendChild(frag);
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
