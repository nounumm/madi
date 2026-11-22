// 악보 PDF 인식: 마디 위치, 템포, 박자표, 도돌이표·세뇨·Coda·괄호, 연주 순서.
// build.py(PyMuPDF)를 PDF.js로 옮긴 것. 브라우저와 node 둘 다에서 돈다.
// 악보 프로그램(MuseScore, Guitar Pro 등)에서 내보낸 PDF가 대상이고 스캔본은 마디를 못 찾는다.

const REPEAT_DOTS = '';
const SEGNO = new Set(['', '\u{1d10b}']);
const CODA = new Set(['', '', '\u{1d10c}']);
const TIMESIG = c => { const k = c.codePointAt(0) - 0xE080; return k >= 0 && k <= 9 ? k : null; };

// PDF.js 경로 그리기 코드
const P_MOVE = 0, P_LINE = 1, P_CURVE = 2, P_QUAD = 3, P_CLOSE = 4;

const mul = (m, n) => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]
];
const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
const r1 = v => Math.round(v * 10) / 10;

class Rect {
  constructor(x0, y0, x1, y1) { Object.assign(this, { x0, y0, x1, y1 }); }
  get width() { return this.x1 - this.x0; }
  get height() { return this.y1 - this.y0; }
}

// ---------- 페이지에서 선·글자 꺼내기 ----------

async function readPage(page, OPS) {
  const vp = page.getViewport({ scale: 1 });
  const base = vp.transform; // PDF 좌표 → 왼쪽 위 기준 좌표
  const ol = await page.getOperatorList();
  const fillOps = new Set([OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
  const strokeOps = new Set([OPS.stroke, OPS.closeStroke, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
  let ctm = base, lw = 1;
  const stack = [], drawings = [];
  for (let i = 0; i < ol.fnArray.length; i++) {
    const fn = ol.fnArray[i], args = ol.argsArray[i];
    if (fn === OPS.save) stack.push([ctm, lw]);
    else if (fn === OPS.restore) { if (stack.length) [ctm, lw] = stack.pop(); }
    else if (fn === OPS.transform) ctm = mul(ctm, args);
    else if (fn === OPS.setLineWidth) lw = args[0];
    else if (fn === OPS.constructPath) {
      const [paint, [data]] = args;
      const fill = fillOps.has(paint), stroke = strokeOps.has(paint);
      if (!data || (!fill && !stroke)) continue;
      const scale = Math.sqrt(Math.abs(ctm[0] * ctm[3] - ctm[1] * ctm[2]));
      const items = [];
      let sub = [], cur = null, curved = false, minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      const pt = (x, y) => { const p = apply(ctm, x, y); minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]); minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]); return p; };
      const endSub = () => {
        // 축에 맞는 닫힌 사각형은 rect 하나로
        if (!curved && sub.length >= 4 && sub.length <= 5) {
          const xs = sub.map(p => r1(p[0])), ys = sub.map(p => r1(p[1]));
          if (new Set(xs).size === 2 && new Set(ys).size === 2) {
            const k = items.length - (sub.length - 1);
            items.splice(Math.max(0, k));
            items.push(['re', new Rect(Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys))]);
          }
        }
        sub = []; curved = false;
      };
      for (let j = 0; j < data.length;) {
        const op = data[j++];
        if (op === P_MOVE) { endSub(); cur = pt(data[j++], data[j++]); sub.push(cur); }
        else if (op === P_LINE) { const p = pt(data[j++], data[j++]); if (cur) items.push(['l', cur, p]); cur = p; sub.push(p); }
        else if (op === P_CURVE) { pt(data[j++], data[j++]); pt(data[j++], data[j++]); cur = pt(data[j++], data[j++]); curved = true; items.push(['c']); }
        else if (op === P_QUAD) { pt(data[j++], data[j++]); cur = pt(data[j++], data[j++]); curved = true; items.push(['c']); }
        else if (op === P_CLOSE) { if (sub.length && cur && (cur[0] !== sub[0][0] || cur[1] !== sub[0][1])) items.push(['l', cur, sub[0]]); if (sub.length) sub.push(sub[0]); endSub(); cur = null; }
      }
      endSub();
      if (items.length) drawings.push({ items, width: stroke ? lw * scale : 0, fill, rect: new Rect(minX, minY, maxX, maxY) });
    }
  }
  const tc = await page.getTextContent();
  const spans = [];
  for (const it of tc.items) {
    if (!it.str || !it.str.trim()) continue;
    const m = mul(base, it.transform);
    const size = Math.hypot(m[2], m[3]);
    const [x, y] = [m[4], m[5]];
    const w = it.width * Math.hypot(base[0], base[1]);
    spans.push({ text: it.str, rect: new Rect(x, y - size * 0.8, x + w, y + size * 0.2), size });
  }
  return { w: vp.width, h: vp.height, drawings, spans };
}

// ---------- 마디 찾기 ----------

function staffLines(pg) {
  const segs = new Map();
  for (const dr of pg.drawings) {
    if (!(dr.width > 0.2 && dr.width < 1.2)) continue;
    for (const it of dr.items) {
      if (it[0] !== 'l') continue;
      const [a, b] = [it[1], it[2]];
      if (Math.abs(a[1] - b[1]) < 0.2 && Math.abs(a[0] - b[0]) > 20) {
        const s = [r1(Math.min(a[0], b[0])), r1(Math.max(a[0], b[0])), r1(a[1])];
        segs.set(s.join(','), s);
      }
    }
  }
  return [...segs.values()];
}

function verticalLines(pg) {
  const out = [];
  for (const dr of pg.drawings) for (const it of dr.items) {
    if (it[0] === 'l') {
      const [a, b] = [it[1], it[2]];
      if (Math.abs(a[0] - b[0]) < 0.5 && Math.abs(a[1] - b[1]) > 10) out.push([a[0], Math.min(a[1], b[1]), Math.max(a[1], b[1])]);
    } else if (it[0] === 're') {
      const r = it[1];
      if (r.width < 6 && r.height > 10) out.push([(r.x0 + r.x1) / 2, r.y0, r.y1]);
    }
  }
  return out;
}

function findStaves(segs) {
  const ys = [...new Set(segs.map(s => s[2]))].sort((a, b) => a - b);
  const groups = [];
  for (const y of ys) {
    const g = groups.at(-1);
    if (g && y - g.at(-1) > 2 && y - g.at(-1) < 12) g.push(y); else groups.push([y]);
  }
  const staves = [];
  for (let g of groups) {
    // P.M. 점선처럼 오선에 붙은 선은 간격이 달라서 빠진다: 간격이 같은 가장 긴 연속 구간만
    const gaps = g.slice(1).map((y, i) => y - g[i]);
    if (!gaps.length) continue;
    const mg = [...gaps].sort((a, b) => a - b)[gaps.length >> 1];
    let best = [], cur = [g[0]];
    g.slice(1).forEach((y, i) => { cur = Math.abs(gaps[i] - mg) < 1.5 ? [...cur, y] : [y]; if (cur.length > best.length) best = cur; });
    g = best;
    if (g.length < 4) continue;
    const row = segs.filter(s => s[2] === g[0]).map(s => [s[0], s[1]]).sort((a, b) => a[0] - b[0]);
    staves.push({ top: g[0], bot: g.at(-1), row });
  }
  return staves;
}

function mergeRow(row) {
  const out = [];
  for (const [a, b] of row) {
    const last = out.at(-1);
    if (last && Math.abs(a - last[1]) < 1.5 && (b - a < 15 || last[1] - last[0] < 15)) last[1] = b;
    else if (last && a < last[1] - 1) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

function findSystems(pg) {
  const staves = findStaves(staffLines(pg));
  const verts = verticalLines(pg);
  const systems = [];
  for (const st of staves) {
    const prev = systems.at(-1);
    if (prev) {
      const gap = st.top - prev.bot, span = st.bot - prev.top;
      const joined = verts.some(v => v[1] <= prev.top + 1 && v[2] >= st.bot - 1 && v[2] - v[1] < span + 20);
      const lastSt = prev.staves.at(-1);
      if (joined || gap < 0.9 * Math.max(st.bot - st.top, lastSt.bot - lastSt.top)) {
        prev.bot = st.bot; prev.staves.push(st); continue;
      }
    }
    systems.push({ top: st.top, bot: st.bot, staves: [st] });
  }
  for (const s of systems) s.cols = mergeRow(s.staves[0].row);
  return systems;
}

// ---------- 글자·기호 ----------

function locate(measures, pi, rect, below = true) {
  const cx = (rect.x0 + rect.x1) / 2, cy = (rect.y0 + rect.y1) / 2;
  let best = null;
  measures.forEach((m, i) => {
    if (m.page !== pi || !(m.x0 - 2 <= cx && cx <= m.x1 + 2)) return;
    let d;
    if (m.y0 - 2 <= cy && cy <= m.y1 + 2) d = 0;
    else if (below && cy < m.y0) { d = m.y0 - cy; if (d > 90) return; }
    else if (below && cy > m.y1) { d = cy - m.y1; if (d > 90) return; }
    else return;
    if (!best || d < best[0]) best = [d, i];
  });
  return best ? best[1] + 1 : null;
}

function analyseText(pages, measures) {
  const info = { bpm: null, tempos: {}, timesig: {}, starts: new Set(), ends: new Set(), voltas: {}, times: {},
                 segno: null, coda: null, tocoda: null, jump: null, fine: null, numbers: {} };
  const tsDigits = {};
  pages.forEach((pg, pi) => {
    for (const { text, rect: r, size } of pg.spans) {
      const s = text.trim();
      const tempo = s.match(/=\s*(\d{2,3})\b/);
      if (tempo) {
        const n = locate(measures, pi, r), bpm = +tempo[1];
        if (info.bpm == null) info.bpm = bpm;
        if (n && !(n in info.tempos)) info.tempos[n] = bpm;
        continue;
      }
      if (s.includes(REPEAT_DOTS)) {
        const n = locate(measures, pi, r, false);
        if (n) { const m = measures[n - 1], cx = (r.x0 + r.x1) / 2; (m.x1 - cx < 12 ? info.ends : info.starts).add(n); }
        continue;
      }
      if ([...s].some(c => SEGNO.has(c))) { info.segno ??= locate(measures, pi, r); continue; }
      if (/^to\s*coda/i.test(s)) { info.tocoda = locate(measures, pi, r); continue; }
      if ([...s].some(c => CODA.has(c)) || s.toLowerCase() === 'coda') { info.coda ??= locate(measures, pi, r); continue; }
      const mj = s.match(/^(D\.?\s?[SC]\.?)(\s*al\s*(Coda|Fine))?$/i);
      if (mj) { info.jump = { at: locate(measures, pi, r), kind: /S/i.test(mj[1]) ? 'DS' : 'DC' }; continue; }
      // 반복 횟수(x4): TAB 데드노트(X6)와 헷갈리지 않게 소문자·오선 밖만
      const mt = s.match(/^(?:[x×]\s*(\d+)|(\d+)\s*[x×])$/);
      if (mt) {
        const n = locate(measures, pi, r), cy = (r.y0 + r.y1) / 2;
        if (n && !(measures[n - 1].y0 - 2 <= cy && cy <= measures[n - 1].y1 + 2)) info.times[n] = +(mt[1] || mt[2]);
        continue;
      }
      if (s.toLowerCase() === 'fine') { info.fine = locate(measures, pi, r); continue; }
      const mv = s.match(/^(\d)\.(\s*,?\s*\d\.)*$/);
      if (mv && size >= 7) {
        const n = locate(measures, pi, r);
        if (n) info.voltas[n] = new Set(s.match(/\d/g).map(Number));
        continue;
      }
      const digits = [...s].map(TIMESIG).filter(d => d != null);
      if (digits.length) {
        const n = locate(measures, pi, r, false);
        if (n) (tsDigits[n] ||= []).push(+digits.join(''));
        continue;
      }
      if (/^\d+$/.test(s) && size < 9) {
        const cx = (r.x0 + r.x1) / 2, cy = (r.y0 + r.y1) / 2;
        const i = measures.findIndex(m => m.page === pi && m.y0 - cy > 0 && m.y0 - cy < 15 && cx - m.x0 > -8 && cx - m.x0 < 15);
        if (i >= 0 && !(i + 1 in info.numbers)) info.numbers[i + 1] = +s;
      }
    }
  });
  // 박자표: 그려진 순서대로 분자, 분모 (TAB+오선이면 여러 번 나와서 처음 두 개만)
  for (const [n, d] of Object.entries(tsDigits)) if (d.length >= 2) info.timesig[n] = [d[0], d[1]];
  return info;
}

function drawnRepeats(pages, measures, info) {
  // Guitar Pro처럼 도돌이 점을 그림으로 그리는 경우: 굵은 세로줄 옆 작은 점 두 개 (실제 악보로 검증 안 됨)
  if (info.starts.size || info.ends.size) return;
  pages.forEach((pg, pi) => {
    const dots = [], thick = [];
    for (const dr of pg.drawings) {
      const r = dr.rect;
      if (dr.fill && r.width > 1.5 && r.width < 5 && r.height > 1.5 && r.height < 5 && Math.abs(r.width - r.height) < 1) dots.push(r);
      if (dr.fill && r.width > 1.5 && r.width < 6 && r.height > 15 && dr.items.length === 1 && dr.items[0][0] === 're') thick.push(r);
    }
    dots.forEach((a, i) => dots.slice(i + 1).forEach(b => {
      if (Math.abs(a.x0 - b.x0) > 0.5 || !(Math.abs(a.y0 - b.y0) > 3 && Math.abs(a.y0 - b.y0) < 12)) return;
      const cx = (a.x0 + a.x1) / 2;
      if (!thick.some(t => Math.abs(cx - (t.x0 + t.x1) / 2) < 9 && t.y0 - 1 <= Math.min(a.y0, b.y0) && t.y1 + 1 >= Math.max(a.y1, b.y1))) return;
      const n = locate(measures, pi, new Rect(a.x0, Math.min(a.y0, b.y0), b.x1, Math.max(a.y1, b.y1)), false);
      if (n) (measures[n - 1].x1 - cx < 12 ? info.ends : info.starts).add(n);
    }));
  });
}

// ---------- 연주 순서 ----------

export function playOrder(n, info) {
  const { starts, ends, voltas, jump } = info;
  const seq = [], taken = {};
  const tk = e => taken[e] || 0;
  const lastVolta = Math.max(0, ...Object.values(voltas).map(v => Math.max(...v)));
  let i = 1, secStart = 1, passNo = 1, phase = 'first'; // first → replay(D.S./D.C. 뒤) → coda
  while (i >= 1 && i <= n && seq.length < 2000) {
    if (voltas[i]) {
      const want = phase !== 'replay' ? passNo : lastVolta;
      if (!voltas[i].has(want)) { i++; continue; }
    }
    seq.push(i);
    if (phase === 'replay' && info.tocoda === i && info.coda) { phase = 'coda'; i = info.coda; passNo = 1; secStart = i; continue; }
    if (phase === 'replay' && info.fine === i) break;
    const timesEntry = Object.entries(info.times).find(([m]) => secStart <= +m && +m <= i);
    const times = timesEntry ? timesEntry[1] : 2;
    if (ends.has(i) && phase !== 'replay' && tk(i) < times - 1) {
      taken[i] = tk(i) + 1; i = secStart; passNo = Math.min(passNo + 1, times); continue;
    }
    if (jump && jump.at === i && phase === 'first') {
      // 도돌이 구간 안의 D.S./D.C.는 그 구간 마지막 반복 때 따른다
      const ownEnd = Math.min(...[...ends].filter(e => e >= i));
      const prevEnd = Math.max(0, ...[...ends].filter(e => e < i));
      const ownStart = [...starts, 1].filter(x => prevEnd < x && x <= i);
      const pending = isFinite(ownEnd) && ownStart.length && tk(ownEnd) === 0;
      if (!pending) {
        phase = 'replay';
        i = jump.kind === 'DS' && info.segno ? info.segno : 1;
        passNo = 1; continue;
      }
    }
    if (ends.has(i)) passNo = 1;
    i++;
    if (starts.has(i)) { secStart = i; passNo = 1; }
  }
  return seq;
}

export function compress(seq) {
  const parts = [];
  let a = null;
  seq.forEach((x, k) => {
    if (a == null) a = x;
    if (k + 1 === seq.length || seq[k + 1] !== x + 1) { parts.push(a === x ? `${a}` : `${a}-${x}`); a = null; }
  });
  return parts.join(',');
}

export function parseOrder(text, count) {
  const out = [];
  for (const part of String(text).split(',')) {
    const t = part.trim(); if (!t) continue;
    const [a, b] = t.split('-').map(Number);
    const end = Number.isFinite(b) ? b : a;
    if (!Number.isFinite(a)) continue;
    for (let n = a; a <= end ? n <= end : n >= end; n += a <= end ? 1 : -1) if (n >= 1 && n <= count) out.push(n);
  }
  return out;
}

// ---------- 전체 ----------

export async function analyzePdf(doc, OPS) {
  const pages = [];
  for (let p = 1; p <= doc.numPages; p++) pages.push(await readPage(await doc.getPage(p), OPS));
  const measures = [];
  pages.forEach((pg, pi) => {
    const systems = findSystems(pg);
    systems.forEach((s, k) => {
      const above = s.top - (k ? systems[k - 1].bot : 0);
      const below = (k + 1 < systems.length ? systems[k + 1].top : pg.h) - s.bot;
      for (const [a, b] of s.cols) measures.push({ page: pi, x0: a, x1: b, y0: s.top, y1: s.bot, pad_top: Math.min(40, above / 2), pad_bot: Math.min(45, below / 2) });
    });
  });
  const result = { pages: pages.map(p => ({ w: p.w, h: p.h })), measures, found: [], warnings: [] };
  if (!measures.length) { result.error = '마디를 찾지 못했습니다. 스캔본이나 이미지로 된 PDF일 수 있습니다.'; return result; }

  const info = analyseText(pages, measures);
  drawnRepeats(pages, measures, info);

  let num = 4, den = 4, tempo = info.bpm || 120;
  measures.forEach((m, k) => {
    const i = k + 1;
    if (info.timesig[i]) [num, den] = info.timesig[i];
    if (info.tempos[i]) tempo = info.tempos[i];
    Object.assign(m, { num, den, tempo });
  });

  for (const [n, v] of Object.entries(info.numbers)) if (v !== +n) result.warnings.push(`${n}번째로 찾은 마디에 ${v}번이 적혀 있습니다`);

  const f = result.found;
  if (info.bpm) f.push(`템포 ♩=${info.bpm}`);
  const ts = Object.entries(info.timesig);
  if (ts.length) f.push('박자표 ' + ts.map(([n, [a, b]]) => `${n}마디 ${a}/${b}`).join(', '));
  if (info.starts.size || info.ends.size) f.push(`도돌이 시작 ${[...info.starts].sort((a, b) => a - b)} / 끝 ${[...info.ends].sort((a, b) => a - b)}`);
  for (const [k, label] of [['segno', '세뇨'], ['tocoda', 'To Coda'], ['coda', 'Coda'], ['fine', 'Fine']]) if (info[k]) f.push(`${label} ${info[k]}마디`);
  if (info.jump) f.push(`${info.jump.kind === 'DS' ? 'D.S.' : 'D.C.'} ${info.jump.at}마디`);
  const times = Object.entries(info.times);
  if (times.length) f.push('반복 횟수 ' + times.map(([n, t]) => `${n}마디 x${t}`).join(', '));
  const vs = Object.entries(info.voltas);
  if (vs.length) f.push('괄호 ' + vs.map(([n, v]) => `${n}마디(${[...v].sort().join('·')})`).join(', '));

  result.bpm = info.bpm || 120;
  result.order = compress(playOrder(measures.length, info));
  return result;
}
