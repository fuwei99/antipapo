/**
 * OpenAI API 路由
 * 处理 /v1/chat/completions 和 /v1/models 端点
 */

import { Router } from 'express';
import { getAvailableModels } from '../api/client.js';
import { handleOpenAIRequest } from '../server/handlers/openai.js';
import logger from '../utils/logger.js';

const router = Router();

/**
 * GET /v1/models
 * 获取可用模型列表
 */
router.get('/models', async (req, res) => {
  try {
    const models = await getAvailableModels();
    res.json(models);
  } catch (error) {
    logger.error('获取模型列表失败:', error.message);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /v1/chat/completions
 * 处理聊天补全请求
 */
router.post('/chat/completions', handleOpenAIRequest);

export default router;