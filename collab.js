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
 *
 * 认领槽位：
 *   首次连上后先等一个同步窗口（等远端 retained 状态到达），
 *   再检查 parts 里是否已有「我」的槽位：
 *     有 → 直接接管（刷新后仍能看到自己上次写的内容）
 *     无 → 新建一个空槽位
 *   等待期间敲进去的字先暂存在 pending，认领完成后一次性写入。
 *
 * 主题约定：
 *   wc/<room>/doc       retained，完整文档状态（base64）
 *   wc/<room>/live      增量更新（base64）
 *   wc/<room>/req       新成员加入时广播的状态请求
 *   wc/<room>/p/<id>    retained，在线状态 {name, ts}
 */
import * as Y from './vendor/yjs.bundle.mjs';
import { MqttClient, bytesToB64, b64ToBytes } from './mqtt-lite.js';

const DEFAULT_BROKERS = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
  'wss://test.mosquitto.org:8081/mqtt'
];

/** 认领槽位前的同步等待窗口（毫秒） */
const BIND_DELAY = 2200;

export class Collab {
  /**
   * @param {object} opts
   * @param {string} opts.roomId
   * @param {string} opts.name              我的昵称
   * @param {string} [opts.ownId]           我的稳定标识（刷新后不变，用于认领同一个槽位）
   * @param {string[]} [opts.brokers]
   * @param {(state:{parts:Array<{id:string,text:string}>,names:Object,ownId:string})=>void} opts.onState
   * @param {(status:string, detail?:string)=>void} opts.onStatus
   * @param {(peers:Array<{id:string,name:string,online:boolean}>)=>void} opts.onPeers
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
    this.peers = new Map();
    this.myText = null;
    this.pending = null;                     // 认领前的输入（null = 尚未输入）
    this.bound = false;
    this.statePublishTimer = null;
    this.presenceTimer = null;
    this.syncTimer = null;
    this.bindTimer = null;

    this.client = new MqttClient({
      brokers: opts.brokers || DEFAULT_BROKERS,
      onStatus: (s, d) => this.handleStatus(s, d),
      onMessage: (t, p) => this.handleMessage(t, p)
    });

    this.parts.observeDeep(() => this.emitState());
    this.people.observeDeep(() => this.emitState());

    this.doc.on('update', (update, origin) => {
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
    window.addEventListener('beforeunload', () => this.publishPresence(true));
  }

  destroy() {
    clearInterval(this.presenceTimer);
    clearInterval(this.syncTimer);
    clearTimeout(this.statePublishTimer);
    clearTimeout(this.bindTimer);
    try { this.client.publish(this.base + '/p/' + this.ownId, new Uint8Array(0), true); } catch (e) { /* ignore */ }
    this.client.disconnect();
    this.doc.destroy();
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
    if (this.bound) return;
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
        this.writeMine(p);
      }
    } catch (e) { /* ignore */ } finally {
      this.suppress = false;
    }
    this.emitState();
  }

  /* ---------------- 内部 ---------------- */
  emitState() {
    if (this.suppress) return;
    this.opts.onState({
      parts: this.getParts(),
      names: this.getNames(),
      ownId: this.ownId
    });
  }

  handleStatus(status, detail) {
    if (status === 'online') {
      this.client.subscribe(this.base + '/#');
      // 请求一份完整状态，加快加入后的追平
      setTimeout(() => this.client.publish(this.base + '/req', this.ownId, false), 120);
      // 等远端状态到达后再认领槽位，避免刷新时覆盖掉自己上次的内容
      this.scheduleBind(BIND_DELAY);
    }
    this.opts.onStatus(status, detail);
  }

  handleMessage(topic, payload) {
    if (topic === this.base + '/doc' || topic === this.base + '/live') {
      if (!payload || !payload.length) return;
      try { this.applyRemote(new TextDecoder().decode(payload)); } catch (e) { /* ignore */ }
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
    try {
      const state = Y.encodeStateAsUpdate(this.doc);
      this.client.publish(this.base + '/doc', bytesToB64(state), true);
    } catch (e) { /* ignore */ }
  }

  publishPresence(leaving) {
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
