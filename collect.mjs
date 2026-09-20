#!/usr/bin/env node
/* ============================================================
   scripts/collect.mjs — YouTube再生数スナップショット収集
   ------------------------------------------------------------
   GitHub Actionsから定期実行される。3チャンネル(天音かなた/
   音乃瀬奏/猫又おかゆ)の「投稿動画のみ」(uploads playlist)を対象に、
   現在の再生数を取得してpublic_data.jsonへ追記する。

   スコープ外(意図的):
   - 他チャンネル動画の手動追加(コラボ/切り抜き等) — 本チャンネル
     アップロードのみを対象にするという設計判断のため実装しない
   - 個人モード(利用者API키) — 公開のみのため不要

   保持方針(元ツール踏襲):
   - 直近7日間 = 30分間隔のスナップショットをそのまま保持
   - 7日より古い分 = 2時間間隔に間引く
   - 全体で最大30日分
   これをやらないとpublic_data.jsonが際限なく肥大化し、GitHub Pages
   の配信効率とfetch時間を悪化させ続けるため、収集スクリプト側で
   毎回プルーニングまで行う。
   ============================================================ */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'public_config.json');
const DATA_PATH = path.join(ROOT, 'public_data.json');

const API_KEY = process.env.YT_API_KEY;
if (!API_KEY) {
  console.error('YT_API_KEY環境変数が設定されていません(GitHub Secretsで設定してください)');
  process.exit(1);
}

const RETENTION_DAYS = 30;
const FINE_WINDOW_MS = 7 * 24 * 3600 * 1000;   // この期間内は30分間隔のまま保持
const FINE_INTERVAL_MS = 30 * 60 * 1000;
const COARSE_INTERVAL_MS = 2 * 3600 * 1000;    // 7日より古い分はこの間隔に間引く
const RETENTION_MS = RETENTION_DAYS * 24 * 3600 * 1000;

const API_BASE = 'https://www.googleapis.com/youtube/v3';

async function ytFetch(endpoint, params) {
  const url = new URL(`${API_BASE}/${endpoint}`);
  url.searchParams.set('key', API_KEY);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`YouTube API error ${res.status} on ${endpoint}: ${body.slice(0, 500)}`);
  }
  return res.json();
}

/** チャンネルハンドルからuploadsプレイリストIDを取得する */
async function getUploadsPlaylistId(handle) {
  const data = await ytFetch('channels', {
    part: 'contentDetails',
    forHandle: handle,
  });
  const item = data.items && data.items[0];
  if (!item) throw new Error(`チャンネルが見つかりません: @${handle}`);
  return item.contentDetails.relatedPlaylists.uploads;
}

/** uploadsプレイリストの全動画IDをページネーションしながら収集する */
async function getAllUploadedVideoIds(playlistId) {
  const ids = [];
  let pageToken = undefined;
  do {
    const data = await ytFetch('playlistItems', {
      part: 'contentDetails',
      playlistId,
      maxResults: 50,
      ...(pageToken ? { pageToken } : {}),
    });
    (data.items || []).forEach((it) => {
      const vid = it.contentDetails && it.contentDetails.videoId;
      if (vid) ids.push(vid);
    });
    pageToken = data.nextPageToken;
  } while (pageToken);
  return ids;
}

/** 動画IDの配列(50件ずつ)からsnippet/statistics/contentDetailsを取得する */
async function getVideosMeta(videoIds) {
  const out = [];
  for (let i = 0; i < videoIds.length; i += 50) {
    const batch = videoIds.slice(i, i + 50);
    const data = await ytFetch('videos', {
      part: 'snippet,statistics,contentDetails',
      id: batch.join(','),
    });
    out.push(...(data.items || []));
  }
  return out;
}

/** ISO8601 duration (PT#H#M#S) を秒数に変換する */
function parseDurationToSec(iso) {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso || '');
  if (!m) return 0;
  const h = parseInt(m[1] || '0', 10);
  const mi = parseInt(m[2] || '0', 10);
  const s = parseInt(m[3] || '0', 10);
  return h * 3600 + mi * 60 + s;
}

/**
 * 履歴配列に新しいスナップショットを追加し、保持ポリシーに従って間引く。
 * @param {Array<{t:number, views:number}>} history 既存履歴(古い→新しい順)
 * @param {number} nowSec 現在時刻(unix秒)
 * @param {number} views 現在の再生数
 */
function appendAndPrune(history, nowSec, views) {
  const nowMs = nowSec * 1000;
  const next = [...history, { t: nowSec, views }];

  const fineCutoffMs = nowMs - FINE_WINDOW_MS;
  const retentionCutoffMs = nowMs - RETENTION_MS;

  const fine = [];
  const coarseCandidates = [];
  next.forEach((pt) => {
    const ptMs = pt.t * 1000;
    if (ptMs < retentionCutoffMs) return; // 30日超過は破棄
    if (ptMs >= fineCutoffMs) fine.push(pt);
    else coarseCandidates.push(pt);
  });

  // coarseCandidatesを2時間バケットに間引く(各バケット最新の1点だけ残す)
  const bucketed = new Map();
  coarseCandidates.forEach((pt) => {
    const bucketKey = Math.floor((pt.t * 1000) / COARSE_INTERVAL_MS);
    const existing = bucketed.get(bucketKey);
    if (!existing || pt.t > existing.t) bucketed.set(bucketKey, pt);
  });
  const coarse = Array.from(bucketed.values()).sort((a, b) => a.t - b.t);

  return [...coarse, ...fine].sort((a, b) => a.t - b.t);
}

async function main() {
  const config = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf-8'));
  let existingData = { channels: {}, videos: {}, lastUpdated: null };
  try {
    existingData = JSON.parse(await fs.readFile(DATA_PATH, 'utf-8'));
  } catch (e) {
    console.log('public_data.jsonが存在しないか読み込めないため、新規作成します');
  }
  if (!existingData.videos) existingData.videos = {};
  if (!existingData.channels) existingData.channels = {};

  const nowSec = Math.floor(Date.now() / 1000);
  const nextVideos = { ...existingData.videos };
  const nextChannels = {};

  for (const [channelKey, channelCfg] of Object.entries(config.channels)) {
    console.log(`[collect] ${channelKey} (@${channelCfg.handle}) を処理中...`);
    nextChannels[channelKey] = {
      handle: channelCfg.handle,
      displayName: channelCfg.displayName,
      milestoneStep: channelCfg.milestoneStep || config.defaultMilestoneStep || 1000000,
    };

    let uploadsPlaylistId;
    try {
      uploadsPlaylistId = await getUploadsPlaylistId(channelCfg.handle);
    } catch (e) {
      console.error(`[collect] ${channelKey}: uploadsプレイリスト取得失敗 — ${e.message}`);
      continue; // このチャンネルはスキップし、他チャンネルの収集は継続する
    }

    let videoIds;
    try {
      videoIds = await getAllUploadedVideoIds(uploadsPlaylistId);
    } catch (e) {
      console.error(`[collect] ${channelKey}: 動画ID一覧取得失敗 — ${e.message}`);
      continue;
    }
    console.log(`[collect] ${channelKey}: ${videoIds.length}本の動画を検出`);

    let metas;
    try {
      metas = await getVideosMeta(videoIds);
    } catch (e) {
      console.error(`[collect] ${channelKey}: 動画メタデータ取得失敗 — ${e.message}`);
      continue;
    }

    metas.forEach((v) => {
      const views = parseInt(v.statistics?.viewCount || '0', 10);
      const existing = nextVideos[v.id];
      const history = existing ? existing.history : [];
      nextVideos[v.id] = {
        channel: channelKey,
        title: v.snippet.title,
        publishedAt: v.snippet.publishedAt,
        durationSec: parseDurationToSec(v.contentDetails.duration),
        thumbnail:
          v.snippet.thumbnails?.high?.url ||
          v.snippet.thumbnails?.medium?.url ||
          v.snippet.thumbnails?.default?.url ||
          '',
        history: appendAndPrune(history, nowSec, views),
      };
    });
  }

  // 30日以上前に取得され、かつ現在いずれのチャンネルのuploads一覧にも
  // 含まれない動画(削除された等)のエントリは、履歴として残す価値が
  // 薄れるため掃除する(直近30日分の履歴しか保持しない方針と一貫させる)。
  const retentionCutoffSec = nowSec - RETENTION_MS / 1000;
  Object.keys(nextVideos).forEach((vid) => {
    const v = nextVideos[vid];
    const lastPoint = v.history[v.history.length - 1];
    if (!lastPoint || lastPoint.t < retentionCutoffSec) {
      delete nextVideos[vid];
    }
  });

  const out = {
    channels: nextChannels,
    videos: nextVideos,
    lastUpdated: new Date(nowSec * 1000).toISOString(),
  };

  await fs.writeFile(DATA_PATH, JSON.stringify(out), 'utf-8');
  console.log(`[collect] 完了。動画総数: ${Object.keys(nextVideos).length}`);
}

main().catch((e) => {
  console.error('[collect] 致命的エラー:', e);
  process.exit(1);
});
