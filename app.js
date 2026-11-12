/**
 * app.js —— 实时词云主程序
 *
 * 单人模式：输入即分词、渲染词云。
 * 协作模式：房间内每人一个独立输入槽位，输入互不干扰、原文互不可见；
 *           词云基于「所有槽位汇总后的词频」实时生成，并可导出高频词。
 */
import { Collab } from './collab.js?v=20261112c';

/* ---------------- DOM ---------------- */
/** 构建版本号：改动前端后要同步更新（用于缓存刷新 + 页面底部显示） */
const BUILD = '20261112c';
const buildVer = document.getElementById('buildVer');
if (buildVer) buildVer.textContent = BUILD;

const input   = document.getElementById('input');
const canvas  = document.getElementById('cloud');
const box     = document.getElementById('cloudBox');
const empty   = document.getElementById('empty');
const tip     = document.getElementById('tip');
const selPal  = document.getElementById('palette');
const rng     = document.getElementById('limit');
const rngVal  = document.getElementById('limitVal');
const btnGen  = document.getElementById('btnGen');
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
const btnDissolve = document.getElementById('btnDissolve');
const myName = document.getElementById('myName');
const peerList = document.getElementById('peerList');
const sharedTag = document.getElementById('sharedTag');
const toast = document.getElementById('toast');
const inputLabel = document.getElementById('inputLabel');
const inputHint = document.getElementById('inputHint');
const rosterEl = document.getElementById('roster');
const rosterCount = document.getElementById('rosterCount');
const tableBody = document.getElementById('wordTableBody');
const tableCount = document.getElementById('tableCount');
const btnCopyTable = document.getElementById('btnCopyTable');
const btnExportCsv = document.getElementById('btnExportCsv');
const btnExportXls = document.getElementById('btnExportXls');
const btnSubmit = document.getElementById('btnSubmit');
const submitStatus = document.getElementById('submitStatus');
const submitHint = document.getElementById('submitHint');

const ctx = canvas.getContext('2d');
const FONT = '"PingFang SC","Microsoft YaHei","Hiragino Sans GB",system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif';

// 词表较大（~400KB），异步加载，不阻塞首屏；加载完成后若有文本则重新分词
let DICT = new Set();
import('./dict.js?v=20261112c').then((m) => {
  DICT = new Set(String(m.WORDLIST || '').split(/\s+/).filter(Boolean));
  if (input.value && input.value.trim()) update();
}).catch(() => { /* 词表缺失时退化为纯统计分词 */ });

let items = [], hitList = [], timer = null;
let collab = null, composing = false;
let myClientId = '';
let aggItems = [];        // 汇总词条：{w, c, total, people, names}
let aggPeople = [];       // 每人重点词
let onlineIds = new Set();
let submittedText = '';   // 最后一次提交时的文本（用于判断「有修改待提交」）
let submittedAt = 0;      // 最后一次提交的时间戳
let draftKey = 'wc-draft-solo';
let draftTimer = null;

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
        if (!e) {
          e = { w: s, c: 0, len, left: new Set(), right: new Set(), edgeL: false, edgeR: false, pos: [] };
          table.set(s, e);
        }
        e.c++;
        if (i > 0) e.left.add(run.charAt(i - 1)); else e.edgeL = true;      // 句首也是一种独立语境
        if (i + len < run.length) e.right.add(run.charAt(i + len)); else e.edgeR = true;
        if (e.pos.length < 80) e.pos.push(offset + i);
      }
    }
    offset += run.length;
  });
  if (!total && !en.size) return [];

  const thr = total < 400 ? 1.9 : 2.1;

  // ---- 第一步：打分（内聚度 PMI × 上下文自由度 × 长度 × 词典优先）----
  const all = [];
  table.forEach((e) => {
    if (STOP_SET.has(e.w)) return;
    if (NUM_ONLY.test(e.w)) return;
    if (EDGE_BAD.has(e.w.charAt(0)) || EDGE_BAD.has(e.w.charAt(e.len - 1))) return;
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
    const leftN = e.left.size + (e.edgeL ? 1 : 0);
    const rightN = e.right.size + (e.edgeR ? 1 : 0);
    e.freedom = leftN * rightN;                 // 左右语境种类数，越大越像独立词
    e.pmi = minPmi;
    e.isDict = DICT.has(e.w);
    e.score = e.c
      * (1 + Math.min(minPmi, 6) / 2)
      * (1 + 0.5 * Math.log(1 + e.freedom))
      * (1 + 0.06 * (e.len - 2))                // 长度只作微弱加分，避免长碎片喧宾夺主
      * (e.isDict ? 1.5 : 1);                   // 词典词优先于统计碎片
    all.push(e);
  });

  // ---- 第二步：收录规则 ----
  const cands = [];
  all.forEach((e) => {
    const len = e.len;
    let ok;
    if (e.isDict) {
      ok = e.c >= 1 && e.pmi >= 0.8;                        // 词典词直接收录
    } else if (e.c >= 2) {
      if (len === 2) ok = e.pmi >= thr;                      // 双字词：内聚度足够即可
      else if (len <= 4) ok = e.pmi >= thr && e.freedom >= 2;// 三四字词：还需左右语境多样
      else ok = e.c >= 2 && e.pmi >= 2.2 && e.freedom >= 2;  // 五字以上：需语境多样，否则视为短语
    } else {
      ok = len >= 3 && len <= 4 && e.freedom >= 4 && e.pmi >= 2.5;  // 只出现一次：语境必须足够独立
    }
    if (ok) cands.push(e);
  });

  // ---- 第三步：剔除「总是依附于更长词」的碎片（如 工智 / 大模 / 改变世 / 然语）----
  // 次数相同 → 短的那个从未独立出现过，是长词的碎片。
  // 但「词典词豁免」要留一道口子：长串自己不够格时（如「天然语言」凑不齐）
  // 不能反过来把好词「语言」误伤掉；而长串够格时（「知识图谱」）
  // 则应保留更完整的长词，而不是拆成「知识」「图谱」。
  const allWord = new Map(all.map((e) => [e.w, e]));
  const candWord = new Set(cands.map((e) => e.w));
  const shielded = new Set();
  all.forEach((B) => {
    if (B.len < 3) return;
    for (let l = 2; l < B.len; l++) {
      for (const sub of [B.w.slice(0, l), B.w.slice(B.len - l)]) {
        const A = allWord.get(sub);
        if (!A || A === B || A.c !== B.c) continue;   // 次数不同 → A 还有独立出现，不能当碎片
        if (!candWord.has(B.w) && A.isDict) continue;  // 长串不够格，别误伤词典词
        shielded.add(A.w);
      }
    }
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
    if (shielded.has(cd.w)) return;
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
/* 浅紫底上的词云颜色：需要足够深，保证在浅色背景上清晰可读 */
const PALETTES = {
  neon:  ['#7c3aed','#db2777','#0e7490','#ea580c','#a16207','#16a34a','#2563eb','#9333ea'],
  warm:  ['#ea580c','#e11d48','#b45309','#dc2626','#a16207','#d97706','#c2410c','#be123c'],
  cool:  ['#0369a1','#0e7490','#4338ca','#0f766e','#1d4ed8','#7c3aed','#0284c7','#115e59'],
  mono:  ['#3f3d5c','#55537a','#6b6895','#4a4869','#7d7aa6','#5f5d86','#8a88b0','#38365a'],
  random:['#e11d48','#a16207','#16a34a','#2563eb','#9333ea','#ea580c','#0e7490','#c026d3']
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

/* ---------------- 汇总：分人分词 → 词频相加 ---------------- */
const segCache = new Map();     // id → {text, words}

function segFor(id, text) {
  const hit = segCache.get(id);
  if (hit && hit.text === text) return hit.words;
  const words = (text && text.trim()) ? extractWords(text) : [];
  segCache.set(id, { text, words });
  return words;
}

/**
 * 把每个人的槽位汇总成一张词表。
 * 权重 = 所有人该词出现次数之和（经典词云口径）。
 * 同时记录「几个人提到过」和「谁提到过」，供高频词榜与导出使用。
 */
function aggregate(parts, names, subs) {
  const total = new Map();
  const who = new Map();
  const per = [];

  for (const p of parts) {
    const words = segFor(p.id, p.text);
    const own = new Map();
    for (const it of words) {
      total.set(it.w, (total.get(it.w) || 0) + it.c);
      if (!who.has(it.w)) who.set(it.w, new Set());
      who.get(it.w).add(p.id);
      own.set(it.w, (own.get(it.w) || 0) + it.c);
    }
    const top = Array.from(own.entries())
      .map(([w, c]) => ({ w, c }))
      .sort((a, b) => b.c - a.c || a.w.localeCompare(b.w, 'zh'));
    per.push({
      id: p.id,
      name: names[p.id] || '匿名',
      chars: (p.text || '').length,
      count: top.reduce((a, b) => a + b.c, 0),
      distinct: top.length,
      submitted: !!(subs && subs[p.id]),
      top: top.slice(0, 8),
      full: top
    });
  }

  const items = Array.from(total.entries()).map(([w, c]) => {
    const ids = who.get(w) || new Set();
    return {
      w,
      c,                                     // 权重 = 总次数
      total: c,
      people: ids.size,
      names: Array.from(ids).map((id) => names[id] || '匿名')
    };
  });
  items.sort((a, b) => b.c - a.c || a.w.localeCompare(b.w, 'zh'));
  return { items, per };
}

/* ---------------- 更新流程 ---------------- */
function nowMs() { return (window.performance && performance.now) ? performance.now() : Date.now(); }

function update() {
  if (collab) updateRoom();
  else updateSingle();
}

function updateSingle() {
  const text = input.value || '';
  sChars.textContent = String(text.length);
  if (!text.trim()) {
    items = []; aggItems = [];
    sWords.textContent = '0'; sTime.textContent = '—';
    render(); renderTable(); return;
  }
  const t0 = nowMs();
  const list = extractWords(text);
  list.sort((a, b) => b.c - a.c);
  const t1 = nowMs();
  items = list;
  aggItems = list.map((it) => ({ w: it.w, c: it.c, total: it.c, people: 1, names: ['我'] }));
  sWords.textContent = String(items.length);
  render();
  const t2 = nowMs();
  sTime.textContent = '分词 ' + (t1 - t0).toFixed(0) + ' ms · 渲染 ' + (t2 - t1).toFixed(0) + ' ms';
  renderTable();
}

function updateRoom() {
  const parts = collab.getParts();
  const names = collab.getNames();
  const subs = collab.getSubs();
  const t0 = nowMs();
  const { items: agg, per } = aggregate(parts, names, subs);
  const t1 = nowMs();
  items = agg;
  aggItems = agg;
  aggPeople = per;
  const chars = parts.reduce((a, p) => a + (p.text || '').length, 0);
  sChars.textContent = String(chars);
  sWords.textContent = String(agg.length);
  render();
  const t2 = nowMs();
  sTime.textContent = parts.length + ' 人贡献 · 分词 ' + (t1 - t0).toFixed(0) + ' ms · 渲染 ' + (t2 - t1).toFixed(0) + ' ms';
  renderTable();
  renderRoster();
}

function schedule() { clearTimeout(timer); timer = setTimeout(update, 250); }

/* ---------------- 提交 / 本地草稿 ----------------
 * 提交 = 一次明确的定稿动作：
 *   协作模式 → 把我的输入固化成房间快照（retained 全量状态），
 *              别人和后加入的人一定看得到；同时在贡献者名单上标记「已提交」
 *   单人模式 → 写入本机存储，刷新或关掉页面再回来会自动恢复
 * 提交之后文本依然可以继续编辑，改完再提交一次即可更新快照。
 * 另外后台始终在静默保存一份本机草稿，退出房间时也会自动提交一次，
 * 所以内容不会因为忘记点提交而丢失。
 */
function saveDraft(text) {
  try { localStorage.setItem(draftKey, JSON.stringify({ text: text, ts: Date.now() })); } catch (e) { /* ignore */ }
}
function loadDraft() {
  try {
    const raw = localStorage.getItem(draftKey);
    if (!raw) return null;
    const o = JSON.parse(raw);
    return (o && typeof o.text === 'string') ? o : null;
  } catch (e) { return null; }
}
function clearDraft() { try { localStorage.removeItem(draftKey); } catch (e) { /* ignore */ } }
function scheduleDraftSave() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => saveDraft(input.value || ''), 400);
}

function submitNow(silent) {
  const text = input.value || '';
  saveDraft(text);
  submittedText = text;
  submittedAt = Date.now();
  if (collab) collab.submit();
  renderSubmitStatus();
  if (!silent) showToast(collab ? '已提交到房间，之后仍可继续编辑' : '已保存到本机，之后仍可继续编辑');
}

function renderSubmitStatus() {
  if (!btnSubmit) return;
  const text = input.value || '';
  const dirty = text !== submittedText;
  btnSubmit.textContent = collab ? '提交到房间' : '保存到本机';
  if (submittedText !== '' && !dirty) {
    const d = new Date(submittedAt);
    const p = (n) => String(n).padStart(2, '0');
    submitStatus.textContent = (collab ? '已提交' : '已保存') + ' · ' + p(d.getHours()) + ':' + p(d.getMinutes());
    submitStatus.className = 'submit-status ok';
  } else if (submittedText !== '' && dirty) {
    submitStatus.textContent = collab ? '有修改待提交' : '有修改未保存';
    submitStatus.className = 'submit-status warn';
  } else {
    submitStatus.textContent = collab ? '未提交' : '未保存';
    submitStatus.className = 'submit-status';
  }
  submitHint.textContent = collab
    ? '提交会把你的输入固化成房间快照，别人和后加入的人一定看得到；提交后仍可继续编辑，改完再提交一次即可。内容同时在后台自动存一份草稿，退出房间时也会自动提交一次。'
    : '保存后仍可继续编辑。内容同时在后台自动存一份草稿，关掉页面再回来会自动恢复。';
}

/* ---------------- 贡献者名单 ---------------- */
function renderRoster() {
  rosterEl.innerHTML = '';
  rosterCount.textContent = String(aggPeople.length);
  if (!aggPeople.length) {
    const d = document.createElement('div');
    d.className = 'roster-empty';
    d.textContent = '还没有人提交内容，把邀请链接发给同伴吧';
    rosterEl.appendChild(d);
    return;
  }
  const list = aggPeople.slice().sort((a, b) => {
    const oa = onlineIds.has(a.id) ? 1 : 0, ob = onlineIds.has(b.id) ? 1 : 0;
    return ob - oa || b.count - a.count;
  });
  list.forEach((p) => {
    const card = document.createElement('div');
    card.className = 'rcard';

    const top = document.createElement('div');
    top.className = 'rc-top';
    const dot = document.createElement('i');
    dot.className = 'dot ' + (onlineIds.has(p.id) ? 'ok' : 'off');
    const nm = document.createElement('span');
    nm.className = 'rc-name' + (p.id === myClientId ? ' rc-me' : '');
    nm.textContent = p.name + (p.id === myClientId ? '（我）' : '');
    top.appendChild(dot);
    top.appendChild(nm);
    if (p.submitted) {
      const badge = document.createElement('span');
      badge.className = 'rc-sub';
      badge.textContent = '已提交';
      top.appendChild(badge);
    }

    const meta = document.createElement('div');
    meta.className = 'rc-meta';
    meta.textContent = p.count + ' 次提及 · ' + p.distinct + ' 个词' + (p.chars ? ' · ' + p.chars + ' 字' : '');

    card.appendChild(top);
    card.appendChild(meta);

    if (p.top.length) {
      const wrap = document.createElement('div');
      wrap.className = 'rc-words';
      p.top.forEach((t) => {
        const c = document.createElement('span');
        c.className = 'wchip';
        c.textContent = t.w + ' ×' + t.c;
        wrap.appendChild(c);
      });
      card.appendChild(wrap);
    }
    rosterEl.appendChild(card);
  });
}

/* ---------------- 高频词汇榜 ---------------- */
function renderTable() {
  tableBody.innerHTML = '';
  const top = aggItems.slice(0, 100);
  tableCount.textContent = aggItems.length ? top.length + ' / ' + aggItems.length + ' 个词' : '';
  top.forEach((it, i) => {
    const tr = document.createElement('tr');
    const c1 = document.createElement('td'); c1.className = 'n'; c1.textContent = String(i + 1);
    const c2 = document.createElement('td'); c2.className = 'w'; c2.textContent = it.w;
    const c3 = document.createElement('td'); c3.textContent = String(it.total);
    const c4 = document.createElement('td'); c4.textContent = String(it.people);
    const c5 = document.createElement('td'); c5.className = 'who'; c5.textContent = it.names.join('、');
    tr.append(c1, c2, c3, c4, c5);
    tableBody.appendChild(tr);
  });
}

/* ---------------- 导出 ---------------- */
function csvCell(v) {
  const s = String(v == null ? '' : v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function xmlEsc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
}
function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes());
}
function fileBase() {
  return collab ? ('词云词表-房间' + collab.roomId + '-' + stamp()) : ('词云词表-' + stamp());
}
function download(filename, content, mime) {
  try {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 500);
    return true;
  } catch (e) { return false; }
}
function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text).then(() => true).catch(() => fallbackCopy(text));
  }
  return Promise.resolve(fallbackCopy(text));
}
function fallbackCopy(text) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch (e) { return false; }
}

function exportCsv() {
  if (!aggItems.length) { showToast('还没有可导出的词'); return; }
  const rows = [['词语']].concat(aggItems.map((it) => [it.w]));
  const csv = '\uFEFF' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
  if (download(fileBase() + '.csv', csv, 'text/csv;charset=utf-8')) showToast('已导出 CSV（' + aggItems.length + ' 个词）');
}

/** SpreadsheetML 2003：单文件 .xls，Excel / WPS 直接打开，无需压缩库 */
function exportXls() {
  if (!aggItems.length) { showToast('还没有可导出的词'); return; }
  const body = [['词语']].concat(aggItems.map((it) => [it.w])).map((r, ri) => '<Row>' + r.map((c) =>
    '<Cell' + (ri === 0 ? ' ss:StyleID="hdr"' : '') + '><Data ss:Type="String">' + xmlEsc(c) + '</Data></Cell>'
  ).join('') + '</Row>').join('');
  const xml = '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">' +
    '<Styles><Style ss:ID="hdr"><Font ss:Bold="1"/><Interior ss:Color="#EEF1FF" ss:Pattern="Solid"/></Style></Styles>' +
    '<Worksheet ss:Name="词表"><Table>' + body + '</Table></Worksheet>' +
    '</Workbook>';
  if (download(fileBase() + '.xls', xml, 'application/vnd.ms-excel;charset=utf-8')) showToast('已导出 Excel');
}

function copyTable() {
  if (!aggItems.length) { showToast('还没有可复制的词'); return; }
  // 与 CSV / Excel 口径一致：首行是表头「词语」，其后每行一个词
  const text = ['词语'].concat(aggItems.map((it) => it.w)).join('\n');
  copyText(text).then((ok) => showToast(ok ? ('已复制 ' + aggItems.length + ' 个词') : '复制失败，请手动复制词表'));
}

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
  // 严格匹配：房间号由 32 字符表生成，只含小写字母与数字。
  // 不加边界的话，'#r=live-a1' 会被截成 'live'，静默进错房间。
  const m = h.match(/(?:^|&)r=([a-z0-9]{3,16})(?:&|$)/i);
  return m ? m[1].toLowerCase() : null;
}
function randomName() {
  const pool = ['路人', '访客', '小可', '阿橘', '青柠', '布丁', '北极熊', '咕咕', '汤圆', '奶糖'];
  return pool[Math.floor(Math.random() * pool.length)] + Math.floor(10 + Math.random() * 90);
}
/** 我的稳定标识：刷新后不变，才能认领回自己的输入槽位 */
function clientId() {
  let id = localStorage.getItem('wc-cid');
  if (!id) {
    id = 'u' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
    localStorage.setItem('wc-cid', id);
  }
  return id;
}
function showToast(msg) {
  toast.textContent = msg;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 1800);
}
function setStatus(kind, text) {
  collabStatus.innerHTML = '<i class="dot ' + kind + '"></i>' + text;
}

function enterRoom(roomId, viaLink) {
  collabPanel.hidden = false;
  sharedTag.hidden = false;
  btnCollab.textContent = '协作中';
  btnCollab.classList.add('active');
  roomLabel.textContent = roomId;
  inputLabel.textContent = '我的重点词';
  inputHint.textContent = '只有你能编辑这里；房间里其他人看到的是汇总后的词云';
  input.value = '';
  input.placeholder = '写下你的重点词…（原文只有你自己可见，别人只会看到汇总词云）';

  draftKey = 'wc-draft-' + roomId;
  submittedText = '';
  submittedAt = 0;
  let draftChecked = false;

  const saved = localStorage.getItem('wc-name');
  myName.value = saved || randomName();
  localStorage.setItem('wc-name', myName.value);
  myClientId = clientId();

  collab = new Collab({
    roomId,
    name: myName.value,
    ownId: myClientId,
    onState: (st) => {
      if (!collab) return;            // 房间已解散 → 忽略后续状态
      const mine = st.parts.find((p) => p.id === st.ownId);
      const myText = mine ? mine.text : '';
      // 认领到自己的槽位后，若房间里的内容是空的而本机有草稿 → 用草稿补回
      if (!draftChecked && mine && myText === '') {
        draftChecked = true;
        const d = loadDraft();
        if (d && d.text) {
          collab.setLocalText(d.text);
          submittedText = d.text;
          submittedAt = d.ts || Date.now();
          renderSubmitStatus();
          schedule();
          return;
        }
      }
      if (input.value !== myText) input.value = myText;
      // 房间里的「已提交」标记是权威的：重进房间时把上次的提交状态恢复回来
      if (st.subs && st.subs[myClientId] && submittedAt !== st.subs[myClientId]) {
        submittedAt = st.subs[myClientId];
        submittedText = myText;
        renderSubmitStatus();
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
      onlineIds = new Set(peers.filter((p) => p.online).map((p) => p.id));
      peerList.innerHTML = '';
      const me = document.createElement('span');
      me.className = 'peer me';
      me.textContent = myName.value + '（我）';
      peerList.appendChild(me);
      peers.filter((p) => p.online && p.id !== myClientId).forEach((p) => {
        const s = document.createElement('span');
        s.className = 'peer';
        s.textContent = p.name;
        peerList.appendChild(s);
      });
      const cnt = document.createElement('span');
      cnt.className = 'peer count';
      cnt.textContent = onlineIds.size + ' 人在线';
      peerList.appendChild(cnt);
      renderRoster();
    },
    onClosed: (info) => {
      // 房间被解散（有人点了「解散房间」，或最后一人退出后自动清理）
      const reason = (info && info.reason) || '';
      let msg;
      if (reason === 'manual') msg = '房间已解散，服务器上的内容已清空';
      else if (reason === 'auto-empty') msg = '房间已空，服务器上的副本已自动清理';
      else msg = '房间已被 ' + ((info && info.by) ? info.by : '有人') + ' 解散，内容已清空';
      exitToSolo(msg);
    }
  });
  collab.start();
  update();
  renderSubmitStatus();
  if (viaLink) showToast('已进入房间 ' + roomId + '，写下你的重点词吧');
}

/** 解散前把房间里的内容备份到本机，避免解散后什么都看不到 */
function backupRoom(roomId) {
  try {
    if (!collab) return;
    const names = collab.getNames();
    const parts = collab.getParts().map((p) => ({
      id: p.id, name: names[p.id] || '匿名', text: p.text || ''
    }));
    localStorage.setItem('wc-backup-' + roomId, JSON.stringify({ ts: Date.now(), parts: parts }));
  } catch (e) { /* ignore */ }
}

/** 把当前输入存进单人模式的草稿（切回单人 / 退出房间时调用，文字不会丢） */
function saveSoloDraft(text) {
  try {
    const t = (text === undefined) ? (input.value || '') : (text || '');
    localStorage.setItem('wc-draft-solo', JSON.stringify({ text: t, ts: Date.now() }));
  } catch (e) { /* ignore */ }
}

/** 切回单人模式（房间解散 / 退出房间后） */
function exitToSolo(msg) {
  // 先把内容记下来：销毁协作对象时 Y.Doc 会把槽位清空，输入框可能跟着变空
  const keep = input.value || '';
  const c = collab;
  collab = null;
  if (c) { try { c.destroy(); } catch (e) { /* ignore */ } }
  collabPanel.hidden = true;
  sharedTag.hidden = true;
  btnCollab.textContent = '开启协作';
  btnCollab.classList.remove('active');
  inputLabel.textContent = '我的文本';
  inputHint.textContent = '输入即实时生成词云';
  input.placeholder = '在这里粘贴或输入文字，词云会实时生成…';
  // 房间没了，地址里的房间号也要去掉（否则刷新会误进一个已解散的空房间）
  try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* ignore */ }
  onlineIds = new Set();
  draftKey = 'wc-draft-solo';
  input.value = keep;      // 内容保住
  saveSoloDraft(keep);     // 草稿 key 换了（房间草稿 → 单人草稿），内容不能丢
  submittedText = keep;
  submittedAt = Date.now();
  renderSubmitStatus();
  update();
  if (msg) showToast(msg);
}

async function leaveRoom() {
  // 退出前把内容定稿一次，避免最后一笔没落进快照
  const keep = input.value || '';
  if (collab && keep !== submittedText) {
    submitNow(true);
    showToast('退出前已自动提交');
  }
  if (collab) {
    setStatus('warn', '正在退出…');
    btnLeave.disabled = true;
    try {
      // 房间里没人应答 → 说明只剩我一个，顺手把服务器上的房间副本清掉
      const empty = await collab.leave();
      if (empty) showToast('已退出房间，服务器上的房间副本已清理');
    } catch (e) { /* ignore */ }
  }
  saveSoloDraft(keep);   // 退出后回到单人模式，文字仍然在
  location.hash = '';
  location.reload();
}

/* ---------------- 交互 ---------------- */
function onInputChange() {
  scheduleDraftSave();
  renderSubmitStatus();
  if (collab) {
    if (!composing) { collab.setLocalText(input.value); collab.markDirty(); }
  } else {
    schedule();
  }
}
input.addEventListener('input', onInputChange);
input.addEventListener('compositionstart', () => { composing = true; });
input.addEventListener('compositionend', () => {
  composing = false;
  onInputChange();
});

btnGen.addEventListener('click', () => { clearTimeout(timer); update(); });
btnSubmit.addEventListener('click', () => submitNow(false));
btnClr.addEventListener('click', () => {
  if (collab) collab.setLocalText('');
  else input.value = '';
  clearDraft();          // 主动清空 = 明确丢弃草稿
  submittedText = '';
  submittedAt = 0;
  clearTimeout(timer); update();
  renderSubmitStatus();
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
  copyText(link).then((ok) => showToast(ok ? '邀请链接已复制' : '复制失败：' + link));
});
btnLeave.addEventListener('click', leaveRoom);

/* 解散房间：页面内二次确认。
   不用原生 confirm() —— 它是阻塞式弹窗，在部分嵌入环境里会把页面卡死。 */
let dissolveArmed = false;
let dissolveTimer = null;
function disarmDissolve() {
  dissolveArmed = false;
  clearTimeout(dissolveTimer);
  btnDissolve.textContent = '解散房间';
  btnDissolve.classList.remove('armed');
}
btnDissolve.addEventListener('click', () => {
  if (!collab) return;
  if (!dissolveArmed) {
    dissolveArmed = true;
    btnDissolve.textContent = '再点一次确认解散';
    btnDissolve.classList.add('armed');
    clearTimeout(dissolveTimer);
    dissolveTimer = setTimeout(disarmDissolve, 8000);
    showToast('再点一次「解散房间」才会真的解散');
    return;
  }
  disarmDissolve();
  const room = collab.roomId;
  backupRoom(room);
  collab.dissolve('manual');   // 解散后的界面切换由 onClosed 统一处理
});
myName.addEventListener('change', () => {
  const v = (myName.value || '').trim().slice(0, 12) || randomName();
  myName.value = v;
  localStorage.setItem('wc-name', v);
  if (collab) collab.setName(v);
});

btnCopyTable.addEventListener('click', copyTable);
btnExportCsv.addEventListener('click', exportCsv);
btnExportXls.addEventListener('click', exportXls);

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
  copyText(txt).then((ok) => {
    if (!ok) return;
    const old = tip.textContent;
    tip.textContent = '已复制：' + txt;
    setTimeout(() => { tip.textContent = old; }, 1200);
  });
});

let rt;
window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(render, 140); });

/* ---------------- 启动 ---------------- */
const room = roomFromHash();
if (room) {
  // 通过邀请链接直接进房：读到房间号即进入，无需再点一次「开启协作」
  enterRoom(room, true);
  setStatus('warn', '连接中…');
} else {
  inputLabel.textContent = '我的文本';
  inputHint.textContent = '输入即实时生成词云';
  draftKey = 'wc-draft-solo';
  const d = loadDraft();
  if (d && d.text) {
    input.value = d.text;
    submittedText = d.text;
    submittedAt = d.ts || Date.now();
  } else {
    input.value = SAMPLE;
  }
  renderSubmitStatus();
  update();
}
