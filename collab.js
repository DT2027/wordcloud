/**
 * collab.js —— 多人协作层：每人独享输入槽位 + 汇总词云
 *
 * 协作模型（与「共享一份文档」不同）：
 *   房间里的每个人拥有一个独立槽位，输入互不干扰、互不可见；
 *   上层把所有人的槽位汇总成分词 → 词频 → 汇总词云。
 *
 * 数据模型（Yjs CRDT）：
 *   doc.getMap('parts')   贡献者 id → Y.Text   每人一个槽位，并发写互不冲突
 *   doc.getMap('people')  贡献者 id → 昵称     持久化，离线成员也保留名字
 *   doc.getMap('subs')    贡献者 id → 提交时间戳  标记「这份内容已定稿」
 *
 * 认领槽位：
 *   首次连上后先等一个同步窗口（等远端 retained 状态到达），
 *   再检查 parts 里是否已有「我」的槽位：
 *     有 → 直接接管（刷新后仍能看到自己上次写的内容）
 *     无 → 新建一个空槽位
 *   等待期间敲进去的字先暂存在 pending，认领完成后一次性写入。
 *
 * 主题约定：
 *   wc/<room>/doc       retained，完整文档状态（base64）—— 房间里唯一长期占内存的东西
 *   wc/<room>/live      增量更新（base64），非 retained
 *   wc/<room>/req       新成员加入时广播的状态请求，非 retained
 *   wc/<room>/p/<id>    retained，在线状态 {name, ts}
 *   wc/<room>/probe     离开时问一句「还有人在吗」，非 retained
 *   wc/<room>/pong/<id> 有人应答，非 retained
 *   wc/<room>/close     房间解散通知，非 retained
 *
 * 内存释放：
 *   MQTT 的 retained 消息会一直留在 broker 上，直到被「零长度 + retain」抹掉。
 *   所以：
 *     · 手动解散 → dissolve()：广播 close + 抹掉 doc + 清掉所有在线状态；
 *     · 最后一人离开 → leave()：先问还有没有人在，没人应答就自动 dissolve()；
 *     · 房间已解散（closed）后不再 publishState()，避免 15 秒周期把房间写回去。
 */
import * as Y from './vendor/yjs.bundle.mjs?v=20261112b';
import { MqttClient, bytesToB64, b64ToBytes } from './mqtt-lite.js?v=20261112b';

const DEFAULT_BROKERS = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
  'wss://test.mosquitto.org:8081/mqtt'
];

/** 认领槽位前的同步等待窗口（毫秒）：兜底用（房间一直没人时不至于卡住） */
const BIND_DELAY = 3000;

export class Collab {
  /**
   * @param {object} opts
   * @param {string} opts.roomId
   * @param {string} opts.name              我的昵称
   * @param {string} [opts.ownId]           我的稳定标识（刷新后不变，用于认领同一个槽位）
   * @param {string[]} [opts.brokers]
   * @param {(state:{parts:Array<{id:string,text:string}>,names:Object,subs:Object,ownId:string})=>void} opts.onState
   * @param {(status:string, detail?:string)=>void} opts.onStatus
   * @param {(peers:Array<{id:string,name:string,online:boolean}>)=>void} opts.onPeers
   * @param {(info:{by:string,reason:string})=>void} [opts.onClosed]
   */
  constructor(opts) {
    this.opts = opts;
    this.roomId = opts.roomId;
    this.name = opts.name || '匿名';
    this.ownId = opts.ownId || ('p' + Math.random().toString(36).slice(2, 9));
    this.base = 'wc/' + this.roomId;
    this.doc = new Y.Doc();
    this.parts = this.doc.getMap('parts');    // id → Y.Text
    this.people = this.doc.getMap('people');  // id → 昵称
    this.subs = this.doc.getMap('subs');      // id → 提交时间戳
    this.peers = new Map();
    this.myText = null;
    this.pending = null;                     // 认领前的输入（null = 尚未输入）
    this.bound = false;
    this.statePublishTimer = null;
    this.presenceTimer = null;
    this.syncTimer = null;
    this.bindTimer = null;
    this.probeTimer = null;
    this.probeResolve = null;
    this.pongIds = new Set();
    this.closed = false;                      // 房间已解散
    this.leaving = false;                     // 我正在退出

    this.client = new MqttClient({
      brokers: opts.brokers || DEFAULT_BROKERS,
      onStatus: (s, d) => this.handleStatus(s, d),
      onMessage: (t, p) => this.handleMessage(t, p)
    });

    this.parts.observeDeep(() => this.emitState());
    this.people.observeDeep(() => this.emitState());
    this.subs.observeDeep(() => this.emitState());

    this.doc.on('update', (update, origin) => {
      if (this.closed) return;
      if (origin === 'local') {
        this.client.publish(this.base + '/live', bytesToB64(update), false);
        this.scheduleStatePublish();
      }
    });
  }

  /* ---------------- 生命周期 ---------------- */
  start() {
    this.client.connect();
    this.presenceTimer = setInterval(() => this.publishPresence(), 20000);
    // 周期性广播完整状态：让后加入者与中途掉线的成员自动追平
    this.syncTimer = setInterval(() => { if (this.client.connected) this.publishState(); }, 15000);
    this.publishPresence();
    this.onUnload = () => {
      if (this.closed) return;               // 房间已解散，别再把内容写回 broker
      this.publishPresence(true);
      // 从没见到过别人（或别人都已离开）→ 房间已经空了，顺手把 broker 上的副本清掉
      if (this.peers.size === 0 && !this.leaving) {
        this.dissolve('auto-empty');
      } else {
        this.publishState();   // 离开前落一份完整快照，后加入的人一定看得到
      }
    };
    window.addEventListener('beforeunload', this.onUnload);
  }

  destroy() {
    this.clearTimers();
    if (this.onUnload) { window.removeEventListener('beforeunload', this.onUnload); this.onUnload = null; }
    try { this.client.publish(this.base + '/p/' + this.ownId, new Uint8Array(0), true); } catch (e) { /* ignore */ }
    this.client.disconnect();
    this.doc.destroy();
  }

  clearTimers() {
    clearInterval(this.presenceTimer);
    clearInterval(this.syncTimer);
    clearTimeout(this.statePublishTimer);
    clearTimeout(this.bindTimer);
    clearTimeout(this.probeTimer);
    this.presenceTimer = this.syncTimer = null;
    this.statePublishTimer = this.bindTimer = this.probeTimer = null;
  }

  setName(name) {
    this.name = name || '匿名';
    if (this.bound) {
      try {
        this.doc.transact(() => { this.people.set(this.ownId, this.name); }, 'local');
      } catch (e) { /* ignore */ }
    }
    this.publishPresence();
  }

  /* ---------------- 本地编辑（只写「我」的槽位） ---------------- */
  /**
   * 把输入框的新文本写进「我」的槽位。
   * 认领槽位之前先暂存，认领完成后补写。
   */
  setLocalText(newText) {
    if (!this.bound) { this.pending = newText; return; }
    this.writeMine(newText);
  }

  writeMine(text) {
    if (!this.myText) return;
    const cur = this.myText.toString();
    if (cur === text) return;
    const d = diff(cur, text);
    this.doc.transact(() => {
      if (d.removed) this.myText.delete(d.index, d.removed.length);
      if (d.inserted) this.myText.insert(d.index, d.inserted);
    }, 'local');
  }

  /** 我的原文 */
  getMine() { return this.myText ? this.myText.toString() : ''; }

  /** 所有人的槽位：[{id, text}] */
  getParts() {
    const out = [];
    this.parts.forEach((v, id) => {
      if (v && typeof v.toString === 'function') out.push({ id, text: v.toString() });
    });
    return out;
  }

  /** 贡献者 id → 昵称 */
  getNames() {
    const names = {};
    this.people.forEach((n, id) => { if (typeof n === 'string') names[id] = n; });
    this.peers.forEach((p, id) => { if (p.name) names[id] = p.name; });
    return names;
  }

  /* ---------------- 认领槽位 ---------------- */
  scheduleBind(delay) {
    clearTimeout(this.bindTimer);
    this.bindTimer = setTimeout(() => this.bindMine(), delay);
  }

  bindMine() {
    if (this.bound || this.closed) return;
    this.bound = true;
    // 认领过程必须静默：否则「新建空槽位」这一中间态会把输入框里已敲的字清空
    this.suppress = true;
    try {
      this.doc.transact(() => {
        if (!this.parts.has(this.ownId)) this.parts.set(this.ownId, new Y.Text());
        if (!this.people.has(this.ownId)) this.people.set(this.ownId, this.name);
      }, 'local');
      this.myText = this.parts.get(this.ownId) || null;
      if (this.pending !== null && this.myText) {
        const p = this.pending;
        this.pending = null;
        // 槽位里若已有上次留下的内容（刷新后重进房间），保留它并把这次敲的接在后面，
        // 不要用新输入把旧内容整个覆盖掉。
        const cur = this.myText.toString();
        this.writeMine(cur ? cur + '\n' + p : p);
      }
    } catch (e) { /* ignore */ } finally {
      this.suppress = false;
    }
    this.emitState();
  }

  /* ---------------- 提交 ---------------- */
  /**
   * 提交：把当前内容固化成房间快照。
   * 增量同步是「实时」的，但后加入的人只拿得到 retained 的完整快照，
   * 所以提交时立刻落一份 —— 这才是「退出后内容不会被意外清空」的保证。
   */
  submit() {
    try {
      this.doc.transact(() => { this.subs.set(this.ownId, Date.now()); }, 'local');
    } catch (e) { /* ignore */ }
    this.publishState();
  }

  /** 提交后又改了内容 → 撤掉「已定稿」标记 */
  markDirty() {
    if (!this.subs.has(this.ownId)) return;
    try { this.doc.transact(() => { this.subs.delete(this.ownId); }, 'local'); } catch (e) { /* ignore */ }
  }

  isSubmitted() { return this.subs.has(this.ownId); }

  /** 贡献者 id → 提交时间戳 */
  getSubs() {
    const out = {};
    this.subs.forEach((v, k) => { if (typeof v === 'number') out[k] = v; });
    return out;
  }

  /* ---------------- 解散房间 / 释放内存 ---------------- */
  /**
   * 解散房间：
   *   1. 广播 close，房间里的人立刻知道；
   *   2. 用「零长度 + retain」抹掉 broker 上 retained 的完整快照 —— 这一步才真正释放内存；
   *   3. 顺手清掉所有成员的在线状态（同样是 retained）。
   * 解散之后 closed = true，任何状态都不会再被写回 broker，房间不会被「复活」。
   */
  dissolve(reason) {
    if (this.closed) return;
    this.closed = true;
    this.clearTimers();
    try {
      this.client.publish(this.base + '/close',
        JSON.stringify({ by: this.name, ts: Date.now(), reason: reason || '' }), false);
    } catch (e) { /* ignore */ }
    try { this.client.publish(this.base + '/doc', new Uint8Array(0), true); } catch (e) { /* ignore */ }
    this.peers.forEach((p, id) => {
      try { this.client.publish(this.base + '/p/' + id, new Uint8Array(0), true); } catch (e) { /* ignore */ }
    });
    try { this.client.publish(this.base + '/p/' + this.ownId, new Uint8Array(0), true); } catch (e) { /* ignore */ }
    if (this.opts.onClosed) this.opts.onClosed({ by: this.name, reason: reason || '' });
  }

  /**
   * 离开房间：
   *   先清掉自己的在线状态，再问一句「还有人在吗」——
   *   没人应答就说明房间空了，顺手把 broker 上 retained 的房间副本清掉（释放内存）；
   *   还有人应答就保留快照，让房间继续存在。
   */
  async leave() {
    if (this.leaving) return;
    this.leaving = true;
    this.clearTimers();
    try { this.client.publish(this.base + '/p/' + this.ownId, new Uint8Array(0), true); } catch (e) { /* ignore */ }
    const someoneThere = await this.probe(1500);
    if (someoneThere) {
      this.publishState();       // 房间里还有人 → 保留最后一份快照
    } else {
      this.dissolve('auto-empty');   // 空房 → 连同 broker 上的副本一起清掉
    }
    return !someoneThere;
  }

  /** 问一句「还有人在吗」，有人应答就提前结束等待 */
  probe(timeout) {
    return new Promise((resolve) => {
      this.pongIds.clear();
      this.probeResolve = resolve;
      try { this.client.publish(this.base + '/probe', this.ownId, false); } catch (e) { /* ignore */ }
      this.probeTimer = setTimeout(() => {
        this.probeResolve = null;
        resolve(this.pongIds.size > 0);
      }, timeout || 1500);
    });
  }

  /* ---------------- 内部 ---------------- */
  emitState() {
    if (this.suppress) return;
    this.opts.onState({
      parts: this.getParts(),
      names: this.getNames(),
      subs: this.getSubs(),
      ownId: this.ownId
    });
  }

  handleStatus(status, detail) {
    if (status === 'online') {
      this.client.subscribe(this.base + '/#');
      if (this.closed) { this.opts.onStatus(status, detail); return; }
      // 请求一份完整状态，加快加入后的追平
      setTimeout(() => this.client.publish(this.base + '/req', this.ownId, false), 120);
      // 等远端状态到达后再认领槽位，避免刷新时覆盖掉自己上次的内容
      this.scheduleBind(BIND_DELAY);
    }
    this.opts.onStatus(status, detail);
  }

  handleMessage(topic, payload) {
    if (topic === this.base + '/close') {
      // 房间被解散：停止一切写回，把界面切回单人模式
      this.closed = true;
      this.clearTimers();
      let info = {};
      try { info = JSON.parse(new TextDecoder().decode(payload)); } catch (e) { /* ignore */ }
      if (this.opts.onClosed) this.opts.onClosed({ by: info.by || '', reason: info.reason || '' });
      return;
    }
    if (topic === this.base + '/probe') {
      // 有人要走，问「还有人在吗」：我还在就应一声
      if (this.leaving || this.closed) return;
      try { this.client.publish(this.base + '/pong/' + this.ownId, this.ownId, false); } catch (e) { /* ignore */ }
      this.publishPresence();
      return;
    }
    if (topic.indexOf(this.base + '/pong/') === 0) {
      this.pongIds.add(topic.slice((this.base + '/pong/').length));
      if (this.probeResolve) { const r = this.probeResolve; this.probeResolve = null; r(true); }
      return;
    }
    if (topic === this.base + '/doc' || topic === this.base + '/live') {
      if (!payload || !payload.length) return;
      try { this.applyRemote(new TextDecoder().decode(payload)); } catch (e) { /* ignore */ }
      // 收到远端状态 → 房间不是空的，立刻认领槽位（接管已有的那条），
      // 别等兜底计时器，免得和远端抢同一个 key 把内容顶掉。
      if (!this.bound) this.bindMine();
      return;
    }
    if (topic === this.base + '/req') {
      // 有人刚进来：把完整状态发出去（广播，双方都能追平）
      try {
        const state = Y.encodeStateAsUpdate(this.doc);
        this.client.publish(this.base + '/live', bytesToB64(state), false);
      } catch (e) { /* ignore */ }
      return;
    }
    if (topic.indexOf(this.base + '/p/') === 0) {
      const id = topic.slice((this.base + '/p/').length);
      if (!payload || !payload.length) { this.peers.delete(id); this.emitPeers(); return; }
      try {
        const info = JSON.parse(new TextDecoder().decode(payload));
        this.peers.set(id, { id, name: info.name || '匿名', ts: info.ts || 0 });
        this.emitPeers();
      } catch (e) { /* ignore */ }
    }
  }

  applyRemote(b64) {
    try {
      Y.applyUpdate(this.doc, b64ToBytes(b64), 'remote');
    } catch (e) { /* ignore */ }
  }

  scheduleStatePublish() {
    clearTimeout(this.statePublishTimer);
    this.statePublishTimer = setTimeout(() => this.publishState(), 1200);
  }

  publishState() {
    if (this.closed) return;    // 房间已解散：绝不能再把内容写回 broker
    try {
      const state = Y.encodeStateAsUpdate(this.doc);
      this.client.publish(this.base + '/doc', bytesToB64(state), true);
    } catch (e) { /* ignore */ }
  }

  publishPresence(leaving) {
    if (this.closed && !leaving) return;
    if (leaving) {
      try { this.client.publish(this.base + '/p/' + this.ownId, new Uint8Array(0), true); } catch (e) { /* ignore */ }
      return;
    }
    try {
      const payload = JSON.stringify({ name: this.name, ts: Date.now() });
      this.client.publish(this.base + '/p/' + this.ownId, payload, true);
    } catch (e) { /* ignore */ }
  }

  emitPeers() {
    const now = Date.now();
    const list = [];
    for (const p of this.peers.values()) {
      list.push({ id: p.id, name: p.name, online: now - p.ts < 50000 });
    }
    this.opts.onPeers(list);
    this.emitState();   // 在线昵称可能比 people 里的更新
  }
}

/** 简单差分：公共前后缀之外的中间部分即为增删 */
export function diff(a, b) {
  let start = 0;
  const max = Math.min(a.length, b.length);
  while (start < max && a[start] === b[start]) start++;
  let endA = a.length, endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  return {
    index: start,
    removed: a.slice(start, endA),
    inserted: b.slice(start, endB)
  };
}
