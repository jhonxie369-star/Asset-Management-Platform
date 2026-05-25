import * as http from 'http';
import * as net from 'net';
import * as zlib from 'zlib';
import type { Tester } from './types.js';
import { httpBasicAuth } from './http-basic.js';

function tcpProbe(label: string, probe: Buffer, ok: RegExp): Tester {
  return ({ host, port, timeoutMs }) => new Promise(resolve => {
    const sock = new net.Socket();
    let buf = Buffer.alloc(0);
    let done = false;
    const finish = (success: boolean, message: string) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve({ success, message, banner: buf.toString('utf8').slice(0, 200) });
    };
    sock.setTimeout(timeoutMs);
    sock.on('connect', () => sock.write(probe));
    sock.on('data', d => {
      buf = Buffer.concat([buf, d]).slice(0, 4096);
      const text = buf.toString('utf8');
      if (ok.test(text)) finish(true, `${label}_unauth`);
      else if (buf.length > 0) setTimeout(() => finish(false, 'not_matched'), 80);
    });
    sock.on('timeout', () => finish(false, 'timeout'));
    sock.on('error', () => finish(false, 'connect_failed'));
    sock.connect(port, host);
  });
}

function tcpDialog(
  host: string,
  port: number,
  timeoutMs: number,
  steps: Array<{ send: Buffer; waitFor: RegExp; label: string }>,
): Promise<{ ok: boolean; label: string; text: string }> {
  return new Promise(resolve => {
    const sock = new net.Socket();
    let buf = Buffer.alloc(0);
    let step = 0;
    let done = false;
    const finish = (ok: boolean, label: string) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve({ ok, label, text: buf.toString('utf8').slice(0, 4096) });
    };
    const runStep = () => {
      if (step >= steps.length) return finish(true, 'done');
      buf = Buffer.alloc(0);
      sock.write(steps[step].send);
    };
    sock.setTimeout(timeoutMs);
    sock.on('connect', runStep);
    sock.on('data', d => {
      buf = Buffer.concat([buf, d]).slice(0, 64 * 1024);
      const current = steps[step];
      if (current.waitFor.test(buf.toString('utf8'))) {
        step++;
        if (step >= steps.length) finish(true, current.label);
        else runStep();
      }
    });
    sock.on('timeout', () => finish(false, 'timeout'));
    sock.on('error', () => finish(false, 'connect_failed'));
    sock.connect(port, host);
  });
}

function int16(n: number): Buffer {
  const b = Buffer.alloc(2);
  b.writeInt16BE(n, 0);
  return b;
}

function int32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeInt32BE(n, 0);
  return b;
}

function int64(n: number | bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigInt64BE(BigInt(n), 0);
  return b;
}

function kafkaString(value: string): Buffer {
  const body = Buffer.from(value);
  return Buffer.concat([int16(body.length), body]);
}

function kafkaRequest(apiKey: number, apiVersion: number, correlationId: number, body?: Uint8Array): Buffer {
  const payload = Buffer.concat([
    int16(apiKey),
    int16(apiVersion),
    int32(correlationId),
    kafkaString('sasp'),
    Buffer.from(body || new Uint8Array()),
  ]);
  return Buffer.concat([int32(payload.length), payload]);
}

function kafkaArray<T>(items: T[], encode: (item: T) => Buffer): Buffer {
  return Buffer.concat([int32(items.length), ...items.map(encode)]);
}

function kafkaNullableStringArray(items?: string[]): Buffer {
  if (!items) return int32(-1);
  return kafkaArray(items, kafkaString);
}

class BinReader {
  offset = 0;
  constructor(public buf: Buffer) {}
  remaining() { return this.buf.length - this.offset; }
  int8() { const v = this.buf.readInt8(this.offset); this.offset += 1; return v; }
  int16() { const v = this.buf.readInt16BE(this.offset); this.offset += 2; return v; }
  int32() { const v = this.buf.readInt32BE(this.offset); this.offset += 4; return v; }
  int64() { const v = this.buf.readBigInt64BE(this.offset); this.offset += 8; return v; }
  string() {
    const len = this.int16();
    if (len < 0) return '';
    const out = this.buf.toString('utf8', this.offset, this.offset + len);
    this.offset += len;
    return out;
  }
  bytes(len: number) {
    const out = this.buf.subarray(this.offset, this.offset + len);
    this.offset += len;
    return out;
  }
  kafkaBytes() {
    const len = this.int32();
    if (len < 0) return Buffer.alloc(0);
    return this.bytes(len);
  }
}

function kafkaRoundTrip(host: string, port: number, timeoutMs: number, request: Buffer, correlationId: number): Promise<Buffer | undefined> {
  return new Promise(resolve => {
    const sock = new net.Socket();
    let buf = Buffer.alloc(0);
    let done = false;
    const finish = (body?: Buffer) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve(body);
    };
    sock.setTimeout(timeoutMs);
    sock.on('connect', () => sock.write(request));
    sock.on('data', d => {
      buf = Buffer.concat([buf, d]).slice(0, 2 * 1024 * 1024);
      if (buf.length < 8) return;
      const frameLen = buf.readInt32BE(0);
      if (frameLen <= 0 || frameLen > 2 * 1024 * 1024) return finish();
      if (buf.length < frameLen + 4) return;
      const corr = buf.readInt32BE(4);
      if (corr !== correlationId) return finish();
      finish(buf.subarray(8, 4 + frameLen));
    });
    sock.on('timeout', () => finish());
    sock.on('error', () => finish());
    sock.on('end', () => finish());
    sock.on('close', () => finish());
    sock.connect(port, host);
  });
}

interface KafkaBrokerMeta { nodeId: number; host: string; port: number }
interface KafkaPartitionMeta { id: number; leader?: number; leaderHost?: string; leaderPort?: number }
interface KafkaTopicMeta { name: string; partitions: KafkaPartitionMeta[] }

function parseKafkaMetadata(body: Buffer): { brokers: KafkaBrokerMeta[]; topics: KafkaTopicMeta[] } | undefined {
  try {
    const r = new BinReader(body);
    const brokerCount = r.int32();
    if (brokerCount < 0 || brokerCount > 100000) return undefined;
    const brokers: KafkaBrokerMeta[] = [];
    const brokerById = new Map<number, KafkaBrokerMeta>();
    for (let i = 0; i < brokerCount; i++) {
      const broker = { nodeId: r.int32(), host: r.string(), port: r.int32() };
      brokers.push(broker);
      brokerById.set(broker.nodeId, broker);
    }
    if (r.remaining() < 4) return { brokers, topics: [] };
    const topicCount = r.int32();
    const topics: KafkaTopicMeta[] = [];
    if (topicCount < 0 || topicCount > 100000) return { brokers, topics };
    for (let i = 0; i < topicCount && r.remaining() > 0; i++) {
      const topicErr = r.int16();
      const name = r.string();
      const partitionCount = r.int32();
      const partitions: KafkaPartitionMeta[] = [];
      for (let p = 0; p < partitionCount && r.remaining() > 0; p++) {
        const err = r.int16();
        const partitionId = r.int32();
        const leader = r.int32();
        const replicaCount = r.int32();
        for (let j = 0; j < replicaCount; j++) r.int32();
        const isrCount = r.int32();
        for (let j = 0; j < isrCount; j++) r.int32();
        const broker = brokerById.get(leader);
        if (topicErr === 0 && err === 0) partitions.push({
          id: partitionId,
          leader,
          leaderHost: broker?.host,
          leaderPort: broker?.port,
        });
      }
      if (topicErr === 0 && name) topics.push({ name, partitions });
    }
    return { brokers, topics };
  } catch {
    return undefined;
  }
}

function kafkaOffsetRequest(topic: string, partition: number, time: number, maxOffsets = 1): Buffer {
  return Buffer.concat([
    int32(-1), // replica id: normal consumer
    kafkaArray([{ topic, partition }], t => Buffer.concat([
      kafkaString(t.topic),
      kafkaArray([t.partition], p => Buffer.concat([int32(p), int64(time), int32(maxOffsets)])),
    ])),
  ]);
}

function parseKafkaOffset(body: Buffer): bigint | undefined {
  try {
    const r = new BinReader(body);
    const topicCount = r.int32();
    for (let i = 0; i < topicCount; i++) {
      r.string();
      const partCount = r.int32();
      for (let p = 0; p < partCount; p++) {
        r.int32();
        const err = r.int16();
        const offsetCount = r.int32();
        for (let o = 0; o < offsetCount; o++) {
          const off = r.int64();
          if (err === 0) return off;
        }
      }
    }
  } catch {
    return undefined;
  }
}

function kafkaFetchRequest(topic: string, partition: number, offset: bigint): Buffer {
  return Buffer.concat([
    int32(-1), // replica id
    int32(100), // max wait ms
    int32(1), // min bytes
    kafkaArray([{ topic, partition }], t => Buffer.concat([
      kafkaString(t.topic),
      kafkaArray([t.partition], p => Buffer.concat([int32(p), int64(offset), int32(4096)])),
    ])),
  ]);
}

interface KafkaFetchSample {
  bytes: number;
  messageCount: number;
  hints: string[];
  jsonKeys: string[];
  payloadClass: 'business' | 'internal' | 'unclassified';
}

const KAFKA_INTERNAL_TOPIC_RE = /^(?:__consumer_offsets|connect-(?:status|configs?|offsets?)(?:[-.]|$)|mm2-(?:configs|status|offsets)\.|mirrormaker2-|.*\.internal$)/i;
const KAFKA_BUSINESS_TOPIC_RE = /(finance|traffic|bid|click|event|adv|ad[_-]?|analysis|sdk|push|strategy|behavior|user|order|pay|revenue|cost|qps|kwai|ym_|pn_|dsp)/i;
const KAFKA_SENSITIVE_HINTS: Array<[RegExp, string]> = [
  [/password|passwd|pwd/i, 'password-key'],
  [/secret|token|authorization|access[_-]?key|session|cookie/i, 'secret-token-key'],
  [/email|mail/i, 'email-key'],
  [/phone|mobile|tel/i, 'phone-key'],
  [/imei|idfa|gaid|device/i, 'device-id-key'],
  [/user[_-]?id|uid|account|customer/i, 'user/account-key'],
  [/finance|revenue|cost|price|budget|bid|cpc|cpm|ctr|roi|charge|spend/i, 'finance/ad-metric-key'],
  [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i, 'email-value'],
  [/\b1[3-9]\d{9}\b/, 'cn-phone-value'],
  [/AKIA[0-9A-Z]{16}/, 'aws-ak-value'],
  [/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/, 'jwt-like-value'],
];

function collectJsonKeys(value: unknown, prefix = '', out: string[] = []): string[] {
  if (!value || typeof value !== 'object' || out.length >= 40) return out;
  if (Array.isArray(value)) {
    if (value[0] && typeof value[0] === 'object') collectJsonKeys(value[0], `${prefix}[]`, out);
    return out;
  }
  for (const key of Object.keys(value as Record<string, unknown>).slice(0, 40)) {
    const path = prefix ? `${prefix}.${key}` : key;
    out.push(path);
    collectJsonKeys((value as Record<string, unknown>)[key], path, out);
    if (out.length >= 40) break;
  }
  return out;
}

function classifyKafkaValue(value: Buffer): { hints: string[]; jsonKeys: string[] } {
  const text = value.toString('utf8').replace(/[\x00-\x08\x0e-\x1f]/g, ' ').trim();
  const hints = new Set<string>();
  let jsonKeys: string[] = [];
  try {
    const parsed = JSON.parse(text);
    jsonKeys = collectJsonKeys(parsed).slice(0, 20);
    for (const key of jsonKeys) {
      for (const [re, label] of KAFKA_SENSITIVE_HINTS) {
        if (re.test(key)) hints.add(label);
      }
    }
  } catch {
    // Kafka payloads are often binary/enveloped; keyword hints below still give a safe summary.
  }
  for (const [re, label] of KAFKA_SENSITIVE_HINTS) {
    if (re.test(text)) hints.add(label);
  }
  return { hints: [...hints], jsonKeys };
}

function parseKafkaMessageSet(buf: Buffer, depth = 0): Buffer[] {
  const r = new BinReader(buf);
  const values: Buffer[] = [];
  while (r.remaining() >= 12 && values.length < 8) {
    const base = r.offset;
    try {
      r.int64(); // offset
      const messageSize = r.int32();
      if (messageSize <= 0 || messageSize > r.remaining()) break;
      const end = r.offset + messageSize;
      r.int32(); // crc
      const magic = r.int8();
      const attributes = r.int8();
      if (magic === 1 && r.remaining() >= 8) r.int64(); // timestamp
      r.kafkaBytes(); // key
      const value = r.kafkaBytes();
      const codec = attributes & 7;
      if (value.length > 0) values.push(value);
      if (codec === 1 && value.length > 0 && depth < 2) {
        try { values.push(...parseKafkaMessageSet(zlib.gunzipSync(value), depth + 1)); } catch { /* unsupported gzip payload */ }
      }
      r.offset = end;
    } catch {
      r.offset = base;
      break;
    }
  }
  return values;
}

function parseKafkaFetchSample(body: Buffer, topicName: string): KafkaFetchSample {
  const out: KafkaFetchSample = {
    bytes: 0,
    messageCount: 0,
    hints: [],
    jsonKeys: [],
    payloadClass: KAFKA_INTERNAL_TOPIC_RE.test(topicName) ? 'internal' : 'unclassified',
  };
  try {
    const r = new BinReader(body);
    const topicCount = r.int32();
    const hints = new Set<string>();
    const keys = new Set<string>();
    for (let i = 0; i < topicCount; i++) {
      const responseTopic = r.string();
      const partCount = r.int32();
      for (let p = 0; p < partCount; p++) {
        r.int32();
        const err = r.int16();
        r.int64(); // high watermark
        const size = r.int32();
        if (size > 0 && r.remaining() >= size) {
          const messageSet = r.bytes(size);
          if (err === 0) {
            out.bytes += size;
            const values = parseKafkaMessageSet(messageSet);
            out.messageCount += values.length;
            for (const value of values.slice(0, 5)) {
              const classified = classifyKafkaValue(value);
              classified.hints.forEach(h => hints.add(h));
              classified.jsonKeys.forEach(k => keys.add(k));
            }
            if (!KAFKA_INTERNAL_TOPIC_RE.test(responseTopic || topicName)) {
              out.payloadClass = hints.size > 0 || keys.size > 0 || KAFKA_BUSINESS_TOPIC_RE.test(responseTopic || topicName)
                ? 'business'
                : 'unclassified';
            }
          }
        }
      }
    }
    out.hints = [...hints].slice(0, 8);
    out.jsonKeys = [...keys].slice(0, 12);
    if (out.payloadClass !== 'internal' && out.hints.length > 0) out.payloadClass = 'business';
    return out;
  } catch {
    return out;
  }
}

function kafkaMetadataProbe(): Tester {
  return async ({ host, port, timeoutMs }) => {
    const metadataCorr = 0x53415350; // "SASP"
    let metadataBody = await kafkaRoundTrip(
      host,
      port,
      timeoutMs,
      kafkaRequest(3, 0, metadataCorr, kafkaNullableStringArray(undefined)),
      metadataCorr,
    );
    if (!metadataBody) {
      metadataBody = await kafkaRoundTrip(
        host,
        port,
        timeoutMs,
        kafkaRequest(3, 0, metadataCorr, int32(0)),
        metadataCorr,
      );
    }
    const metadata = metadataBody ? parseKafkaMetadata(metadataBody) : undefined;
    if (!metadata) return { success: false, message: 'not_kafka_metadata' };

    // Metadata alone is not enough for a high-value finding. Try a read-only fetch
    // from earliest offset without joining a consumer group or committing offsets.
    for (const topic of metadata.topics.slice(0, 10)) {
      for (const partitionMeta of topic.partitions.slice(0, 3)) {
        const partition = partitionMeta.id;
        const offCorr = metadataCorr + 1;
        const offBody = await kafkaRoundTrip(
          host, port, timeoutMs,
          kafkaRequest(2, 0, offCorr, kafkaOffsetRequest(topic.name, partition, -2, 1)),
          offCorr,
        );
        const earliest = offBody ? parseKafkaOffset(offBody) : undefined;
        if (earliest === undefined) continue;
        const fetchCorr = metadataCorr + 2;
        const fetchBody = await kafkaRoundTrip(
          host, port, timeoutMs,
          kafkaRequest(1, 0, fetchCorr, kafkaFetchRequest(topic.name, partition, earliest)),
          fetchCorr,
        );
        const sample = fetchBody ? parseKafkaFetchSample(fetchBody, topic.name) : undefined;
        if (sample && sample.bytes > 0) {
          const detail = [
            `topic=${topic.name}`,
            `partition=${partition}`,
            partitionMeta.leaderHost ? `leader=${partitionMeta.leaderHost}:${partitionMeta.leaderPort || port}` : '',
            `fetchedFrom=${host}:${port}`,
            `offset=${earliest.toString()}`,
            `bytes=${sample.bytes}`,
            `class=${sample.payloadClass}`,
            `messages=${sample.messageCount}`,
            sample.hints.length ? `hints=${sample.hints.join(',')}` : '',
            sample.jsonKeys.length ? `jsonKeys=${sample.jsonKeys.join(',')}` : '',
          ].filter(Boolean).join(' ');
          const message = sample.payloadClass === 'internal'
            ? 'kafka_internal_topic_read'
            : sample.payloadClass === 'business'
              ? 'kafka_business_message_read'
              : 'kafka_message_read_unclassified';
          return {
            success: true,
            message,
            banner: `Kafka message readable ${detail}`,
          };
        }
      }
    }

    return {
      success: false,
      message: `kafka_metadata_only brokers=${metadata.brokers.length} topics=${metadata.topics.length}`,
      banner: `Kafka metadata readable, but no message bytes fetched. brokers=${metadata.brokers.length}, topics=${metadata.topics.length}`,
    };
  };
}

function zookeeperFrame(payload: Buffer): Buffer {
  return Buffer.concat([int32(payload.length), payload]);
}

function zookeeperString(value: string): Buffer {
  const body = Buffer.from(value);
  return Buffer.concat([int32(body.length), body]);
}

function zookeeperBuffer(value = Buffer.alloc(0)): Buffer {
  return Buffer.concat([int32(value.length), value]);
}

function zookeeperConnect(timeoutMs: number): Buffer {
  return zookeeperFrame(Buffer.concat([
    int32(0),
    int64(0),
    int32(timeoutMs),
    int64(0),
    zookeeperBuffer(),
    Buffer.from([0]),
  ]));
}

function zookeeperRequest(xid: number, type: number, body: Buffer): Buffer {
  return zookeeperFrame(Buffer.concat([int32(xid), int32(type), body]));
}

function zookeeperGetChildren2(xid: number, path: string): Buffer {
  return zookeeperRequest(xid, 12, Buffer.concat([zookeeperString(path), Buffer.from([0])]));
}

function zookeeperGetData(xid: number, path: string): Buffer {
  return zookeeperRequest(xid, 4, Buffer.concat([zookeeperString(path), Buffer.from([0])]));
}

function parseZkChildren(body: Buffer): string[] {
  const r = new BinReader(body);
  const count = r.int32();
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const len = r.int32();
    if (len < 0 || r.remaining() < len) break;
    out.push(r.bytes(len).toString('utf8'));
  }
  return out;
}

function parseZkData(body: Buffer): Buffer {
  const r = new BinReader(body);
  const len = r.int32();
  if (len <= 0 || r.remaining() < len) return Buffer.alloc(0);
  return r.bytes(len);
}

async function zookeeperReadProbe(host: string, port: number, timeoutMs: number): Promise<{ success: boolean; message: string; banner?: string }> {
  return new Promise(resolve => {
    const sock = new net.Socket();
    let acc = Buffer.alloc(0);
    let connected = false;
    let xid = 1;
    const pending = new Map<number, { kind: 'children' | 'data'; path: string }>();
    const queue = ['/', '/dubbo', '/re-ali-dubbo', '/ec-dubbo', '/brokers', '/config'];
    const seen = new Set(queue);
    let enumeratedPath: { path: string; children: string[] } | undefined;
    let dataHit: { path: string; data: Buffer } | undefined;
    let done = false;

    const finish = (success: boolean, message: string, banner?: string) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve({ success, message, banner });
    };
    const sendChildren = (path: string) => {
      const id = xid++;
      pending.set(id, { kind: 'children', path });
      sock.write(zookeeperGetChildren2(id, path));
    };
    const sendData = (path: string) => {
      const id = xid++;
      pending.set(id, { kind: 'data', path });
      sock.write(zookeeperGetData(id, path));
    };
    const pump = () => {
      while (pending.size < 20 && queue.length > 0 && !dataHit) {
        const path = queue.shift()!;
        sendChildren(path);
        sendData(path);
      }
      if (pending.size === 0 && queue.length === 0) {
        if (dataHit) {
          finish(true, 'zookeeper_znode_data_read', `path=${dataHit.path}, bytes=${dataHit.data.length}`);
        } else if (enumeratedPath) {
          finish(true, 'zookeeper_znode_enum', `path=${enumeratedPath.path}, children=${enumeratedPath.children.slice(0, 12).join(',')}`);
        } else {
          finish(false, 'zookeeper_no_readable_znode');
        }
      }
    };
    const handleFrame = (payload: Buffer) => {
      if (!connected) {
        connected = true;
        pump();
        return;
      }
      const r = new BinReader(payload);
      const rxid = r.int32();
      r.int64(); // zxid
      const err = r.int32();
      const item = pending.get(rxid);
      if (!item) return;
      pending.delete(rxid);
      if (err !== 0) return pump();
      const body = payload.subarray(r.offset);
      if (item.kind === 'children') {
        const children = parseZkChildren(body);
        const useful = children.filter(c => c !== 'zookeeper' && c !== 'quota');
        if (useful.length > 0 && !enumeratedPath) enumeratedPath = { path: item.path, children: useful };
        if (item.path.split('/').filter(Boolean).length < 2) {
          for (const child of useful.slice(0, 40)) {
            const next = `${item.path === '/' ? '' : item.path}/${child}`;
            if (!seen.has(next)) {
              seen.add(next);
              queue.push(next);
            }
          }
        }
      } else {
        const data = parseZkData(body);
        if (data.length > 0) dataHit = { path: item.path, data };
      }
      pump();
    };

    sock.setTimeout(timeoutMs);
    sock.on('connect', () => sock.write(zookeeperConnect(timeoutMs)));
    sock.on('data', d => {
      acc = Buffer.concat([acc, d]).slice(0, 2 * 1024 * 1024);
      while (acc.length >= 4) {
        const len = acc.readInt32BE(0);
        if (len <= 0 || len > 2 * 1024 * 1024) return finish(false, 'bad_zookeeper_frame');
        if (acc.length < len + 4) break;
        const payload = acc.subarray(4, 4 + len);
        acc = acc.subarray(4 + len);
        handleFrame(payload);
      }
    });
    sock.on('timeout', () => finish(false, 'timeout'));
    sock.on('error', () => finish(false, 'connect_failed'));
    sock.connect(port, host);
  });
}

async function zookeeperFourLetter(host: string, port: number, timeoutMs: number): Promise<string | undefined> {
  const conf = await tcpDialog(host, port, timeoutMs, [
    { send: Buffer.from('conf'), waitFor: /clientPort=|dataDir=|serverId=/i, label: 'conf' },
  ]);
  if (conf.ok) return conf.text;
  const envi = await tcpDialog(host, port, timeoutMs, [
    { send: Buffer.from('envi'), waitFor: /Environment:|java\.home=|user\.dir=/i, label: 'envi' },
  ]);
  return envi.ok ? envi.text : undefined;
}

function zookeeperProbe(): Tester {
  return async ({ host, port, timeoutMs }) => {
    const read = await zookeeperReadProbe(host, port, timeoutMs);
    if (read.success) return read;
    const info = await zookeeperFourLetter(host, port, timeoutMs);
    if (info) return { success: true, message: 'zookeeper_four_letter_info', banner: info.slice(0, 300) };
    return read;
  };
}

function httpGet(opts: { path: string; ok: RegExp; authFailed?: RegExp }): Tester {
  return ({ host, port, timeoutMs }) => new Promise(resolve => {
    const req = http.get({
      host,
      port,
      path: opts.path,
      timeout: timeoutMs,
      headers: { 'User-Agent': 'SASP-Scanner', Accept: 'application/json,*/*' },
    }, res => {
      const chunks: Buffer[] = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8').slice(0, 4096);
        if ((res.statusCode || 0) < 400 && opts.ok.test(body)) {
          resolve({ success: true, banner: body.slice(0, 200), message: 'unauth' });
        } else if ((res.statusCode === 401 || res.statusCode === 403) || opts.authFailed?.test(body)) {
          resolve({ success: false, message: 'auth_failed' });
        } else {
          resolve({ success: false, message: `http_${res.statusCode}` });
        }
      });
      res.on('error', e => resolve({ success: false, message: String(e.message || e).slice(0, 200) }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ success: false, message: 'timeout' }); });
    req.on('error', e => resolve({ success: false, message: String(e.message || e).slice(0, 200) }));
  });
}

export const testMemcached: Tester = async ({ host, port, timeoutMs }) => {
  const stats = await tcpDialog(host, port, timeoutMs, [
    { send: Buffer.from('stats items\r\n'), waitFor: /END\r\n|STAT items:/i, label: 'stats_items' },
  ]);
  const slab = stats.text.match(/STAT items:(\d+):number\s+[1-9]\d*/i)?.[1];
  if (!slab) return { success: false, message: stats.ok ? 'memcached_stats_only' : stats.label };
  const dump = await tcpDialog(host, port, timeoutMs, [
    { send: Buffer.from(`stats cachedump ${slab} 5\r\n`), waitFor: /END\r\n|ITEM\s+/i, label: 'cachedump' },
  ]);
  const key = dump.text.match(/^ITEM\s+(\S+)/im)?.[1];
  if (!key) return { success: false, message: 'memcached_no_keys_readable' };
  const got = await tcpDialog(host, port, timeoutMs, [
    { send: Buffer.from(`get ${key}\r\n`), waitFor: /END\r\n|VALUE\s+/i, label: 'get' },
  ]);
  if (/VALUE\s+/i.test(got.text)) {
    return { success: true, message: 'memcached_data_read', banner: `key=${key}, ${got.text.slice(0, 160)}` };
  }
  return { success: false, message: 'memcached_key_names_only' };
};
export const testZookeeper: Tester = zookeeperProbe();
export const testKafka: Tester = kafkaMetadataProbe();

export const testEtcd: Tester = httpGet({
  path: '/v2/keys/?recursive=false',
  ok: /"node"\s*:|"action"\s*:|"kvs"\s*:/i,
  authFailed: /user name is empty|permission denied|authentication/i,
});

export const testNeo4j: Tester = httpBasicAuth({
  path: '/db/data/',
  successCheck: (status, body) => status === 200 && /neo4j_version|node|relationship|extensions/i.test(body),
  authFailedCheck: status => status === 401 || status === 403,
});

export const testRabbitmq: Tester = httpBasicAuth({
  path: '/api/overview',
  successCheck: (status, body) => status === 200 && /"rabbitmq_version"|"management_version"/i.test(body),
  authFailedCheck: status => status === 401 || status === 403,
});
