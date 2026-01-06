// 签名缓存（FIFO / 环形队列）：
// - 按 model 维度缓存“最近 N 个”思维链签名与工具签名（各自独立队列）
// - 自动先进先出：超过容量自动挤掉最旧的
// - 不使用 TTL/定时/内存压力主动清理（仅靠容量上限控制内存）

class SignatureRing {
  constructor(capacity) {
    this.capacity = Math.max(1, capacity | 0);
    this.buffer = new Array(this.capacity);
    this.size = 0;
    this.start = 0;
  }

  latest() {
    if (this.size <= 0) return null;
    const idx = (this.start + this.size - 1) % this.capacity;
    return this.buffer[idx] || null;
  }

  push(signature) {
    if (!signature) return;
    // 去重：避免同一个签名重复入队造成无意义占用
    if (this.latest() === signature) return;

    if (this.size < this.capacity) {
      const idx = (this.start + this.size) % this.capacity;
      this.buffer[idx] = signature;
      this.size++;
      return;
    }

    // 满了：覆盖最旧元素（start），然后 start 前移
    this.buffer[this.start] = signature;
    this.start = (this.start + 1) % this.capacity;
  }

  clear() {
    // 释放引用，便于 GC
    for (let i = 0; i < this.size; i++) {
      this.buffer[(this.start + i) % this.capacity] = undefined;
    }
    this.size = 0;
    this.start = 0;
  }
}

const reasoningSignaturesByModel = new Map(); // model -> SignatureRing
const toolSignaturesByModel = new Map(); // model -> SignatureRing

// 上限：模型维度 & 每个模型保留的签名数量
const MAX_MODEL_ENTRIES = 16;
const MAX_SIGNATURES_PER_MODEL = 3;

function makeModelKey(model) {
  if (!model) return null;
  const raw = String(model);
  // 生图模型会带分辨率后缀（例如 `-4K` / `-2K`），但实际请求时会被剥离为基础模型名。
  // 为避免缓存 miss（从而导致无法为历史消息自动补签名），这里统一按“基础模型名”缓存。
  return raw.replace(/-(?:1k|2k|4k|8k)$/i, '');
}

function pruneModelMapIfNeeded(map) {
  if (map.size <= MAX_MODEL_ENTRIES) return;
  const removeCount = map.size - MAX_MODEL_ENTRIES;
  let removed = 0;
  for (const key of map.keys()) {
    map.delete(key);
    removed++;
    if (removed >= removeCount) break;
  }
}

function getOrCreateRing(map, modelKey) {
  let ring = map.get(modelKey);
  if (!ring) {
    ring = new SignatureRing(MAX_SIGNATURES_PER_MODEL);
    map.set(modelKey, ring);
    pruneModelMapIfNeeded(map);
  }
  return ring;
}

function getLatestSignature(map, modelKey) {
  if (!modelKey) return null;
  const ring = map.get(modelKey);
  return ring ? ring.latest() : null;
}

function pushSignature(map, modelKey, signature) {
  if (!modelKey || !signature) return;
  const ring = getOrCreateRing(map, modelKey);
  ring.push(signature);
}

export function setReasoningSignature(sessionId, model, signature) {
  if (!signature || !model) return;
  // sessionId 参数保留仅为兼容现有调用方，不参与缓存 key
  pushSignature(reasoningSignaturesByModel, makeModelKey(model), signature);
}

export function getReasoningSignature(sessionId, model) {
  return getLatestSignature(reasoningSignaturesByModel, makeModelKey(model));
}

export function setToolSignature(sessionId, model, signature) {
  if (!signature || !model) return;
  // sessionId 参数保留仅为兼容现有调用方，不参与缓存 key
  pushSignature(toolSignaturesByModel, makeModelKey(model), signature);
}

export function getToolSignature(sessionId, model) {
  return getLatestSignature(toolSignaturesByModel, makeModelKey(model));
}

// 预留：手动清理接口（目前未在外部使用，但方便将来扩展）
export function clearThoughtSignatureCaches() {
  for (const ring of reasoningSignaturesByModel.values()) ring?.clear?.();
  for (const ring of toolSignaturesByModel.values()) ring?.clear?.();
  reasoningSignaturesByModel.clear();
  toolSignaturesByModel.clear();
}
