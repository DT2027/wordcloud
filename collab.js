/**
 * collab.js —— 多人协作层：Yjs CRDT 共享文档 + MQTT 广播同步
 *
 * 数据流：
 *   本地输入 → diff → 写入 Y.Text（origin=local）→ 广播增量（live）
 *   远端增量 → Y.applyUpdate → Y.Text 变更 → 回调上层刷新输入框与词云
 *   周期性广播整份状态（retained）→ 保证后加入者与断线者自动追平
 *
 * 主题约定：
 *   wc/<room>/doc       retained，完整文档状态（base64）
 *   wc/<room>/live      增量更新（base64），或新成员加入时的状态请求响应
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

export class Collab {
  /**
   * @param {object} opts
   * @param {string} opts.roomId
   * @param {string} opts.name           我的昵称
   * @param {string[]} [opts.brokers]
   * @param {(text:string, origin:string, sel?:{start:number,end:number})=>void} opts.onText
   * @param {(status:string, detail?:string)=>void} opts.onStatus
   * @param {(peers:Array<{id:string,name:string,online:boolean}>)=>void} opts.onPeers
   * @param {()=>({start:number,end:number}|null)} [opts.getSelection]
   */
  constructor(opts) {
    this.opts = opts;
    this.roomId = opts.roomId;
    this.name = opts.name || '匿名';
    this.base = 'wc/' + this.roomId;
    this.doc = new Y.Doc();
    this.ytext = this.doc.getText('text');
    this.peers = new Map();
    this.ownId = 'p' + Math.random().toString(36).slice(2, 9);
    this.statePublishTimer = null;
    this.presenceTimer = null;
    this.syncTimer = null;

    this.client = new MqttClient({
      brokers: opts.brokers || DEFAULT_BROKERS,
      onStatus: (s, d) => this.handleStatus(s, d),
      onMessage: (t, p) => this.handleMessage(t, p)
    });

    this.ytext.observe(() => {
      // 本地事务产生的变更不重复回调（上层已持有同样文本）
      if (this.suppressNotify) return;
      this.opts.onText(this.ytext.toString(), 'remote');
    });

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
    try { this.client.publish(this.base + '/p/' + this.ownId, new Uint8Array(0), true); } catch (e) { /* ignore */ }
    this.client.disconnect();
    this.doc.destroy();
  }

  setName(name) {
    this.name = name || '匿名';
    this.publishPresence();
  }

  /* ---------------- 本地编辑 ---------------- */
  /** 把输入框的新文本同步进 CRDT */
  setLocalText(newText) {
    const cur = this.ytext.toString();
    if (cur === newText) return;
    const d = diff(cur, newText);
    this.suppressNotify = true;
    this.doc.transact(() => {
      if (d.removed) this.ytext.delete(d.index, d.removed.length);
      if (d.inserted) this.ytext.insert(d.index, d.inserted);
    }, 'local');
    this.suppressNotify = false;
    this.opts.onText(this.ytext.toString(), 'local');
  }

  getText() { return this.ytext.toString(); }

  /* ---------------- 内部 ---------------- */
  handleStatus(status, detail) {
    if (status === 'online') {
      this.client.subscribe(this.base + '/#');
      // 请求一份完整状态，加快加入后的追平
      setTimeout(() => this.client.publish(this.base + '/req', this.ownId, false), 120);
    }
    this.opts.onStatus(status, detail);
  }

  handleMessage(topic, payload) {
    if (topic === this.base + '/doc') {
      if (!payload || !payload.length) return;
      try { this.applyRemote(new TextDecoder().decode(payload)); } catch (e) { /* ignore */ }
      return;
    }
    if (topic === this.base + '/live') {
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
    const sel = this.opts.getSelection ? this.opts.getSelection() : null;
    let relStart = null, relEnd = null;
    if (sel) {
      try {
        relStart = Y.createRelativePositionFromTypeIndex(this.ytext, sel.start);
        relEnd = Y.createRelativePositionFromTypeIndex(this.ytext, sel.end);
      } catch (e) { /* ignore */ }
    }
    try {
      Y.applyUpdate(this.doc, b64ToBytes(b64), 'remote');
    } catch (e) { /* ignore */; return; }

    let newSel = null;
    if (relStart) {
      try {
        const a = Y.createAbsolutePositionFromRelativePosition(relStart, this.doc);
        const b = Y.createAbsolutePositionFromRelativePosition(relEnd, this.doc);
        if (a && b) newSel = { start: a.index, end: b.index };
      } catch (e) { /* ignore */ }
    }
    this.opts.onText(this.ytext.toString(), 'remote', newSel);
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
