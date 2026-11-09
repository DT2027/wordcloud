/**
 * app.js —— 实时词云主程序
 * 单人模式：输入即分词、渲染词云。
 * 协作模式：文本存放在 Yjs 共享文档中，房间成员可同时编辑，词云基于共享内容实时生成。
 */
import { Collab } from './collab.js';

/* ---------------- DOM ---------------- */
const input   = document.getElementById('input');
const canvas  = document.getElementById('cloud');
const box     = document.getElementById('cloudBox');
const empty   = document.getElementById('empty');
const tip     = document.getElementById('tip');
const selPal  = document.getElementById('palette');
const rng     = document.getElementById('limit');
const rngVal  = document.getElementById('limitVal');
const btnGen  = document.getElementById('btnGen');
const btnSmp  = document.getElementById('btnSmp');
const btnClr  = document.getElementById('btnClear');
const sChars  = document.getElementById('sChars');
const sWords  = document.getElementById('sWords');
const sShow   = document.getElementById('sShow');
const sTime   = document.getElementById('sTime');
const btnCollab = document.getElementById('btnCollab');
const collabPanel = document.getElementById('collabPanel');
const collabStatus = document.getElementById('collabStatus');
const roomLabel = document.getElementById('roomId');
const btnCopy = document.getElementById('btnCopyLink');
const btnLeave = document.getElementById('btnLeave');
const myName = document.getElementById('myName');
const peerList = document.getElementById('peerList');
const sharedTag = document.getElementById('sharedTag');
const toast = document.getElementById('toast');

const ctx = canvas.getContext('2d');
const FONT = '"PingFang SC","Microsoft YaHei","Hiragino Sans GB",system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif';
const DICT = new Set((window.WORDLIST || '').split(/\s+/).filter(Boolean));

let items = [], hitList = [], timer = null;
let collab = null, composing = false;

const SAMPLE = '人工智能正在改变世界。自然语言处理让机器能够理解人类的语言，' +
  '大模型通过海量文本训练获得语言能力。神经网络是深度学习的核心，卷积神经网络擅长图像识别，' +
  '循环神经网络适合处理序列数据。机器学习包括监督学习、无监督学习和强化学习三种主要方法。' +
  '数据是模型训练的基础，数据质量决定了模型效果。词云是一种可视化方式，把文本中的高频词以不同字号展示，' +
  '帮助我们快速把握文本主题。可视化让复杂的信息变得直观，设计与可视化结合能提升沟通效率。' +
  'Web 技术让词云可以在浏览器里实时运行，无需服务器处理，JavaScript 与 Canvas 是关键。';

/* ---------------- 停用词 ---------------- */
const STOP_CN = ('的 了 是 在 和 与 及 或 有 不 就 也 都 而 之 其 被 把 让 给 从 向 由 对 为 以 于 并 但 却 还 又 再 很 更 最 ' +
  '我 你 他 她 它 们 这 那 些 个 一个 上 下 中 出 里 来 去 到 说 要 会 能 得 地 着 过 看 好 自 已 可以 因为 所以 但是 ' +
  '如果 虽然 什么 怎么 这样 那样 一些 一下 这个 那个 已经 没有 就是 还是 时候 现在 知道 觉得 因此 然后 其实 只是 或者 ' +
  '而且 并且 以及 通过 进行 出现 存在 需要 应该 可能 方面 问题 工作 公司 企业 数据 市场 用户 产品 服务 我们 你们 他们 ' +
  '一种 让 使 以 及 等 等等 该 本 各 每 所有 其中 其他 情况 内容 方式 时间 部分 相关 不同 主要 重要').split(/\s+/);
const STOP_SET = new Set(STOP_CN);
const EDGE_BAD = new Set('的了着过地得和与或及等就都也而之其于把被让给从向由对为以因但却还又再很更最是有在会能要说来去做好自'.split(''));
const STOP_EN = new Set(('the a an and or of to in for on with is are was were be been this that these those it its as at by from ' +
  'not but if then else when while we you they he she i me my our your their them us have has had do does did can could will ' +
  'would shall should may might must about into over under more most other some such no nor only own same so too very just').split(/\s+/));
const NUM_ONLY = /^[零一二三四五六七八九十百千万亿两]+$/;

/* ---------------- 中文分词：内聚度(PMI) + 上下文自由度 + 重叠消解 ---------------- */
function extractWords(text) {
  const low = text.toLowerCase();
  const runs = low.match(/[\u4e00-\u9fff\u3400-\u4dbf]+|[a-z][a-z0-9'’\-]*/g) || [];
  const MAXLEN = 6;
  const table = new Map();
  const chars = new Map();
  const en = new Map();
  let total = 0, offset = 0;

  runs.forEach((run) => {
    if (/^[a-z]/.test(run)) {
      if (run.length >= 2 && !STOP_EN.has(run)) en.set(run, (en.get(run) || 0) + 1);
      return;
    }
    total += run.length;
    for (let i = 0; i < run.length; i++) {
      const ch = run.charAt(i);
      chars.set(ch, (chars.get(ch) || 0) + 1);
      for (let len = 2; len <= MAXLEN && i + len <= run.length; len++) {
        const s = run.substr(i, len);
        let e = table.get(s);
        if (!e) { e = { w: s, c: 0, len, left: new Set(), right: new Set(), pos: [] }; table.set(s, e); }
        e.c++;
        if (i > 0) e.left.add(run.charAt(i - 1));
        if (i + len < run.length) e.right.add(run.charAt(i + len));
        if (e.pos.length < 80) e.pos.push(offset + i);
      }
    }
    offset += run.length;
  });
  if (!total && !en.size) return [];

  const cands = [];
  table.forEach((e) => {
    if (STOP_SET.has(e.w)) return;
    if (NUM_ONLY.test(e.w)) return;
    if (EDGE_BAD.has(e.w.charAt(0)) || EDGE_BAD.has(e.w.charAt(e.w.length - 1))) return;
    let minPmi = Infinity;
    for (let i = 1; i < e.len; i++) {
      const l = e.w.slice(0, i), r = e.w.slice(i);
      const cl = l.length === 1 ? (chars.get(l) || 0) : ((table.get(l) || {}).c || 0);
      const cr = r.length === 1 ? (chars.get(r) || 0) : ((table.get(r) || {}).c || 0);
      if (!cl || !cr) { minPmi = -Infinity; break; }
      const pmi = Math.log((e.c * total) / (cl * cr));
      if (pmi < minPmi) minPmi = pmi;
    }
    if (minPmi === -Infinity) return;
    const freedom = e.left.size * e.right.size;
    const thr = total < 400 ? 1.9 : 2.1;
    const isDict = DICT.has(e.w);
    const ok = (e.c >= 2 && minPmi >= thr)
      || (isDict && e.c >= 1 && minPmi >= 0.8)
      || (e.c === 1 && e.len >= 3 && freedom >= 4 && minPmi >= 2.5);
    if (!ok) return;
    e.score = e.c * (1 + Math.min(minPmi, 6) / 2) * (1 + 0.5 * Math.log(1 + freedom)) * (1 + 0.12 * (e.len - 2));
    cands.push(e);
  });

  function conflict(a, b) {
    const ratio = Math.min(a.c, b.c) / Math.max(a.c, b.c);
    if (ratio < 0.6) return false;
    const minLen = Math.min(a.len, b.len);
    for (let i = 0; i < a.pos.length; i++) {
      const pa = a.pos[i];
      for (let j = 0; j < b.pos.length; j++) {
        const pb = b.pos[j];
        const ov = Math.min(pa + a.len, pb + b.len) - Math.max(pa, pb);
        if (ov >= minLen * 0.5) return true;
      }
    }
    return false;
  }
  cands.sort((a, b) => b.score - a.score);
  const kept = [];
  cands.forEach((cd) => {
    for (let i = 0; i < kept.length; i++) if (conflict(cd, kept[i])) return;
    kept.push(cd);
  });

  const out = kept.map((k) => ({ w: k.w, c: k.c }));

  if (!out.length && total > 0 && total < 80) {
    const big = new Map();
    runs.forEach((run) => {
      if (/^[a-z]/.test(run)) return;
      for (let i = 0; i + 2 <= run.length; i++) {
        const g = run.substr(i, 2);
        if (STOP_SET.has(g)) continue;
        if (EDGE_BAD.has(g.charAt(0)) || EDGE_BAD.has(g.charAt(1))) continue;
        big.set(g, (big.get(g) || 0) + 1);
      }
    });
    big.forEach((c, w) => out.push({ w, c }));
  }

  en.forEach((c, w) => out.push({ w, c }));
  return out;
}

/* ---------------- 配色 ---------------- */
const PALETTES = {
  neon:  ['#6ee7ff','#a78bfa','#f472b6','#4ade80','#facc15','#fb923c','#38bdf8','#e879f9'],
  warm:  ['#fb923c','#f43f5e','#f59e0b','#ef4444','#eab308','#fbbf24','#f97316','#dc2626'],
  cool:  ['#38bdf8','#22d3ee','#818cf8','#2dd4bf','#60a5fa','#a78bfa','#0ea5e9','#14b8a6'],
  mono:  ['#e6e8f0','#b9bed6','#9499b8','#d5d8e6','#8a90ad','#c7cadb','#a6abc6','#dde0ee'],
  random:['#ff6b6b','#ffd93d','#6bcB77','#4d96ff','#c77dff','#ff9f43','#00d2d3','#f368e0']
};
function pickColor(i) {
  const p = PALETTES[selPal.value] || PALETTES.neon;
  if (selPal.value === 'random') return p[Math.floor(Math.random() * p.length)];
  return p[i % p.length];
}

/* ---------------- 词云布局：网格占用 + 椭圆螺旋 ---------------- */
function render() {
  const rect = box.getBoundingClientRect();
  const W = Math.max(240, Math.floor(rect.width));
  const H = Math.max(240, Math.floor(rect.height));
  const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
  canvas.width = Math.floor(W * dpr);
  canvas.height = Math.floor(H * dpr);
  canvas.style.width = W + 'px';
  canvas.style.height = H + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';

  hitList = [];
  if (!items.length) { empty.classList.remove('hide'); sShow.textContent = '0'; return; }
  empty.classList.add('hide');

  const limit = parseInt(rng.value, 10) || 80;
  const list = items.slice(0, limit);
  const maxC = list[0].c || 1;
  const maxFont = Math.max(28, Math.min(72, W * 0.105));
  const minFont = Math.max(11, Math.min(19, W * 0.021));

  const g = 6, pad = g * 0.5;
  const cols = Math.ceil(W / g) + 2, rows = Math.ceil(H / g) + 2;
  const grid = new Uint8Array(cols * rows);
  const gx0 = Math.floor(cols / 2), gy0 = Math.floor(rows / 2);

  function region(x, y, w, h) {
    let c0 = Math.floor((x - pad) / g), c1 = Math.floor((x + w + pad) / g);
    let r0 = Math.floor((y - pad) / g), r1 = Math.floor((y + h + pad) / g);
    if (c0 < 0) c0 = 0; if (r0 < 0) r0 = 0;
    if (c1 > cols - 1) c1 = cols - 1; if (r1 > rows - 1) r1 = rows - 1;
    return [c0, c1, r0, r1];
  }
  function isFree(x, y, w, h) {
    if (x < 1 || y < 1 || x + w > W - 1 || y + h > H - 1) return false;
    const gx = Math.floor(x / g), gy = Math.floor(y / g);
    if (grid[gy * cols + gx]) return false;
    const rg = region(x, y, w, h);
    for (let r = rg[2]; r <= rg[3]; r++) {
      const base = r * cols;
      for (let c = rg[0]; c <= rg[1]; c++) if (grid[base + c]) return false;
    }
    return true;
  }
  function occupy(x, y, w, h) {
    const rg = region(x, y, w, h);
    for (let r = rg[2]; r <= rg[3]; r++) {
      const base = r * cols;
      for (let c = rg[0]; c <= rg[1]; c++) grid[base + c] = 1;
    }
  }

  const path = [];
  (function buildPath() {
    const pathSteps = 12000, turns = 45;
    const angMax = Math.PI * 2 * turns, dAng = angMax / pathSteps;
    const rx = W * 0.58, ry = H * 0.58;
    for (let t = 0; t <= pathSteps; t++) {
      const ang = t * dAng;
      const rr = ang / angMax;
      const px = W / 2 + rr * rx * Math.cos(ang);
      const py = H / 2 + rr * ry * Math.sin(ang);
      let gx = Math.floor(px / g), gy = Math.floor(py / g);
      if (gx < 0) gx = 0; if (gy < 0) gy = 0;
      if (gx > cols - 1) gx = cols - 1; if (gy > rows - 1) gy = rows - 1;
      path.push(gx * g, gy * g);
    }
  })();

  function findSpot(w, h) {
    for (let i = 0; i < path.length; i += 2) {
      if (isFree(path[i], path[i + 1], w, h)) return { x: path[i], y: path[i + 1], w, h };
    }
    return null;
  }

  list.forEach((it, idx) => {
    const ratio = Math.log(1 + it.c) / Math.log(1 + maxC);
    let fs = minFont + (maxFont - minFont) * Math.pow(ratio, 0.62);
    let spot = null;
    for (let k = 0; k < 6 && !spot; k++) {
      ctx.font = '700 ' + fs.toFixed(1) + 'px ' + FONT;
      const tw = ctx.measureText(it.w).width;
      const th = fs * 1.06;
      spot = findSpot(tw, th);
      if (!spot) fs *= 0.86;
    }
    if (!spot) return;
    occupy(spot.x, spot.y, spot.w, spot.h);
    ctx.fillStyle = pickColor(idx);
    ctx.fillText(it.w, spot.x, spot.y);
    hitList.push({ x: spot.x, y: spot.y, w: spot.w, h: spot.h, w2: it.w, c: it.c });
  });

  sShow.textContent = String(hitList.length);
}

/* ---------------- 更新流程 ---------------- */
function update() {
  const text = input.value || '';
  sChars.textContent = String(text.length);
  if (!text.trim()) {
    items = []; sWords.textContent = '0'; sTime.textContent = '—';
    render(); return;
  }
  const now = () => (window.performance && performance.now) ? performance.now() : Date.now();
  const t0 = now();
  items = extractWords(text);
  items.sort((a, b) => b.c - a.c);
  const t1 = now();
  sWords.textContent = String(items.length);
  render();
  const t2 = now();
  sTime.textContent = '分词 ' + (t1 - t0).toFixed(0) + ' ms · 渲染 ' + (t2 - t1).toFixed(0) + ' ms';
}
function schedule() { clearTimeout(timer); timer = setTimeout(update, 250); }

/* ---------------- 协作 ---------------- */
const ROOM_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
function newRoomId() {
  let s = '';
  const a = new Uint8Array(6);
  crypto.getRandomValues(a);
  for (let i = 0; i < 6; i++) s += ROOM_ALPHABET[a[i] % ROOM_ALPHABET.length];
  return s;
}
function roomFromHash() {
  const h = location.hash.replace(/^#/, '');
  const m = h.match(/(?:^|&)r=([a-z0-9]{3,16})/i);
  return m ? m[1].toLowerCase() : null;
}
function randomName() {
  const pool = ['路人', '访客', '小可', '阿橘', '青柠', '布丁', '北极熊', '咕咕', '汤圆', '奶糖'];
  return pool[Math.floor(Math.random() * pool.length)] + Math.floor(10 + Math.random() * 90);
}
function showToast(msg) {
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 1800);
}
function setStatus(kind, text) {
  collabStatus.innerHTML = '<i class="dot ' + kind + '"></i>' + text;
}

function enterRoom(roomId) {
  collabPanel.hidden = false;
  sharedTag.hidden = false;
  btnCollab.textContent = '协作中';
  btnCollab.classList.add('active');
  roomLabel.textContent = roomId;
  input.value = '';
  input.placeholder = '这是共享文档：输入内容会实时同步给房间里的所有人，词云随之更新…';

  const saved = localStorage.getItem('wc-name');
  myName.value = saved || randomName();
  localStorage.setItem('wc-name', myName.value);

  collab = new Collab({
    roomId,
    name: myName.value,
    onText: (text, origin, sel) => {
      if (input.value !== text) {
        input.value = text;
        if (sel) {
          const n = text.length;
          input.setSelectionRange(Math.min(sel.start, n), Math.min(sel.end, n));
        }
      }
      schedule();
    },
    onStatus: (status, detail) => {
      if (status === 'online') setStatus('ok', '已连接 · 实时同步中');
      else if (status === 'connecting') setStatus('warn', '连接中…');
      else if (status === 'offline') setStatus('bad', '连接中断，正在重连…');
      else if (status === 'error') setStatus('bad', '连接异常');
    },
    onPeers: (peers) => {
      const online = peers.filter((p) => p.online);
      peerList.innerHTML = '';
      const me = document.createElement('span');
      me.className = 'peer me';
      me.textContent = myName.value + '（我）';
      peerList.appendChild(me);
      online.forEach((p) => {
        const s = document.createElement('span');
        s.className = 'peer';
        s.textContent = p.name;
        peerList.appendChild(s);
      });
      const cnt = document.createElement('span');
      cnt.className = 'peer count';
      cnt.textContent = online.length + ' 人在线';
      peerList.appendChild(cnt);
    },
    getSelection: () => ({ start: input.selectionStart || 0, end: input.selectionEnd || 0 })
  });
  collab.start();
}

function leaveRoom() {
  location.hash = '';
  location.reload();
}

/* ---------------- 交互 ---------------- */
input.addEventListener('input', () => {
  if (collab) { if (!composing) collab.setLocalText(input.value); }
  else schedule();
});
input.addEventListener('compositionstart', () => { composing = true; });
input.addEventListener('compositionend', () => {
  composing = false;
  if (collab) collab.setLocalText(input.value);
  else schedule();
});

btnGen.addEventListener('click', () => { clearTimeout(timer); update(); });
btnSmp.addEventListener('click', () => {
  if (collab) {
    const cur = input.value;
    collab.setLocalText(cur ? cur + '\n' + SAMPLE : SAMPLE);
  } else {
    input.value = SAMPLE;
  }
  clearTimeout(timer); update();
  input.blur();
});
btnClr.addEventListener('click', () => {
  if (collab) collab.setLocalText('');
  else input.value = '';
  clearTimeout(timer); update();
  input.focus();
});
selPal.addEventListener('change', render);
rng.addEventListener('input', () => { rngVal.textContent = rng.value; render(); });

btnCollab.addEventListener('click', () => {
  if (collab) return;
  const room = newRoomId();
  history.replaceState(null, '', '#r=' + room);
  enterRoom(room);
  showToast('房间已创建，复制链接邀请伙伴');
});
btnCopy.addEventListener('click', () => {
  const link = location.origin + location.pathname + '#r=' + (collab ? collab.roomId : '');
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(link).then(() => showToast('邀请链接已复制')).catch(() => prompt('复制此链接：', link));
  } else {
    prompt('复制此链接：', link);
  }
});
btnLeave.addEventListener('click', leaveRoom);
myName.addEventListener('change', () => {
  const v = (myName.value || '').trim().slice(0, 12) || randomName();
  myName.value = v;
  localStorage.setItem('wc-name', v);
  if (collab) collab.setName(v);
});

canvas.addEventListener('mousemove', (e) => {
  const r = canvas.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  let found = null;
  for (const h of hitList) {
    if (x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h) { found = h; break; }
  }
  if (found) {
    tip.textContent = found.w2 + ' · ' + found.c + ' 次';
    tip.style.left = (found.x + found.w / 2) + 'px';
    tip.style.top = found.y + 'px';
    tip.classList.add('show');
    canvas.style.cursor = 'pointer';
  } else {
    tip.classList.remove('show');
    canvas.style.cursor = 'default';
  }
});
canvas.addEventListener('mouseleave', () => tip.classList.remove('show'));
canvas.addEventListener('click', () => {
  if (!tip.classList.contains('show')) return;
  const txt = tip.textContent.split(' · ')[0];
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(txt).then(() => {
      const old = tip.textContent;
      tip.textContent = '已复制：' + txt;
      setTimeout(() => { tip.textContent = old; }, 1200);
    }).catch(() => {});
  }
});

let rt;
window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(render, 140); });

/* ---------------- 启动 ---------------- */
const room = roomFromHash();
if (room) {
  enterRoom(room);
  setStatus('warn', '连接中…');
} else {
  input.value = SAMPLE;
  update();
}
