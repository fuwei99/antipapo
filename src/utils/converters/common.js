// 转换器公共模块
import config from '../../config/config.js';
import { generateRequestId } from '../idGenerator.js';
import { getReasoningSignature, getToolSignature } from '../thoughtSignatureCache.js';
import { setToolNameMapping } from '../toolNameCache.js';
import { getThoughtSignatureForModel, getToolSignatureForModel, sanitizeToolName, modelMapping, isEnableThinking, generateGenerationConfig } from '../utils.js';

/**
 * 获取签名上下文
 * @param {string} sessionId - 会话 ID
 * @param {string} actualModelName - 实际模型名称
 * @returns {Object} 包含思维签名和工具签名的对象
 */
export function getSignatureContext(sessionId, actualModelName) {
  const cachedReasoningSig = getReasoningSignature(sessionId, actualModelName);
  const cachedToolSig = getToolSignature(sessionId, actualModelName);

  return {
    reasoningSignature: cachedReasoningSig || getThoughtSignatureForModel(actualModelName),
    toolSignature: cachedToolSig || getToolSignatureForModel(actualModelName)
  };
}

/**
 * 添加用户消息到 antigravityMessages
 * @param {Object} extracted - 提取的内容 { text, images }
 * @param {Array} antigravityMessages - 目标消息数组
 */
export function pushUserMessage(extracted, antigravityMessages) {
  const parts = [{ text: extracted.text }, ...extracted.images];
  // 如果提取到了思维签名，且当前是第一条 parts（通常是的），则绑定上去
  // 注意：Antigravity 或底层 API 是否支持 user 消息带 thoughtSignature 需要验证。
  // 假设这里我们模拟的是 model 给出的上下文恢复，通常这个 signature 应该是属于 *上一条* model 回复的。
  // 但用户的请求里带了这个，意味着这可能是 User 提供的 "Assistant 上一次的签名" 作为上下文。
  // 在 Antigravity 里，通常 signature 是附在 model 消息上的。
  // 按照需求 "发现思维链txt...并行下载"，恢复上下文。
  // 如果这个链接是在 user 消息里，那它应当代表 *User* 告诉 *Model* "这是你之前的签名"。
  // 但 Google API 一般要求 signature 在 model 消息里。
  // 如果我们是在恢复历史对话，这个 content 是属于 user 的还是 model 的？
  // 如果是 user 发送的消息包含这个链接，那就是 user message。
  // 如果是 history 中 model 的消息包含这个链接（因为我们之前 append 到了回复里），那它在 history 中会被解析为 model message。
  // *关键点*：我们的 converter 处理的是 "messages" 数组。
  // 如果是 `role: 'assistant'` (OpenAI) 或 `role: 'model'` (client.js输出后)，我们之前 append 的 `[](...)` 会在 content 里。
  // 所以我们需要修改的是 `handleAssistantMessage` 中的提取逻辑！
  // 等等，用户说 "针对image模型...直接把思维标签转txt上传...返回客户端"。
  // 客户端收到的是 Assistant 的回复。用户下次带上来的是 History。
  // History 里这条消息 role 是 assistant。
  // 所以我必须修改 `handleAssistantMessage` (OpenAI 转换器) 和 `handleClaudeAssistantMessage`。

  // 但是，我也修改了 `extractImagesFromContent`，它目前只在 role='user' | 'system' 时被调用 (Line 131 in openai.js)。
  // 这是一个重大发现。`extractImagesFromContent` 只用于 User 消息。
  // Assistant 消息的处理在 `handleAssistantMessage`。
  // 我需要检查 `handleAssistantMessage` 是否处理 markdown 图片/链接？
  // openai.js Line 47 `handleAssistantMessage` 直接使用 `message.content`。
  // 它没有调用 `extractImagesFromContent`。
  // 这意味着如果 history 里 assistant 消息带了 `[](.txt)`，目前的逻辑根本不会去下载它！

  // 修正计划：
  // 1. common.js 不需要改 user 消息处理（除非 user 也能带签名，暂不考虑）。
  // 2. 必须修改 `openai.js` 和 `claude.js` 的 `handleAssistantMessage/handleClaudeAssistantMessage`，
  //    让它们也能识别并提取 `thoughtSignature` 链接，并下载，然后赋值给 model message 的 parts。

  antigravityMessages.push({
    role: 'user',
    parts: parts
  });
}

/**
 * 根据工具调用 ID 查找函数名
 * @param {string} toolCallId - 工具调用 ID
 * @param {Array} antigravityMessages - 消息数组
 * @returns {string} 函数名
 */
export function findFunctionNameById(toolCallId, antigravityMessages) {
  for (let i = antigravityMessages.length - 1; i >= 0; i--) {
    if (antigravityMessages[i].role === 'model') {
      const parts = antigravityMessages[i].parts;
      for (const part of parts) {
        if (part.functionCall && part.functionCall.id === toolCallId) {
          return part.functionCall.name;
        }
      }
    }
  }
  return '';
}

/**
 * 添加函数响应到 antigravityMessages
 * @param {string} toolCallId - 工具调用 ID
 * @param {string} functionName - 函数名
 * @param {string} resultContent - 响应内容
 * @param {Array} antigravityMessages - 目标消息数组
 */
export function pushFunctionResponse(toolCallId, functionName, resultContent, antigravityMessages) {
  const lastMessage = antigravityMessages[antigravityMessages.length - 1];
  const functionResponse = {
    functionResponse: {
      id: toolCallId,
      name: functionName,
      response: { output: resultContent }
    }
  };

  if (lastMessage?.role === 'user' && lastMessage.parts.some(p => p.functionResponse)) {
    lastMessage.parts.push(functionResponse);
  } else {
    antigravityMessages.push({ role: 'user', parts: [functionResponse] });
  }
}

/**
 * 创建带签名的思维 part
 * @param {string} text - 思维文本
 * @param {string} signature - 签名
 * @returns {Object} 思维 part
 */
export function createThoughtPart(text) {
  return { text: text || ' ', thought: true }
}

/**
 * 创建带签名的函数调用 part
 * @param {string} id - 调用 ID
 * @param {string} name - 函数名（已清理）
 * @param {Object|string} args - 参数
 * @param {string} signature - 签名（可选）
 * @returns {Object} 函数调用 part
 */
export function createFunctionCallPart(id, name, args, signature = null) {
  const part = {
    functionCall: {
      id,
      name,
      args: typeof args === 'string' ? { query: args } : args
    }
  };
  if (signature) {
    part.thoughtSignature = signature;
  }
  return part;
}

/**
 * 处理工具名称映射
 * @param {string} originalName - 原始名称
 * @param {string} sessionId - 会话 ID
 * @param {string} actualModelName - 实际模型名称
 * @returns {string} 清理后的安全名称
 */
export function processToolName(originalName, sessionId, actualModelName) {
  const safeName = sanitizeToolName(originalName);
  if (sessionId && actualModelName && safeName !== originalName) {
    setToolNameMapping(sessionId, actualModelName, safeName, originalName);
  }
  return safeName;
}

/**
 * 添加模型消息到 antigravityMessages
 * @param {Object} options - 选项
 * @param {Array} options.parts - 消息 parts
 * @param {Array} options.toolCalls - 工具调用 parts
 * @param {boolean} options.hasContent - 是否有文本内容
 * @param {Array} antigravityMessages - 目标消息数组
 */
export function pushModelMessage({ parts, toolCalls, hasContent }, antigravityMessages) {
  const lastMessage = antigravityMessages[antigravityMessages.length - 1];
  const hasToolCalls = toolCalls && toolCalls.length > 0;

  if (lastMessage?.role === 'model' && hasToolCalls && !hasContent) {
    lastMessage.parts.push(...toolCalls);
  } else {
    const allParts = [...parts, ...(toolCalls || [])];
    antigravityMessages.push({ role: 'model', parts: allParts });
  }
  //console.log(JSON.stringify(antigravityMessages,null,2));
}

/**
 * 构建基础请求体
 * @param {Object} options - 选项
 * @param {Array} options.contents - 消息内容
 * @param {Array} options.tools - 工具列表
 * @param {Object} options.generationConfig - 生成配置
 * @param {string} options.sessionId - 会话 ID
 * @param {string} options.systemInstruction - 系统指令
 * @param {Object} token - Token 对象
 * @param {string} actualModelName - 实际模型名称
 * @returns {Object} 请求体
 */
export function buildRequestBody({ contents, tools, generationConfig, sessionId, systemInstruction }, token, actualModelName) {
  const requestBody = {
    project: token.projectId,
    requestId: generateRequestId(),
    request: {
      contents,
      tools: tools || [],
      toolConfig: { functionCallingConfig: { mode: 'VALIDATED' } },
      generationConfig,
      sessionId
    },
    model: actualModelName,
    userAgent: 'antigravity'
  };

  if (systemInstruction) {
    requestBody.request.systemInstruction = {
      role: 'user',
      parts: [{ text: systemInstruction }]
    };
  }

  return requestBody;
}

/**
 * 合并系统指令
 * @param {string} baseSystem - 基础系统指令
 * @param {string} contextSystem - 上下文系统指令
 * @returns {string} 合并后的系统指令
 */
export function mergeSystemInstruction(baseSystem, contextSystem) {
  if (!config.useContextSystemPrompt || !contextSystem) {
    return baseSystem || '';
  }

  const parts = [];
  if (baseSystem && typeof baseSystem === 'string' && baseSystem.trim()) parts.push(baseSystem.trim());
  if (contextSystem && typeof contextSystem === 'string' && contextSystem.trim()) parts.push(contextSystem.trim());
  return parts.join('\n\n');
}

// 重导出常用函数
export { sanitizeToolName, modelMapping, isEnableThinking, generateGenerationConfig };

// 重导出参数规范化函数
export {
  normalizeOpenAIParameters,
  normalizeClaudeParameters,
  normalizeGeminiParameters,
  normalizeParameters,
  toGenerationConfig
} from '../parameterNormalizer.js';
