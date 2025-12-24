import tokenManager from '../auth/token_manager.js';
import config from '../config/config.js';
import { getUserOrSharedToken } from '../admin/user_manager.js';
import r2Uploader from '../utils/r2_uploader.js';
import logger from '../utils/logger.js';

export async function generateAssistantResponse(requestBody, tokenSource, callback, retryCount = 0, originalModelName = '') {
  // 最大重试次数为 Token 总数
  const MAX_RETRIES = tokenManager.tokens.length;

  let token;

  if (tokenSource && tokenSource.type === 'user') {
    // 用户 API Key - 使用用户自己的 Token 或共享 Token
    token = await getUserOrSharedToken(tokenSource.userId);
    if (!token) {
      throw new Error('没有可用的 Token。请在用户中心添加 Google Token 或使用共享 Token');
    }
  } else {
    // 管理员密钥 - 使用管理员 Token 池
    token = await tokenManager.getToken();
    if (!token) {
      throw new Error('没有可用的token，请运行 npm run login 获取token');
    }
  }

  const url = config.api.url;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Host': config.api.host,
      'User-Agent': config.api.userAgent,
      'Authorization': `Bearer ${token.access_token}`,
      'Content-Type': 'application/json',
      'Accept-Encoding': 'gzip'
    },
    body: JSON.stringify(requestBody)
  });

  if (!response.ok) {
    const errorText = await response.text();
    if (response.status === 403 || response.status === 429) {
      if (retryCount >= MAX_RETRIES) {
        logger.error(`达到最大重试次数 (${MAX_RETRIES})，停止重试`);
        throw new Error(`API请求失败 (${response.status}): ${errorText} (已重试 ${MAX_RETRIES} 次)`);
      }

      // 尝试处理错误（切换 Token）
      const newToken = await tokenManager.handleRequestError({ statusCode: response.status }, token.access_token);

      // 如果获取到了新 Token（且不是同一个），或者即使是同一个但我们想重试（针对 429 等待后重试的情况，虽然这里 handleRequestError 会切换）
      // 关键是 handleRequestError 会切换 currentIndex。
      // 我们检查 newToken 是否有效。

      if (newToken) {
        logger.info(`切换到新 Token，准备重试请求 (重试次数: ${retryCount + 1}/${MAX_RETRIES})...`);

        // 增加延迟，避免瞬间发起大量请求
        await new Promise(resolve => setTimeout(resolve, 10000));

        // 递归重试
        return generateAssistantResponse(requestBody, { type: 'admin' }, callback, retryCount + 1, originalModelName);
      }

      if (response.status === 403) {
        tokenManager.disableCurrentToken(token);
        throw new Error(`该账号没有使用权限，已自动禁用。错误详情: ${errorText}`);
      }
    }
    throw new Error(`API请求失败 (${response.status}): ${errorText}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let thinkingStarted = false;
  let toolCalls = [];
  const uploadPromises = [];

  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    // 使用 stream: true 选项，以正确处理多字节字符
    buffer += decoder.decode(value, { stream: true });

    let newlineIndex;
    // 循环处理 buffer 中的每一行
    while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIndex).trim();
      buffer = buffer.slice(newlineIndex + 1);

      if (line.startsWith('data: ')) {
        const jsonStr = line.slice(6);
        try {
          const data = JSON.parse(jsonStr);
          const parts = data.response?.candidates?.[0]?.content?.parts;

          if (parts) {
            for (const part of parts) {
              // 独立检查 thoughtSignature，不依赖于 part.thought === true
              // 仅针对包含 'image' 或以 '-sig' 结尾的模型启用签名上传
              // 使用 originalModelName 进行判断，因为 requestBody.model 可能已经被去除了后缀
              const modelToCheck = originalModelName || requestBody.model;
              const shouldUploadSig = modelToCheck && (modelToCheck.includes('image') || modelToCheck.endsWith('-sig'));
              const signature = part.thoughtSignature || part.thought_signature;

              if (signature && r2Uploader.isEnabled() && shouldUploadSig) {
                const filename = `sig_${Date.now()}_${Math.random().toString(36).substring(2)}.txt`;

                // 异步上传签名
                const uploadPromise = r2Uploader.uploadText(signature, filename).then(url => {
                  if (url) {
                    logger.info(`思维签名上传成功: ${url}`);
                    // 以 Markdown 注释形式返回签名 URL
                    const sigMarkdown = `\n<!-- SIG_URL: ${url} -->\n`;
                    callback({ type: 'text', content: sigMarkdown });
                  }
                }).catch(err => {
                  logger.error(`签名上传失败: ${err.message}`);
                });
                uploadPromises.push(uploadPromise);
              }

              if (part.thought === true) {
                callback({ type: 'thinking', content: part.text || '' });
              } else if (part.text !== undefined) {
                callback({ type: 'text', content: part.text });
              } else if (part.functionCall) {
                toolCalls.push({
                  id: part.functionCall.id,
                  type: 'function',
                  function: {
                    name: part.functionCall.name,
                    arguments: JSON.stringify(part.functionCall.args)
                  }
                });
              } else if (part.inlineData) {
                // 处理图片数据
                logger.info('检测到图片数据 (inlineData)');
                const { mimeType, data: base64Data } = part.inlineData;

                if (r2Uploader.isEnabled()) {
                  // 异步上传图片，并添加到 Promise 列表
                  const uploadPromise = r2Uploader.uploadImage(base64Data, mimeType).then(url => {
                    if (url) {
                      logger.info(`图片上传成功，回调 URL: ${url}`);
                      const markdown = `\n![Image](${url})\n`;
                      callback({ type: 'text', content: markdown });
                    } else {
                      logger.error('图片上传返回 URL 为空');
                    }
                  }).catch(err => {
                    logger.error(`图片上传过程出错: ${err.message}`);
                  });
                  uploadPromises.push(uploadPromise);
                } else {
                  logger.warn('R2 上传未启用，图片将被丢弃');
                }
              }
            }
          }

          // 当遇到 finishReason 时，发送所有收集的工具调用
          if (data.response?.candidates?.[0]?.finishReason && toolCalls.length > 0) {
            callback({ type: 'tool_calls', tool_calls: toolCalls });
            toolCalls = [];
          }
        } catch (e) {
          // 忽略解析错误
        }
      }
    }
  }

  // 等待所有图片上传完成
  if (uploadPromises.length > 0) {
    logger.info(`等待 ${uploadPromises.length} 个图片上传任务完成...`);
    await Promise.all(uploadPromises);
    logger.info('所有图片上传任务已完成');
  }
}

export async function getAvailableModels(tokenSource) {
  let token;

  if (tokenSource && tokenSource.type === 'user') {
    // 用户 API Key - 使用用户自己的 Token 或共享 Token
    token = await getUserOrSharedToken(tokenSource.userId);
    if (!token) {
      throw new Error('没有可用的 Token。请在用户中心添加 Google Token 或使用共享 Token');
    }
  } else {
    // 管理员密钥 - 使用管理员 Token 池
    token = await tokenManager.getToken();
    if (!token) {
      // 尝试强制刷新一次
      logger.warn('Token池为空，尝试强制刷新...');
      tokenManager.loadTokens(true);
      token = await tokenManager.getToken();

      if (!token) {
        throw new Error('没有可用的token，请运行 npm run login 获取token');
      }
    }
  }

  const response = await fetch(config.api.modelsUrl, {
    method: 'POST',
    headers: {
      'Host': config.api.host,
      'User-Agent': config.api.userAgent,
      'Authorization': `Bearer ${token.access_token}`,
      'Content-Type': 'application/json',
      'Accept-Encoding': 'gzip'
    },
    body: JSON.stringify({})
  });

  const data = await response.json();

  const modelList = Object.keys(data.models).map(id => ({
    id,
    object: 'model',
    created: Math.floor(Date.now() / 1000),
    owned_by: 'google'
  }));

  // 检查是否存在 gemini-3-pro-image
  const hasProImage = modelList.some(model => model.id === 'gemini-3-pro-image');

  if (hasProImage) {
    // 添加 2k 和 4k 虚拟模型
    modelList.push({
      id: 'gemini-3-pro-image-2k',
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'google'
    });
    modelList.push({
      id: 'gemini-3-pro-image-4k',
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'google'
    });
  }

  return {
    object: 'list',
    data: modelList
  };
}
