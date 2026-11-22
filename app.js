import * as pdfjs from './vendor/pdf.min.mjs';
import { analyzePdf, parseOrder } from './analyze.js';
import { icon } from './icons.js';

pdfjs.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.min.mjs', import.meta.url).href;
const $ = id => document.getElementById(id);
const el = (tag, cls) => { const e = document.createElement(tag); if (cls) e.className = cls; return e; };

// 아이폰·아이패드 무음 스위치가 켜져 있어도 메트로놈이 들리도록
try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch {}

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// ---------- 저장소 (IndexedDB) ----------

const dbReady = new Promise((res, rej) => {
  const r = indexedDB.open('score-player', 2);
  r.onupgradeneeded = () => {
    const db = r.result;
    if (!db.objectStoreNames.contains('scores')) db.createObjectStore('scores', { keyPath: 'id' });
    // 연습 기록은 PDF 내용(해시)으로 묶는다. 같은 파일이면 이름이 달라도, 다른 기기에서도 같은 곡
    if (!db.objectStoreNames.contains('practice')) db.createObjectStore('practice', { keyPath: 'key' });
  };
  r.onsuccess = () => res(r.result);
  r.onerror = () => rej(r.error);
});
async function store(mode, fn, name = 'scores') {
  const db = await dbReady;
  return new Promise((res, rej) => {
    const t = db.transaction(name, mode);
    const req = fn(t.objectStore(name));
    t.oncomplete = () => res(req && req.result);
    t.onerror = () => rej(t.error);
  });
}
const allScores = () => store('readonly', s => s.getAll());
const getScore = id => store('readonly', s => s.get(id));
const putScore = rec => store('readwrite', s => s.put(rec));
const delScore = id => store('readwrite', s => s.delete(id));
const getPractice = key => store('readonly', s => s.get(key), 'practice');
const putPractice = p => store('readwrite', s => s.put(p), 'practice');
const delPractice = key => store('readwrite', s => s.delete(key), 'practice');

async function pdfHash(buf) {
  try {
    const d = await crypto.subtle.digest('SHA-256', buf);
    return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('');
  } catch { return null; }
}
// 예전에 넣은 악보는 해시가 없어서 처음 쓸 때 만든다
async function ensureHash(s) {
  if (!s.hash) { s.hash = await pdfHash(s.pdf); if (s.hash) await putScore(s); }
  return s.hash || s.id;
}

// ---------- 보관함 ----------

async function addFiles(files) {
  const busy = $('busy'), errors = [];
  for (const f of files) {
    busy.hidden = false;
    busy.textContent = `「${f.name}」 읽는 중…`;
    try {
      const buf = await f.arrayBuffer();
      const task = pdfjs.getDocument({ data: new Uint8Array(buf.slice(0)) });
      const d = await task.promise;
      const a = await analyzePdf(d, pdfjs.OPS);
      const thumb = await makeThumb(d);
      task.destroy();
      const id = (crypto.randomUUID && crypto.randomUUID()) || String(Date.now() + Math.random());
      const hash = await pdfHash(buf);
      await putScore({ id, hash, title: f.name.replace(/\.pdf$/i, ''), pdf: buf, analysis: a, thumb,
                       order: a.order, bpm: a.bpm, click: true, countin: true, added: Date.now() });
    } catch (e) {
      errors.push(`「${f.name}」을 읽지 못했습니다 (${e.message})`);
    }
  }
  busy.hidden = !errors.length;
  busy.textContent = errors.join('\n');
  await renderLibrary();
}

// 보관함 카드용 첫 쪽 미리보기 (가로 360px JPEG)
async function makeThumb(d) {
  try {
    const page = await d.getPage(1);
    const vp0 = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: 360 / vp0.width });
    const c = el('canvas');
    c.width = Math.round(vp.width); c.height = Math.round(vp.height);
    await page.render({ canvas: c, canvasContext: c.getContext('2d'), viewport: vp }).promise;
    return await new Promise(res => c.toBlob(res, 'image/jpeg', 0.8));
  } catch { return null; }
}
// 미리보기 없이 저장된 예전 악보는 보관함을 열 때 만든다
async function ensureThumb(s) {
  if (s.thumb) return s.thumb;
  const task = pdfjs.getDocument({ data: new Uint8Array(s.pdf.slice(0)) });
  try { s.thumb = await makeThumb(await task.promise); } finally { task.destroy(); }
  if (s.thumb) await putScore(s);
  return s.thumb;
}

let thumbUrls = [];
const TRASH = icon('trash-2', 16);
async function renderLibrary() {
  const list = $('list');
  const scores = (await allScores()).sort((a, b) => b.added - a.added);
  renderSummary(scores);
  $('listCount').textContent = scores.length ? `${scores.length}곡` : '';
  thumbUrls.forEach(u => URL.revokeObjectURL(u)); thumbUrls = [];
  list.replaceChildren();
  if (!scores.length) {
    const e = el('div', 'empty');
    e.textContent = '아직 악보가 없습니다. 「PDF 추가」로 넣어 주세요.';
    list.append(e);
    return;
  }
  for (const s of scores) {
    const a = s.analysis;
    const card = el('div', 'card' + (a.error ? ' bad' : ''));
    const open = () => !a.error && openScore(s.id);
    const thumb = el('button', 'thumb');
    thumb.setAttribute('aria-label', `${s.title} 열기`);
    thumb.onclick = open;
    const img = el('img'); img.alt = '';
    thumb.append(img);
    ensureThumb(s).then(b => { if (b) { const u = URL.createObjectURL(b); thumbUrls.push(u); img.src = u; } }).catch(() => {});
    const info = el('div', 'info');
    const meta = el('div', 'meta');
    const name = el('div', 'name'); name.textContent = s.title;
    const sub = el('div', 'sub');
    sub.textContent = a.error ? a.error : `${a.pages.length}쪽 · ${a.measures.length}마디 · ♩=${s.bpm}`;
    const keyP = ensureHash(s);
    if (!a.error) keyP.then(getPractice).then(pr => {
      if (!pr || pr.seconds < 1) return;
      const t = el('div', 'sub practiced'); t.textContent = `연습 ${fmtDur(pr.seconds)}`; meta.append(t);
      const rb = el('button', 'rec-btn'); rb.textContent = '기록';
      rb.setAttribute('aria-label', `${s.title} 연습 기록`);
      rb.onclick = () => openRecord(s.id);
      info.append(rb);
    }).catch(() => {});
    meta.append(name, sub);
    meta.onclick = open;
    const del = el('button', 'del');
    del.innerHTML = TRASH;
    del.setAttribute('aria-label', `${s.title} 삭제`);
    del.onclick = async () => {
      if (del.classList.contains('armed')) {
        const key = await keyP;
        await delScore(s.id);
        // 같은 PDF가 보관함에 하나 더 있으면 기록은 남긴다
        if (!scores.some(o => o.id !== s.id && (o.hash || o.id) === key)) await delPractice(key);
        renderLibrary(); return;
      }
      del.classList.add('armed'); del.textContent = '삭제할까요?';
      setTimeout(() => { del.classList.remove('armed'); del.innerHTML = TRASH; }, 3000);
    };
    info.append(meta);
    card.append(thumb, info, del);
    list.append(card);
  }
}

// ---------- 연습 기록 (홈 요약, 곡별 기록 화면) ----------

const getAllPractice = () => store('readonly', s => s.getAll(), 'practice');
// 오늘부터 거꾸로 n일의 날짜 (오래된 날이 앞)
function lastDays(n) {
  const out = [], d = new Date();
  for (let i = n - 1; i >= 0; i--) { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate() - i); out.push(x); }
  return out;
}
const WEEK = ['일', '월', '화', '수', '목', '금', '토'];
// 날짜별 막대. 값 단위는 초
function bars(items) {
  const box = el('div', 'chart');
  const max = Math.max(60, ...items.map(x => x.sec));
  for (const x of items) {
    const col = el('div', 'col' + (x.today ? ' today' : ''));
    const v = el('span', 'v'); v.textContent = x.sec >= 60 ? Math.round(x.sec / 60) : '';
    const bar = el('i'); bar.style.height = (x.sec ? Math.max(4, x.sec / max * 100) : 0) + '%';
    const track = el('div', 'track'); track.append(bar);
    const lb = el('span', 'lb'); lb.textContent = x.label;
    col.title = `${x.title}: ${fmtDur(x.sec)}`;
    col.append(v, track, lb);
    box.append(col);
  }
  return box;
}
function stat(label, value) {
  const d = el('div', 'stat');
  const l = el('div', 'stat-l'); l.textContent = label;
  const v = el('div', 'stat-v'); v.textContent = value;
  d.append(l, v); return d;
}
const dayItems = (days, n, labelOf) => lastDays(n).map((d, i, arr) => ({
  sec: days[dayKey(d)] || 0, label: labelOf(d), title: `${d.getMonth() + 1}월 ${d.getDate()}일`, today: i === arr.length - 1
}));

// 보관함 맨 위: 최근 7일 요약. 기록이 없으면 숨긴다
async function renderSummary(scores) {
  const box = $('summary');
  const recs = (await getAllPractice()).filter(p => p.seconds >= 1);
  if (!recs.length) { $('recentSec').hidden = true; return; }
  const titleOf = key => (scores.find(s => (s.hash || s.id) === key) || {}).title;
  const keys = lastDays(7).map(d => dayKey(d));
  const sum = {};
  const perSong = recs.map(p => ({ title: titleOf(p.key) || p.title, sec: keys.reduce((t, k) => t + (p.days[k] || 0), 0) }));
  for (const p of recs) for (const k of keys) sum[k] = (sum[k] || 0) + (p.days[k] || 0);
  const week = keys.reduce((t, k) => t + sum[k], 0);
  const top = perSong.sort((a, b) => b.sec - a.sec)[0];
  const stats = el('div', 'stats');
  stats.append(stat('연습 시간', week >= 1 ? fmtDur(week) : '없음'),
               stat('연습한 날', `${keys.filter(k => sum[k] >= 1).length}일`),
               stat('많이 한 곡', top && top.sec >= 1 ? `${top.title} · ${fmtDur(top.sec)}` : '없음'));
  box.replaceChildren(stats, bars(dayItems(sum, 7, d => WEEK[d.getDay()])));
  $('recentSec').hidden = false;
}

// 곡 기록 화면: 숫자 요약, 최근 14일 막대, 악보 위에 많이 친 마디 칠하기
let recTask = null, recId = null;
async function openRecord(id) {
  const s = await getScore(id);
  const key = await ensureHash(s);
  const pr = (await getPractice(key)) || { counts: {}, seconds: 0, days: {} };
  const a = s.analysis;
  recId = id;
  $('recTitle').textContent = s.title;
  const counts = Object.values(pr.counts), max = Math.max(0, ...counts);
  const week = lastDays(7).reduce((t, d) => t + (pr.days[dayKey(d)] || 0), 0);
  const stats = el('div', 'stats');
  stats.append(stat('총 연습', fmtDur(pr.seconds)), stat('최근 7일', week >= 1 ? fmtDur(week) : '없음'),
               stat('연습한 날', `${Object.values(pr.days).filter(x => x >= 1).length}일`),
               stat('친 마디', `${counts.length} / ${a.measures.length}마디`));
  const chartCard = el('div', 'panel-card');
  const ch = el('h3'); ch.textContent = '최근 14일 (분)';
  chartCard.append(ch, bars(dayItems(pr.days, 14, d => d.getDate())));
  const mapCard = el('div', 'panel-card');
  const mh = el('h3'); mh.textContent = '많이 친 마디';
  const legend = el('p', 'legend');
  legend.innerHTML = max ? `진할수록 많이 친 마디입니다. 가장 많이 친 마디 <b>${max}회</b>. 숫자는 친 횟수입니다.` : '아직 끝까지 친 마디가 없습니다.';
  const pages = el('div', 'rec-pages');
  mapCard.append(mh, legend, pages);
  $('recBody').replaceChildren(stats, chartCard, mapCard);
  $('library').hidden = true; $('record').hidden = false;
  scrollTo(0, 0);

  recTask = pdfjs.getDocument({ data: new Uint8Array(s.pdf.slice(0)) });
  const d = await recTask.promise;
  const W = Math.min(pages.clientWidth || 800, 900), dpr = Math.min(devicePixelRatio || 1, 2);
  for (let pi = 0; pi < a.pages.length; pi++) {
    if (recId !== id) return;
    const pg = a.pages[pi];
    const wrap = el('div', 'rec-page'); wrap.style.width = W + 'px'; wrap.style.aspectRatio = `${pg.w} / ${pg.h}`;
    const no = el('span', 'no'); no.textContent = `${pi + 1}쪽`;
    const c = el('canvas'); wrap.append(c, no);
    a.measures.forEach((m, i) => {
      if (m.page !== pi) return;
      const n = pr.counts[i + 1] || 0;
      const b = el('div', 'hm' + (n ? ' on' : ''));
      const top = m.y0 - m.pad_top, bottom = m.y1 + m.pad_bot;
      Object.assign(b.style, { left: m.x0 / pg.w * 100 + '%', width: (m.x1 - m.x0) / pg.w * 100 + '%',
                               top: top / pg.h * 100 + '%', height: (bottom - top) / pg.h * 100 + '%' });
      if (n) { b.style.setProperty('--heat', (0.12 + 0.43 * n / max).toFixed(3)); const t = el('span'); t.textContent = n; b.append(t); }
      b.title = `${i + 1}마디 · ${n}회`;
      wrap.append(b);
    });
    pages.append(wrap);
    const page = await d.getPage(pi + 1);
    const vp = page.getViewport({ scale: W * dpr / page.getViewport({ scale: 1 }).width });
    c.width = Math.round(vp.width); c.height = Math.round(vp.height);
    await page.render({ canvas: c, canvasContext: c.getContext('2d'), viewport: vp }).promise;
  }
}
function closeRecord() {
  recId = null;
  recTask && recTask.destroy(); recTask = null;
  $('recBody').replaceChildren();
  $('record').hidden = true; $('library').hidden = false;
  renderLibrary();
}
$('recBack').onclick = closeRecord;
$('recPlay').onclick = () => { const id = recId; closeRecord(); openScore(id); };

$('add').onclick = () => $('file').click();
$('file').onchange = e => { const files = [...e.target.files]; e.target.value = ''; addFiles(files); };

// ---------- 연습 화면 ----------

let rec, doc, docTask, A, M, views = [], els = [];
let bpm = 120, seq = [], starts = [], durs = [], playing = false;
let songTime = 0;
let ctx, anchorTime = 0, preEnd = 0, preLen = 0, preUnit = 1, nextClick = null, timer;
let layoutKey = '', slots = [null, null], lastScrollSys = null, wakeLock = null;
const cursor = el('div', 'cursor'), jumpTag = el('div', 'jump');

// 연습 기록: 재생 중 끝까지 지나간 마디 횟수, 실제로 재생한 시간(예비박 제외)
let practice = null, practiceDirty = false, trackIdx = -1, lastClock = null, flushTimer = null;
const dayKey = (d = new Date()) => { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
function fmtDur(sec) {
  const m = Math.floor(sec / 60);
  if (m < 1) return '1분 미만';
  return m < 60 ? `${m}분` : `${Math.floor(m / 60)}시간${m % 60 ? ` ${m % 60}분` : ''}`;
}
function countMeasure(n) {
  practice.counts[n] = (practice.counts[n] || 0) + 1;
  practiceDirty = true;
}
// 재생 시계가 흐른 만큼 시간을 더하고, 끝까지 지나간 마디를 센다
function trackPractice(t) {
  if (!practice) return;
  const c = now();
  if (lastClock != null && !counting()) {
    const dt = c - Math.max(lastClock, preEnd);
    if (dt > 0 && dt < 5) {
      practice.seconds += dt;
      const d = dayKey(); practice.days[d] = (practice.days[d] || 0) + dt;
      practiceDirty = true;
    }
  }
  lastClock = c;
  const end = t >= total() ? seq.length : where(t)[0];
  while (trackIdx >= 0 && trackIdx < end) countMeasure(seq[trackIdx++]);
}
async function flushPractice() {
  if (!practice || !practiceDirty) return;
  practiceDirty = false;
  practice.updated = Date.now();
  try { await putPractice(practice); } catch { practiceDirty = true; }
}
addEventListener('pagehide', () => flushPractice());
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushPractice(); });

const pref = (k, v) => { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch { return null; } };

async function openScore(id) {
  rec = await getScore(id);
  A = rec.analysis; M = A.measures;
  const key = await ensureHash(rec);
  practice = (await getPractice(key)) || { key, title: rec.title, counts: {}, seconds: 0, days: {}, updated: 0 };
  docTask = pdfjs.getDocument({ data: new Uint8Array(rec.pdf.slice(0)) });
  doc = await docTask.promise;
  bpm = rec.bpm;
  $('title').textContent = rec.title;
  $('bpm').value = bpm;
  showSpeed();
  $('order').value = rec.order;
  $('found').textContent = '인식: ' + (A.found.join(' · ') || '없음');
  $('warn').textContent = A.warnings.length ? '확인 필요: ' + A.warnings.join(', ') : '';
  setTog('click', rec.click !== false);
  setTog('countin', rec.countin !== false);

  views = A.pages.map((pg, pi) => {
    const page = el('div', 'page');
    const no = el('span', 'no'); no.textContent = `${pi + 1}쪽`;
    page.append(no);
    return { pg, pi, el: page, canvas: null, width: 0, want: 0 };
  });
  els = M.map((m, i) => {
    const pg = A.pages[m.page];
    const top = m.y0 - m.pad_top, bottom = m.y1 + m.pad_bot;
    const b = el('div', 'm');
    Object.assign(b.style, {
      left: m.x0 / pg.w * 100 + '%', width: (m.x1 - m.x0) / pg.w * 100 + '%',
      top: top / pg.h * 100 + '%', height: (bottom - top) / pg.h * 100 + '%'
    });
    b.title = `${i + 1}마디`;
    b.onclick = () => jumpToMeasure(i + 1);
    views[m.page].el.append(b);
    return b;
  });
  seq = parseOrder(rec.order, M.length);
  if (!seq.length) seq = M.map((_, i) => i + 1);
  layout(); songTime = 0; layoutKey = ''; slots = [null, null];
  buildPager();
  $('library').hidden = true; $('player').hidden = false;
  render();
}

function closeScore() {
  if (playing) pause();
  setMenu(false);
  flushPractice(); practice = null;
  docTask && docTask.destroy(); doc = docTask = null; M = null;
  $('stage').replaceChildren();
  $('player').hidden = true; $('library').hidden = false;
  renderLibrary();
}
$('back').onclick = closeScore;

const save = patch => { Object.assign(rec, patch); putScore(rec); };
function setTog(id, on) { $(id).setAttribute('aria-pressed', on ? 'true' : 'false'); }
const isOn = id => $(id).getAttribute('aria-pressed') === 'true';
for (const id of ['click', 'countin']) $(id).onclick = () => { setTog(id, !isOn(id)); save({ [id]: isOn(id) }); };

// ---------- 시간 ----------

// 마디 길이(초) = 박 수 × 박 길이. 악보 안 템포 변경은 사용자 BPM 비율대로 함께 바뀐다
const scale = () => bpm / A.bpm;
const unitSec = m => (4 / m.den) * 60 / (m.tempo * scale());
function layout() {
  starts = []; durs = [];
  let t = 0;
  for (const n of seq) { const m = M[n - 1], d = m.num * unitSec(m); starts.push(t); durs.push(d); t += d; }
}
const total = () => starts.length ? starts.at(-1) + durs.at(-1) : 0;
function where(t) {
  if (t <= 0) return [0, 0];
  let lo = 0, hi = seq.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= t) lo = mid; else hi = mid - 1; }
  return [lo, Math.min(1, (t - starts[lo]) / durs[lo])];
}

const now = () => ctx ? ctx.currentTime : 0;
const counting = () => playing && now() < preEnd;
const timeNow = () => playing && !counting() ? now() - anchorTime : songTime;
function reanchor() { anchorTime = Math.max(now(), preEnd) - songTime; nextClick = null; }

function click(time, accent, count) {
  if (!isOn('click') && !count) return;
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.frequency.value = count ? 1320 : accent ? 1600 : 1000;
  g.gain.setValueAtTime(0.0001, time);
  g.gain.exponentialRampToValueAtTime(accent || count ? 0.6 : 0.3, time + 0.002);
  g.gain.exponentialRampToValueAtTime(0.0001, time + 0.05);
  o.connect(g).connect(ctx.destination);
  o.start(time); o.stop(time + 0.06);
}
function schedule() {
  if (!nextClick) { const [i, f] = where(songTime); nextClick = { idx: i, k: Math.ceil(f * M[seq[i] - 1].num - 1e-6) }; }
  const ahead = now() + 0.12;
  while (nextClick.idx < seq.length) {
    const m = M[seq[nextClick.idx] - 1];
    if (nextClick.k >= m.num) { nextClick = { idx: nextClick.idx + 1, k: 0 }; continue; }
    const at = anchorTime + starts[nextClick.idx] + nextClick.k * unitSec(m);
    if (at > ahead) break;
    if (at >= now() - 0.01) click(at, nextClick.k === 0, false);
    nextClick.k++;
  }
}

async function keepAwake(on) {
  try {
    if (on && 'wakeLock' in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.onrelease = () => { wakeLock = null; }; }
    if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch {}
}
document.addEventListener('visibilitychange', () => { if (playing && document.visibilityState === 'visible') keepAwake(true); });

function setPlayIcon(on) {
  $('play').innerHTML = icon(on ? 'pause' : 'play', 18, true);
  $('play').setAttribute('aria-label', on ? '정지' : '재생');
}
setPlayIcon(false);
$('reset').innerHTML = icon('skip-back', 18);
$('slower').innerHTML = icon('minus', 18);
$('faster').innerHTML = icon('plus', 18);
for (const id of ['back', 'recBack']) $(id).innerHTML = icon('chevron-left', 18) + '보관함';

function play() {
  ctx ||= new (window.AudioContext || window.webkitAudioContext)();
  ctx.resume();
  if (songTime >= total()) songTime = 0;
  const [i, f] = where(songTime);
  const m = M[seq[i] - 1];
  const start = now() + 0.05;
  preLen = 0; preUnit = unitSec(m);
  if (isOn('countin') && f === 0) {
    preLen = m.num * preUnit;
    for (let k = 0; k < m.num; k++) click(start + k * preUnit, false, true);
  }
  preEnd = start + preLen;
  playing = true; reanchor();
  trackIdx = i; lastClock = now();
  flushTimer = setInterval(flushPractice, 10000);
  timer = setInterval(schedule, 25); schedule();
  setPlayIcon(true);
  keepAwake(true);
  requestAnimationFrame(tick);
}
function stopTracking() { trackPractice(timeNow()); trackIdx = -1; lastClock = null; clearInterval(flushTimer); flushPractice(); }
function pause() {
  stopTracking();
  const [i] = where(timeNow());
  songTime = starts[i];
  playing = false; clearInterval(timer); preEnd = 0;
  setPlayIcon(false);
  keepAwake(false);
  render();
}
function tick() {
  if (!playing) return;
  songTime = timeNow();
  trackPractice(songTime);
  if (songTime >= total()) { stopTracking(); playing = false; clearInterval(timer); preEnd = 0; setPlayIcon(false); keepAwake(false); songTime = 0; render(); return; }
  render();
  requestAnimationFrame(tick);
}
function setBpm(v) {
  v = Math.max(20, Math.min(400, Math.round(v)));
  const [i, f] = where(timeNow());
  bpm = v; $('bpm').value = v;
  showSpeed();
  layout();
  songTime = starts[i] + f * durs[i];
  if (playing) reanchor();
  save({ bpm });
  render();
}
// 배속 = 지금 BPM ÷ 악보에 적힌 BPM. 목록마다 실제 BPM을 같이 보여준다
const SPEEDS = [0.5, 0.6, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 1, 1.1, 1.2];
function showSpeed() {
  const base = A.bpm, x = bpm / base;
  const preset = SPEEDS.find(s => Math.round(base * s) === bpm);
  const fmtX = s => `${+s.toFixed(2)}x`;
  // 원곡 속도는 배지로 표시
  const label = (s, b) => `<span>${fmtX(s)} · ♩${b}</span>` + (s === 1 && b === base ? '<span class="badge">원곡</span>' : '');
  $('speed').innerHTML = label(preset ?? x, bpm) + icon('chevron-down', 16);
  const items = SPEEDS.map(s => [s, Math.round(base * s)]);
  if (preset == null) items.unshift([x, bpm]);
  $('speedMenu').replaceChildren(...items.map(([s, b]) => {
    const o = el('button', 'opt');
    const on = b === bpm;
    o.setAttribute('role', 'option'); o.setAttribute('aria-selected', on);
    o.innerHTML = `<span class="ck">${on ? icon('check', 16) : ''}</span>` + label(s, b);
    o.onclick = () => { setSpeedMenu(false); if (!on) setBpm(b); };
    return o;
  }));
}
const setSpeedMenu = open => {
  $('speedMenu').hidden = !open; $('speed').setAttribute('aria-expanded', open);
  if (open) $('speedMenu').querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
};
$('speed').onclick = e => { e.stopPropagation(); setSpeedMenu($('speedMenu').hidden); };
$('speedMenu').onclick = e => e.stopPropagation();
document.addEventListener('click', () => setSpeedMenu(false));

function moveTo(idx) {
  idx = Math.max(0, Math.min(seq.length - 1, idx));
  songTime = starts[idx];
  if (playing) { reanchor(); trackIdx = idx; }
  render();
}
function jumpToMeasure(n) {
  const [cur] = where(timeNow());
  let idx = seq.findIndex((m, i) => m === n && i > cur);
  if (idx < 0) idx = seq.indexOf(n);
  if (idx < 0) return;
  const was = playing;
  if (was) pause();
  moveTo(idx);
  if (was) play();
}
function setOrder(text) {
  const s = parseOrder(text, M.length);
  seq = s.length ? s : M.map((_, i) => i + 1);
  layout(); songTime = 0; if (playing) { reanchor(); trackIdx = 0; }
  save({ order: text });
  render();
}

// ---------- 쪽 이동 ----------

// 그 쪽의 첫 마디로. dir>0(▶·번호): 지금 위치 다음에 처음 들어가는 곳, dir<0(◀): 지금 위치 앞에서 가장 가까운 곳
function goToPage(p, dir = 1) {
  if (p < 0 || p >= A.pages.length) return;
  const [cur] = where(timeNow());
  const entries = seq.map((_, i) => i).filter(i => M[seq[i] - 1].page === p && (i === 0 || M[seq[i - 1] - 1].page !== p));
  if (!entries.length) return;
  const idx = dir < 0 ? (entries.filter(i => i < cur).at(-1) ?? entries[0])
                      : (entries.find(i => i > cur) ?? entries[0]);
  const was = playing;
  if (was) pause();
  moveTo(idx);
  if (was) play();
}
const currentPage = () => M[seq[where(timeNow())[0]] - 1].page;

let pagerKey = '';
function buildPager() {
  const nav = $('pager');
  nav.replaceChildren();
  const prev = el('button'); prev.innerHTML = icon('chevron-left', 20); prev.setAttribute('aria-label', '앞 쪽'); prev.onclick = () => goToPage(currentPage() - 1, -1);
  nav.append(prev);
  A.pages.forEach((_, p) => {
    const b = el('button'); b.textContent = p + 1; b.dataset.page = p;
    b.onclick = () => goToPage(p);
    nav.append(b);
  });
  const next = el('button'); next.innerHTML = icon('chevron-right', 20); next.setAttribute('aria-label', '다음 쪽'); next.onclick = () => goToPage(currentPage() + 1);
  nav.append(next);
  pagerKey = '';
}
function updatePager(P) {
  const shown = new Set(viewMode() === 'double' ? slots.filter(x => x != null) : [P]);
  const key = P + ':' + [...shown];
  if (key === pagerKey) return;
  pagerKey = key;
  for (const b of $('pager').querySelectorAll('button[data-page]')) {
    b.classList.toggle('on', +b.dataset.page === P);
    b.classList.toggle('shown', shown.has(+b.dataset.page) && +b.dataset.page !== P);
  }
}

// 악보를 좌우로 밀어 쪽 넘기기 (스크롤 보기에서는 쓰지 않음)
let touchStart = null;
$('stage').addEventListener('touchstart', e => {
  if (e.touches.length === 1) touchStart = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now() };
}, { passive: true });
$('stage').addEventListener('touchend', e => {
  if (!touchStart || viewMode() === 'scroll') return;
  const t = e.changedTouches[0], dx = t.clientX - touchStart.x, dy = t.clientY - touchStart.y;
  if (Math.abs(dx) > 60 && Math.abs(dy) < 50 && Date.now() - touchStart.t < 600) goToPage(currentPage() + (dx < 0 ? 1 : -1), dx < 0 ? 1 : -1);
  touchStart = null;
});

// ---------- 쪽 그리기 ----------

let renderChain = Promise.resolve();
function sizePage(v, w) {
  const h = w * v.pg.h / v.pg.w;
  v.el.style.width = w + 'px'; v.el.style.height = h + 'px';
  const want = Math.round(w * Math.min(window.devicePixelRatio || 1, 3));
  if (v.want === want) return;
  v.want = want;
  renderChain = renderChain.then(async () => {
    if (v.want !== want || v.width === want) return;
    const page = await doc.getPage(v.pi + 1);
    const vp = page.getViewport({ scale: want / v.pg.w });
    const c = el('canvas');
    c.width = Math.round(vp.width); c.height = Math.round(vp.height);
    await page.render({ canvas: c, canvasContext: c.getContext('2d'), viewport: vp }).promise;
    if (v.canvas) v.canvas.replaceWith(c); else v.el.prepend(c);
    v.canvas = c; v.width = want;
  }).catch(() => {});
}

// 고른 적이 없으면 스크롤 보기
const savedView = () => pref('view') || 'scroll';
function viewMode() {
  const saved = savedView();
  if (saved === 'scroll') return 'scroll';
  const st = $('stage'), W = st.clientWidth, H = st.clientHeight;
  const pg = A.pages[0];
  const fit2 = Math.min(H / pg.h, (W - 28) / 2 / pg.w), fit1 = Math.min(H / pg.h, (W - 16) / pg.w);
  if (saved === 'single') return 'single';
  if (saved === 'double') return A.pages.length > 1 ? 'double' : 'single';
  // 자동: 두 쪽을 놓아도 한 쪽 크기의 80% 이상이면 두 쪽
  return A.pages.length > 1 && fit2 >= fit1 * 0.8 ? 'double' : 'single';
}
$('view').onclick = () => {
  const order = ['auto', 'single', 'double', 'scroll'];
  const cur = savedView();
  const next = order[(order.indexOf(cur) + 1) % order.length];
  pref('view', next);
  $('view').textContent = { auto: '보기: 자동', single: '보기: 한 쪽', double: '보기: 두 쪽', scroll: '보기: 스크롤' }[next];
  layoutKey = ''; slots = [null, null]; render();
};
$('view').textContent = { auto: '보기: 자동', single: '보기: 한 쪽', double: '보기: 두 쪽', scroll: '보기: 스크롤' }[savedView()];

function resetPageEl(v) { v.el.style.position = ''; v.el.style.top = ''; v.el.style.left = ''; }

// 지금 마디 다음으로 쪽이 바뀌는 곳(연주 순서 기준)
function nextPageChange(idx) {
  const P = M[seq[idx] - 1].page;
  let j = idx + 1;
  while (j < seq.length && M[seq[j] - 1].page === P) j++;
  return j < seq.length ? j : null;
}

function arrange(idx, frac) {
  const st = $('stage');
  const W = st.clientWidth, H = st.clientHeight;
  const mode = viewMode();
  const m = M[seq[idx] - 1], P = m.page;

  if (mode === 'scroll') {
    const key = `scroll:${W}`;
    if (key !== layoutKey) {
      layoutKey = key; lastScrollSys = null;
      st.className = 'scroll';
      views.forEach(v => { resetPageEl(v); sizePage(v, Math.min(W - 32, 900)); });
      st.replaceChildren(...views.map(v => v.el));
    }
    const sys = m.page + ':' + m.y0;
    if (sys !== lastScrollSys) {
      lastScrollSys = sys;
      const r = els[seq[idx] - 1].getBoundingClientRect(), sr = st.getBoundingClientRect();
      st.scrollTo({ top: st.scrollTop + r.top - sr.top - sr.height * 0.25, behavior: 'smooth' });
    }
    return;
  }
  st.className = '';
  const j = nextPageChange(idx);
  const T = j == null ? null : M[seq[j] - 1].page;

  if (mode === 'double') {
    const k = slots.indexOf(P);
    const fallback = P + 1 < views.length ? P + 1 : P - 1;
    if (k < 0) slots = [P, T ?? fallback];
    else if (T != null) slots[1 - k] = T;
    else if (slots[1 - k] == null || slots[1 - k] === P) slots[1 - k] = fallback;
    const key = `double:${W}x${H}:${slots}`;
    if (key === layoutKey) return;
    layoutKey = key;
    const s = Math.min(...slots.map(p => Math.min(H / A.pages[p].h, (W - 28) / 2 / A.pages[p].w)));
    st.replaceChildren(...slots.map(p => {
      const v = views[p], sheet = el('div', 'sheet');
      resetPageEl(v); sizePage(v, v.pg.w * s);
      sheet.append(v.el);
      return sheet;
    }));
    return;
  }

  // 한 쪽: 쪽이 바뀌기 전에 화면 위쪽을 다음 쪽(연주 순서상)으로 미리 바꾼다
  const pgP = A.pages[P];
  const s = Math.min(H / pgP.h, (W - 16) / pgP.w);
  let split = null;
  if (T != null && T !== P) {
    const b = m.y0 - m.pad_top;
    const ahead = seq.slice(idx, j).map(n => M[n - 1]);
    const goesDown = ahead.every(x => x.y0 >= m.y0);
    const lastSystem = ahead.every(x => x.y0 === m.y0);
    const tm = M[seq[j] - 1], pgT = A.pages[T];
    const tTop = Math.max(0, Math.min(tm.y0 - tm.pad_top, pgT.h - b));
    const fits = tm.y1 + tm.pad_bot - tTop <= b;  // 다음에 칠 줄이 위쪽 칸에 다 들어가야 쓸모 있다
    if (goesDown && fits && (b >= pgP.h * 0.45 || lastSystem)) split = { b: Math.round(b), tTop: Math.round(tTop) };
  }
  // 미리 볼 수 없으면 바뀌기 직전 마지막 박에서 통째로 넘긴다
  let shown = P;
  if (T != null && !split && idx === j - 1 && frac >= (m.num - 1) / m.num) shown = T;
  const key = `single:${W}x${H}:${shown}:${split ? `${T}:${split.b}:${split.tTop}` : ''}`;
  if (key === layoutKey) return;
  layoutKey = key;
  const sheet = el('div', 'sheet');
  sheet.style.width = pgP.w * s + 'px'; sheet.style.height = pgP.h * s + 'px';
  views.forEach(resetPageEl);
  if (!split) {
    sizePage(views[shown], A.pages[shown].w * s);
    sheet.append(views[shown].el);
  } else {
    const vT = views[T], vP = views[P];
    const top = el('div', 'clip top'), bot = el('div', 'clip');
    top.style.height = split.b * s + 'px';
    bot.style.top = split.b * s + 'px'; bot.style.height = (pgP.h - split.b) * s + 'px';
    sizePage(vT, A.pages[T].w * s); sizePage(vP, pgP.w * s);
    vT.el.style.top = -split.tTop * s + 'px';
    vP.el.style.top = -split.b * s + 'px';
    const label = el('div', 'clip-label'); label.textContent = `다음: ${T + 1}쪽`;
    top.append(vT.el, label); bot.append(vP.el);
    sheet.append(top, bot);
  }
  st.replaceChildren(sheet);
}

function render() {
  if (!M) return;
  const t = timeNow(), cnt = counting();
  const [idx, frac] = where(t);
  const mNo = seq[idx], m = M[mNo - 1], box = els[mNo - 1];
  const nextNo = seq[idx + 1];
  const beatInBar = cnt ? Math.floor((preLen - (preEnd - now())) / preUnit) : Math.floor(frac * m.num);

  arrange(idx, cnt ? 0 : frac);
  updatePager(m.page);

  els.forEach(e => e.classList.remove('cur', 'next'));
  box.classList.add('cur');
  const isJump = nextNo && nextNo !== mNo + 1;
  if (isJump) els[nextNo - 1].classList.add('next');

  const pg = A.pages[m.page], page = views[m.page].el;
  if (cursor.parentElement !== page) page.append(cursor);
  if (jumpTag.parentElement !== page) page.append(jumpTag);
  Object.assign(cursor.style, {
    display: playing || t > 0 ? 'block' : 'none',
    left: (m.x0 + (m.x1 - m.x0) * frac) / pg.w * 100 + '%',
    top: (m.y0 - 6) / pg.h * 100 + '%', height: (m.y1 - m.y0 + 12) / pg.h * 100 + '%'
  });
  jumpTag.style.display = isJump && !cnt ? 'block' : 'none';
  if (isJump) {
    jumpTag.textContent = `다음 ${nextNo}마디로`;
    jumpTag.style.left = m.x0 / pg.w * 100 + '%';
    jumpTag.style.top = (m.y0 - m.pad_top + 2) / pg.h * 100 + '%';
  }

  const beats = $('beats');
  if (beats.children.length !== m.num) beats.innerHTML = '<i></i>'.repeat(m.num);
  beats.classList.toggle('count', cnt);
  [...beats.children].forEach((b, i) => b.classList.toggle('on', playing && i === beatInBar));

  const fmt = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  const extra = (m.tempo !== A.bpm ? ` · ♩=${Math.round(m.tempo * scale())}` : '') + (m.num !== 4 || m.den !== 4 ? ` · ${m.num}/${m.den}` : '');
  $('status').innerHTML = cnt ? `<b>예비박 ${beatInBar + 1}</b>`
    : `<b>${mNo}마디</b> · ${m.page + 1}/${A.pages.length}쪽 · ${fmt(t)} / ${fmt(total())}${extra}`;
}

$('play').onclick = () => playing ? pause() : play();
$('reset').onclick = () => { const was = playing; if (was) pause(); songTime = 0; render(); if (was) play(); };
$('slower').onclick = () => setBpm(bpm - 2);
$('faster').onclick = () => setBpm(bpm + 2);
$('bpm').onchange = e => setBpm(+e.target.value || bpm);
// 설정 메뉴: 바깥을 누르면 닫는다
const setMenu = open => { $('menu').hidden = !open; $('settings').setAttribute('aria-expanded', open); };
$('settings').onclick = e => { e.stopPropagation(); setMenu($('menu').hidden); };
$('menu').onclick = e => e.stopPropagation();
document.addEventListener('click', () => setMenu(false));
$('more').onclick = () => { $('panel').hidden = !$('panel').hidden; layoutKey = ''; render(); };
$('order').onchange = () => setOrder($('order').value);
$('autoOrder').onclick = () => { $('order').value = A.order; setOrder(A.order); };
addEventListener('resize', () => { if (M && !$('player').hidden) { layoutKey = ''; render(); } });
addEventListener('keydown', e => {
  if ($('player').hidden || (e.target.tagName === 'INPUT')) return;
  const [idx] = where(timeNow());
  if (e.code === 'Space') { e.preventDefault(); playing ? pause() : play(); }
  else if (e.key === 'ArrowRight') { e.preventDefault(); moveTo(idx + 1); }
  else if (e.key === 'ArrowLeft') { e.preventDefault(); moveTo(idx - 1); }
  else if (e.key === 'PageDown') { e.preventDefault(); goToPage(currentPage() + 1); }
  else if (e.key === 'PageUp') { e.preventDefault(); goToPage(currentPage() - 1, -1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); setBpm(bpm + 2); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); setBpm(bpm - 2); }
});

renderLibrary();

// 시험용 손잡이 (화면 동작에는 쓰지 않음)
window.scoreApp = {
  addFiles, openScore, allScores,
  get state() { return { playing, songTime, seq, starts, durs, layoutKey, slots, bpm }; },
  get practice() { return practice; }, flushPractice, openRecord, closeRecord, renderLibrary,
  setClock(c) { ctx = c; }, play, pause, render, schedule, setBpm, moveTo, goToPage
};
