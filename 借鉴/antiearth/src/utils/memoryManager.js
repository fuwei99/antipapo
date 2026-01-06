/**
 * 轻量定时内存清理器
 * - 不再基于内存占用/阈值判断（避免频繁扫描与 GC 抖动）
 * - 仅按时间间隔触发各模块的清理回调（对象池裁剪、缓存清理等）
 * @module utils/memoryManager
 */

import logger from './logger.js';

// 对象池最大大小（固定值，不再随“压力”动态变化）
const POOL_SIZES = { chunk: 30, toolCall: 15, lineBuffer: 5 };

class MemoryManager {
  constructor() {
    /** @type {Set<Function>} */
    this.cleanupCallbacks = new Set();
    /** @type {NodeJS.Timeout|null} */
    this.timer = null;
    /** @type {number} */
    this.cleanupIntervalMs = 30 * 60 * 1000;
    this.isShuttingDown = false;
  }

  /**
   * 启动定时清理
   * @param {number} cleanupIntervalMs - 清理间隔（毫秒）
   */
  start(cleanupIntervalMs = 30 * 60 * 1000) {
    if (this.timer) return;
    this.setCleanupInterval(cleanupIntervalMs);
    this.isShuttingDown = false;
    logger.info(`内存清理器已启动（间隔: ${Math.round(this.cleanupIntervalMs / 1000)}秒）`);
  }

  /**
   * 动态调整清理间隔（热更新）
   * @param {number} cleanupIntervalMs
   */
  setCleanupInterval(cleanupIntervalMs) {
    if (Number.isFinite(cleanupIntervalMs) && cleanupIntervalMs > 0) {
      this.cleanupIntervalMs = Math.floor(cleanupIntervalMs);
    }

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    this.timer = setInterval(() => {
      if (!this.isShuttingDown) this.cleanup('timer');
    }, this.cleanupIntervalMs);

    this.timer.unref?.();
  }

  /**
   * 停止定时清理
   */
  stop() {
    this.isShuttingDown = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.cleanupCallbacks.clear();
    logger.info('内存清理器已停止');
  }

  /**
   * 注册清理回调
   * @param {(reason: string) => void} callback
   */
  registerCleanup(callback) {
    this.cleanupCallbacks.add(callback);
  }

  /**
   * 取消注册清理回调
   * @param {Function} callback
   */
  unregisterCleanup(callback) {
    this.cleanupCallbacks.delete(callback);
  }

  /**
   * 触发一次清理
   * @param {string} reason
   */
  cleanup(reason = 'manual') {
    for (const callback of this.cleanupCallbacks) {
      try {
        callback(reason);
      } catch (error) {
        logger.error('清理回调执行失败:', error.message);
      }
    }
  }

  /**
   * 获取对象池大小配置
   */
  getPoolSizes() {
    return POOL_SIZES;
  }
}

const memoryManager = new MemoryManager();
export default memoryManager;

// 统一封装：注册对象池裁剪（在定时清理触发时执行）
export function registerMemoryPoolCleanup(pool, getMaxSize) {
  memoryManager.registerCleanup(() => {
    const maxSize = getMaxSize();
    while (pool.length > maxSize) pool.pop();
  });
}
