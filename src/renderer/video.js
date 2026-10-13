// Videos: frame grabbing for thumbnails (main asks, caches the JPEG on disk),
// the full-window player overlay, and the 「サムネイルのシーンを指定」 dialog.
// Preview and the inspector only ever show the still thumbnail.
import { api, emit } from './state.js';
import { el, openModal, toast, toastError, fileUrl, basename, bumpThumb } from './ui.js';

const FRAME_MAX = 960; // long side of a thumbnail frame (px)
const SEEK_STEP = 5;   // ←/→ in the player (seconds)
const GRAB_TIMEOUT_MS = 15000; // below main's 20 s, so the decoder is always released

/** "m:ss" / "h:mm:ss" */
export function formatDuration(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '';
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}

function waitFor(target, ok, bad = 'error') {
  return new Promise((resolve, reject) => {
    const done = () => { target.removeEventListener(ok, done); target.removeEventListener(bad, fail); resolve(); };
    const fail = () => { target.removeEventListener(ok, done); target.removeEventListener(bad, fail); reject(new Error('video error')); };
    target.addEventListener(ok, done);
    target.addEventListener(bad, fail);
  });
}

/** Decode the frame at `time` seconds and return it as JPEG bytes. */
export async function grabFrame(path, time = 0) {
  const v = document.createElement('video');
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('video frame timeout')), GRAB_TIMEOUT_MS); });
  try {
    return await Promise.race([decodeFrame(v, path, time), timeout]);
  } finally {
    clearTimeout(timer);
    v.removeAttribute('src');
    v.load(); // release the decoder and the file
  }
}

async function decodeFrame(v, path, time) {
  v.muted = true;
  v.preload = 'auto';
  v.crossOrigin = 'anonymous'; // the canvas must stay readable
  const loaded = waitFor(v, 'loadeddata');
  v.src = fileUrl({ path });
  await loaded;
  const dur = Number.isFinite(v.duration) ? v.duration : 0;
  const t = Math.max(0, dur ? Math.min(time, dur - 0.05) : time);
  if (t > 0) {
    const seeked = waitFor(v, 'seeked');
    v.currentTime = t;
    await seeked;
  }
  const w = v.videoWidth;
  const h = v.videoHeight;
  if (!w || !h) throw new Error('no video track');
  const k = Math.min(1, FRAME_MAX / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * k));
  c.height = Math.max(1, Math.round(h * k));
  c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
  const blob = await new Promise((resolve) => c.toBlob(resolve, 'image/jpeg', 0.85));
  if (!blob) throw new Error('encode failed');
  return blob.arrayBuffer();
}

export function initVideoFrames() {
  api.onVideoFrameRequest(({ path, time }) => grabFrame(path, time));
}

/** Width/height/duration from metadata only (inspector). */
export async function videoInfo(item) {
  const v = document.createElement('video');
  v.preload = 'metadata';
  v.muted = true;
  try {
    const loaded = waitFor(v, 'loadedmetadata');
    v.src = fileUrl(item);
    await loaded;
    return { width: v.videoWidth, height: v.videoHeight, duration: v.duration };
  } finally {
    v.removeAttribute('src');
    v.load();
  }
}

// ---------- player ----------
let player = null;

export function isPlayerOpen() {
  return !!player;
}
/** Open player (for the smoke test). */
export function activePlayer() {
  return player;
}

/** Full-window overlay player. Esc / right-click closes it. */
export function openVideoPlayer(item) {
  if (player) player.close();
  const video = el('video', { class: 'player-video', controls: true, autoplay: true, src: fileUrl(item) });
  const name = el('div', { class: 'player-name' }, item.name || basename(item.path));
  const closeBtn = el('button', { class: 'btn player-close', title: '閉じる（Esc）' }, '✕');
  const root = el('div', { class: 'player-overlay', tabindex: '-1' }, video, name, closeBtn);
  const onKey = (e) => {
    // the player owns the keyboard while open (nothing below may react)
    e.stopImmediatePropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      else close();
      return;
    }
    if (e.code === 'Space' || e.key === ' ') {
      e.preventDefault();
      if (e.repeat) return;
      if (video.paused) video.play().catch(() => {}); else video.pause();
      return;
    }
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const d = e.key === 'ArrowRight' ? SEEK_STEP : -SEEK_STEP;
      video.currentTime = Math.max(0, Math.min(video.duration || 0, video.currentTime + d));
      return;
    }
    if (e.key === 'f' || e.key === 'F') {
      e.preventDefault();
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      else root.requestFullscreen().catch(() => {});
    }
  };
  const onContext = (e) => { e.preventDefault(); e.stopPropagation(); close(); };
  video.addEventListener('error', () => toast('この動画を再生できません（対応していない形式の可能性があります）。', 'error'));
  closeBtn.addEventListener('click', () => close());
  const close = () => {
    if (player !== self) return;
    player = null;
    window.removeEventListener('keydown', onKey, true);
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    video.pause();
    video.removeAttribute('src');
    video.load();
    root.remove();
  };
  const self = { item, root, video, close };
  player = self;
  window.addEventListener('keydown', onKey, true);
  root.addEventListener('contextmenu', onContext);
  document.body.append(root);
  root.focus();
  return self;
}

// ---------- thumbnail scene ----------
/** 「サムネイルのシーンを指定…」: pick the frame used as the video's thumbnail. */
export async function openThumbSceneDialog(item) {
  let cur = 0;
  try { cur = Number(await api.getVideoThumbTime(item.path)) || 0; } catch { /* default */ }
  const video = el('video', { class: 'scene-video', controls: true, muted: true, preload: 'auto', src: fileUrl(item) });
  const pos = el('span', { class: 'muted small' });
  const paint = () => { pos.textContent = `現在位置 ${formatDuration(video.currentTime)}（設定中 ${formatDuration(cur)}）`; };
  video.addEventListener('loadedmetadata', () => { if (cur) video.currentTime = cur; paint(); });
  video.addEventListener('timeupdate', paint);
  video.addEventListener('seeked', paint);
  const body = el('div', { class: 'scene-dialog' }, video,
    el('div', { class: 'scene-row' }, pos),
    el('div', { class: 'note' }, '再生バーで場面を選び「このシーンに設定」を押してください。'));
  const apply = async (close, t) => {
    video.pause();
    try {
      await api.setVideoThumbTime(item.path, t);
    } catch (e) {
      toastError(e);
      return;
    }
    close(true);
    bumpThumb(item.path);
    emit('video-thumb-changed', item.path);
    toast(t ? `サムネイルを ${formatDuration(t)} の場面にしました。` : 'サムネイルを冒頭の場面に戻しました。', 'success', 2200);
  };
  await openModal({
    title: `サムネイルのシーン — ${item.name || basename(item.path)}`,
    body,
    wide: true,
    buttons: [
      { label: 'キャンセル', value: false },
      { label: '冒頭に戻す', onClick: (close) => apply(close, 0) },
      { label: 'このシーンに設定', primary: true, onClick: (close) => apply(close, video.currentTime) },
    ],
  });
  video.pause();
  video.removeAttribute('src');
  video.load();
}
