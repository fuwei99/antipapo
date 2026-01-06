// 工具名称映射缓存：按 model + safeName 维度
// 解决：发送到上游时工具名必须 sanitize，返回时需要还原为原始工具名

import memoryManager from './memoryManager.js';

// safeKey: `${model}::${safeName}` -> { originalName, ts }
const toolNameMap = new Map();

const MAX_ENTRIES = 16;
const ENTRY_TTL_MS = 30 * 60 * 1000;      // 30 分钟

function makeKey(model, safeName) {
  return `${model || ''}::${safeName || ''}`;
}

function pruneSize(targetSize) {
  if (toolNameMap.size <= targetSize) return;
  const removeCount = toolNameMap.size - targetSize;
  let removed = 0;
  for (const key of toolNameMap.keys()) {
    toolNameMap.delete(key);
    removed++;
    if (removed >= removeCount) break;
  }
}

function pruneExpired(now) {
  for (const [key, entry] of toolNameMap.entries()) {
    if (!entry || typeof entry.ts !== 'number') continue;
    if (now - entry.ts > ENTRY_TTL_MS) {
      toolNameMap.delete(key);
    }
  }
}

// 定时清理由 memoryManager 统一触发（避免每个模块单独 setInterval 扫描）
memoryManager.registerCleanup(() => {
  const now = Date.now();
  pruneExpired(now);
  pruneSize(MAX_ENTRIES);
});

export function setToolNameMapping(model, safeName, originalName) {
  if (!safeName || !originalName || safeName === originalName) return;
  const key = makeKey(model, safeName);
  toolNameMap.set(key, { originalName, ts: Date.now() });
  pruneSize(MAX_ENTRIES);
}

export function getOriginalToolName(model, safeName) {
  if (!safeName) return null;
  const key = makeKey(model, safeName);
  const entry = toolNameMap.get(key);
  if (!entry) return null;
  const now = Date.now();
  if (typeof entry.ts === 'number' && now - entry.ts > ENTRY_TTL_MS) {
    toolNameMap.delete(key);
    return null;
  }
  return entry.originalName || null;
}

export function clearToolNameMappings() {
  toolNameMap.clear();
}
