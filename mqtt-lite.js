/**
 * mqtt-lite.js —— 极简 MQTT 3.1.1 客户端（仅 WebSocket 传输，QoS 0）
 * 约 5KB，无第三方依赖，用于把 GitHub Pages 这类纯静态站点接入实时广播通道。
 * 支持：连接、订阅、发布（可 retain）、保活、自动重连、多 broker 故障切换。
 */

const CONNECT = 1, CONNACK = 2, PUBLISH = 3, PUBACK = 4;
const SUBSCRIBE = 8, SUBACK = 9, UNSUBSCRIBE = 10, UNSUBACK = 11;
const PINGREQ = 12, PINGRESP = 13, DISCONNECT = 14;

// ---- 编码工具 ----
function varint(n) {
  const out = [];
  do {
    let d = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) d |= 0x80;
    out.push(d);
  } while (n > 0);
  return out;
}
function utf8(str) {
  const bytes = new TextEncoder().encode(str);
  const out = new Uint8Array(bytes.length + 2);
  out[0] = bytes.length >> 8;
  out[1] = bytes.length & 255;
  out.set(bytes, 2);
  return out;
}
function concat(arrays) {
  let len = 0;
  for (const a of arrays) len += a.length;
  const out = new Uint8Array(len);
  let p = 0;
  for (const a of arrays) { out.set(a, p); p += a.length; }
  return out;
}
function packet(type, flags, body) {
  const head = [(type << 4) | flags];
  return concat([new Uint8Array(head), new Uint8Array(varint(body.length)), body]);
}
function twoBytes(n) { return new Uint8Array([(n >> 8) & 255, n & 255]); }

export class MqttClient {
  /**
   * @param {object} opts
   * @param {string[]} opts.brokers  依次尝试的 WebSocket 地址
   * @param {(topic:string, payload:Uint8Array)=>void} opts.onMessage
   * @param {(status:string, detail?:string)=>void} opts.onStatus
   */
  constructor(opts) {
    this.brokers = opts.brokers || [];
    this.onMessage = opts.onMessage || function () {};
    this.onStatus = opts.onStatus || function () {};
    this.clientId = 'wc-' + Math.random().toString(36).slice(2, 10) + '-' + Date.now().toString(36);
    this.ws = null;
    this.connected = false;
    this.subscribed = new Set();
    this.retry = 0;
    this.brokerIndex = 0;
    this.closed = false;
    this.pingTimer = null;
    this.buf = new Uint8Array(0);
    this.outQueue = [];
  }

  connect() {
    if (this.closed) return;
    const url = this.brokers[this.brokerIndex % this.brokers.length];
    this.onStatus('connecting', url);
    let ws;
    try {
      ws = new WebSocket(url, ['mqtt']);
    } catch (e) {
      this.scheduleRetry(String(e && e.message || e));
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;

    ws.onopen = () => {
      const body = concat([
        utf8('MQTT'),
        new Uint8Array([4, 2]),        // protocol level 4, clean session
        twoBytes(60),                  // keep alive 60s
        utf8(this.clientId)
      ]);
      ws.send(packet(CONNECT, 0, body));
    };

    ws.onmessage = (ev) => {
      const data = ev.data;
      const chunk = (data instanceof ArrayBuffer) ? new Uint8Array(data)
                   : (typeof data === 'string') ? new TextEncoder().encode(data)
                   : new Uint8Array(data);
      this.feed(chunk);
    };

    ws.onerror = () => { /* onclose 会接手重连 */ };

    ws.onclose = () => {
      this.connected = false;
      this.clearPing();
      if (!this.closed) this.scheduleRetry('connection closed');
    };
  }

  feed(chunk) {
    this.buf = concat([this.buf, chunk]);
    while (this.buf.length >= 2) {
      let mult = 1, len = 0, i = 1, complete = false;
      while (i < this.buf.length) {
        const d = this.buf[i];
        len += (d & 127) * mult;
        mult *= 128;
        i++;
        if (!(d & 128)) { complete = true; break; }
      }
      if (!complete || this.buf.length < i + len) return;
      const type = this.buf[0] >> 4;
      const flags = this.buf[0] & 15;
      const body = this.buf.slice(i, i + len);
      this.buf = this.buf.slice(i + len);
      this.handle(type, flags, body);
    }
  }

  handle(type, flags, body) {
    if (type === CONNACK) {
      const code = body.length > 1 ? body[1] : -1;
      if (code !== 0) { this.onStatus('error', 'connack ' + code); this.scheduleRetry('connack ' + code); return; }
      this.connected = true;
      this.retry = 0;
      this.onStatus('online');
      this.startPing();
      // 重连后重新订阅
      for (const t of this.subscribed) this.rawSubscribe(t);
      this.flushQueue();
      return;
    }
    if (type === PUBLISH) {
      const topicLen = (body[0] << 8) | body[1];
      const topic = new TextDecoder().decode(body.slice(2, 2 + topicLen));
      const qos = (flags >> 1) & 3;
      let p = 2 + topicLen;
      if (qos > 0) p += 2;                     // packet id
      const payload = body.slice(p);
      this.onMessage(topic, payload);
      return;
    }
    if (type === PINGRESP) return;
  }

  startPing() {
    this.clearPing();
    this.pingTimer = setInterval(() => {
      if (this.connected && this.ws && this.ws.readyState === 1) {
        try { this.ws.send(packet(PINGREQ, 0, new Uint8Array(0))); } catch (e) { /* ignore */ }
      }
    }, 25000);
  }
  clearPing() { if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; } }

  scheduleRetry(detail) {
    if (this.closed) return;
    this.onStatus('offline', detail);
    this.retry++;
    this.brokerIndex++;                       // 换一个 broker 再试
    const delay = Math.min(15000, 800 * Math.pow(1.6, Math.min(this.retry, 8)));
    setTimeout(() => this.connect(), delay);
  }

  rawSubscribe(topic) {
    if (!this.connected || !this.ws || this.ws.readyState !== 1) return;
    const body = concat([twoBytes(this.packetId = (this.packetId || 0) + 1), utf8(topic), new Uint8Array([0])]);
    try { this.ws.send(packet(SUBSCRIBE, 2, body)); } catch (e) { /* ignore */ }
  }

  subscribe(topic) {
    this.subscribed.add(topic);
    this.rawSubscribe(topic);
  }

  publish(topic, payload, retain) {
    const bytes = typeof payload === 'string' ? new TextEncoder().encode(payload) : payload;
    const body = concat([utf8(topic), bytes]);
    const pkt = packet(PUBLISH, retain ? 1 : 0, body);
    if (this.connected && this.ws && this.ws.readyState === 1) {
      try { this.ws.send(pkt); return; } catch (e) { /* fallthrough */ }
    }
    this.outQueue.push(pkt);
    if (this.outQueue.length > 200) this.outQueue.shift();
  }

  flushQueue() {
    while (this.outQueue.length && this.connected && this.ws && this.ws.readyState === 1) {
      try { this.ws.send(this.outQueue.shift()); } catch (e) { break; }
    }
  }

  disconnect() {
    this.closed = true;
    this.clearPing();
    if (this.ws && this.ws.readyState === 1) {
      try { this.ws.send(packet(DISCONNECT, 0, new Uint8Array(0))); } catch (e) { /* ignore */ }
      try { this.ws.close(); } catch (e) { /* ignore */ }
    }
  }
}

/** Uint8Array → base64（浏览器端安全） */
export function bytesToB64(bytes) {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

/** base64 → Uint8Array */
export function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
