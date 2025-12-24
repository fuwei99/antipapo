// OpenAI 格式转换工具
import config from '../../config/config.js';
import { extractSystemInstruction, fetchText, fetchImageBase64 } from '../utils.js';
import { convertOpenAIToolsToAntigravity } from '../toolConverter.js';
import {
  getSignatureContext,
  pushUserMessage,
  findFunctionNameById,
  pushFunctionResponse,
  createThoughtPart,
  createFunctionCallPart,
  processToolName,
  pushModelMessage,
  buildRequestBody,
  modelMapping,
  isEnableThinking,
  generateGenerationConfig
} from './common.js';

function extractImagesFromContent(content) {
  const result = { text: '', images: [] };
  if (typeof content === 'string') {
    result.text = content;
    return result;
  }
  if (Array.isArray(content)) {
    for (const item of content) {
      if (item.type === 'text') {
        result.text += item.text;
      } else if (item.type === 'image_url') {
        const imageUrl = item.image_url?.url || '';
        const match = imageUrl.match(/^data:image\/(\w+);base64,(.+)$/);
        if (match) {
          result.images.push({
            inlineData: {
              mimeType: `image/${match[1]}`,
              data: match[2]
            }
          });
        }
      }
    }
  }
  return result;
}

function handleAssistantMessage(message, antigravityMessages, enableThinking, actualModelName, sessionId) {
  const hasToolCalls = message.tool_calls && message.tool_calls.length > 0;
  const hasContent = message.content && message.content.trim() !== '';
  const { reasoningSignature, toolSignature } = getSignatureContext(sessionId, actualModelName);

  const toolCalls = hasToolCalls
    ? message.tool_calls.map(toolCall => {
      const safeName = processToolName(toolCall.function.name, sessionId, actualModelName);
      const signature = enableThinking ? (toolCall.thoughtSignature || toolSignature) : null;
      return createFunctionCallPart(toolCall.id, safeName, toolCall.function.arguments, signature);
    })
    : [];

  const parts = [];
  if (enableThinking) {
    const reasoningText = (typeof message.reasoning_content === 'string' && message.reasoning_content.length > 0)
      ? message.reasoning_content : ' ';
    parts.push(createThoughtPart(reasoningText));
  }
  if (hasContent) parts.push({ text: message.content.trimEnd(), thoughtSignature: message.thoughtSignature || reasoningSignature });
  if (!enableThinking && parts[0]) delete parts[0].thoughtSignature;

  pushModelMessage({ parts, toolCalls, hasContent }, antigravityMessages);
}

function handleToolCall(message, antigravityMessages) {
  const functionName = findFunctionNameById(message.tool_call_id, antigravityMessages);
  pushFunctionResponse(message.tool_call_id, functionName, message.content, antigravityMessages);
}

// 异步处理单条 User 消息
async function handleUserMessageAsync(message, antigravityMessages, pendingImages) {
  const extracted = extractImagesFromContent(message.content);

  // 如果有待处理图片（来自上一条 Assistant），注入到当前 User 消息
  if (pendingImages && pendingImages.length > 0) {
    const imageParts = pendingImages.map(img => ({
      inlineData: {
        mimeType: "image/jpeg",
        data: img
      }
    }));

    extracted.text = `Attached is the image you just generated\n${extracted.text}`;
    extracted.images.unshift(...imageParts);
    // 清空 pendingImages 数组内容
    pendingImages.length = 0;
  }

  pushUserMessage(extracted, antigravityMessages);
}

// 异步处理单条 Assistant 消息
async function handleAssistantMessageAsync(message, antigravityMessages, enableThinking, actualModelName, sessionId, shouldProcessSig) {
  let content = message.content || '';
  let currentSignature = null;
  const pendingImages = [];

  // 1. 并行下载任务列表
  const tasks = [];

  // 1.1 签名 URL 提取与下载任务
  if (shouldProcessSig && typeof content === 'string') {
    // 支持两种格式: <!-- SIG_URL: url --> 和 [](SIG_URL:url)
    const sigRegex = /<!-- SIG_URL: (https?:\/\/[^ ]+) -->|\[\]\(SIG_URL:(https?:\/\/[^)]+)\)/;
    const sigMatch = content.match(sigRegex);

    if (sigMatch) {
      const sigUrl = sigMatch[1] || sigMatch[2];
      // console.log(`[DEBUG] 发现签名 URL: ${sigUrl}`);
      const task = fetchText(sigUrl).then(sig => {
        if (sig) currentSignature = sig;
      });
      tasks.push(task);

      // 移除签名标记
      content = content.replace(sigMatch[0], '');
    }
  }

  // 1.2 图片 URL 提取与下载任务
  const imgRegex = /!\[.*?\]\((https?:\/\/[^)]+)\)/g;
  const imgMatches = typeof content === 'string' ? [...content.matchAll(imgRegex)] : [];

  if (imgMatches.length > 0) {
    // console.log(`[DEBUG] 发现 ${imgMatches.length} 个图片链接`);
    // 保持图片顺序
    const imageTasks = imgMatches.map(async (match) => {
      const url = match[1];
      const base64 = await fetchImageBase64(url);
      return base64;
    });

    tasks.push(Promise.all(imageTasks).then(images => {
      images.forEach(img => {
        if (img) pendingImages.push(img);
      });
    }));
  }

  // 等待所有下载完成
  if (tasks.length > 0) {
    await Promise.all(tasks);
  }

  // 更新 message content (已移除签名)
  const messageCopy = { ...message, content };

  // 调用原有同步逻辑处理剩余部分
  const hasToolCalls = messageCopy.tool_calls && messageCopy.tool_calls.length > 0;
  const hasContent = messageCopy.content && messageCopy.content.trim() !== '';
  // 注意：这里我们需要把 fetch 到的 currentSignature 传递进去，但原有 handleAssistantMessage 内部是去 cache 读的。
  // 为了支持恢复，我们需要修改 handleAssistantMessage 或者在这里手动构造 parts。
  // 鉴于 handleAssistantMessage 比较复杂，我们扩展它支持传入 signature。

  // 复用 common.js 中的逻辑，但我们需要手动覆盖 signature
  const { toolSignature } = getSignatureContext(sessionId, actualModelName); // reasoningSignature 优先使用下载的

  const toolCalls = hasToolCalls
    ? messageCopy.tool_calls.map(toolCall => {
      const safeName = processToolName(toolCall.function.name, sessionId, actualModelName);
      // 如果 enableThinking 且有 currentSignature，优先使用下载的签名（通常工具调用此时会带上）
      // 但通常图片生成后的签名是 reasoningSignature。
      const signature = enableThinking ? (toolCall.thoughtSignature || toolSignature) : null;
      return createFunctionCallPart(toolCall.id, safeName, toolCall.function.arguments, signature);
    })
    : [];

  const parts = [];
  if (enableThinking) {
    const reasoningText = (typeof messageCopy.reasoning_content === 'string' && messageCopy.reasoning_content.length > 0)
      ? messageCopy.reasoning_content : ' ';
    parts.push(createThoughtPart(reasoningText));
  }

  // 使用下载的签名覆盖
  const finalSignature = currentSignature || messageCopy.thoughtSignature || getSignatureContext(sessionId, actualModelName).reasoningSignature;

  if (hasContent) parts.push({ text: messageCopy.content.trimEnd(), thoughtSignature: finalSignature });
  if (!enableThinking && parts[0]) delete parts[0].thoughtSignature;

  pushModelMessage({ parts, toolCalls, hasContent }, antigravityMessages);

  return pendingImages;
}

async function openaiMessageToAntigravity(openaiMessages, enableThinking, actualModelName, sessionId) {
  const antigravityMessages = [];
  let pendingImages = [];

  // 判断是否需要处理签名
  const shouldProcessSig = actualModelName && (actualModelName.includes('image') || actualModelName.endsWith('-sig'));

  for (const message of openaiMessages) {
    if (message.role === 'user' || message.role === 'system') {
      await handleUserMessageAsync(message, antigravityMessages, pendingImages);
      pendingImages = []; // 清空
    } else if (message.role === 'assistant') {
      const newImages = await handleAssistantMessageAsync(message, antigravityMessages, enableThinking, actualModelName, sessionId, shouldProcessSig);
      if (newImages && newImages.length > 0) {
        pendingImages = newImages;
      }
    } else if (message.role === 'tool') {
      handleToolCall(message, antigravityMessages);
    }
  }
  //console.log(JSON.stringify(antigravityMessages,null,2));
  return antigravityMessages;
}

export async function generateRequestBody(openaiMessages, modelName, parameters, openaiTools, token) {
  const enableThinking = isEnableThinking(modelName);
  const actualModelName = modelMapping(modelName);
  const mergedSystemInstruction = extractSystemInstruction(openaiMessages);

  let filteredMessages = openaiMessages;
  let startIndex = 0;
  if (config.useContextSystemPrompt) {
    for (let i = 0; i < openaiMessages.length; i++) {
      if (openaiMessages[i].role === 'system') {
        startIndex = i + 1;
      } else {
        filteredMessages = openaiMessages.slice(startIndex);
        break;
      }
    }
  }

  const contents = await openaiMessageToAntigravity(filteredMessages, enableThinking, actualModelName, token.sessionId);

  return buildRequestBody({
    contents: contents,
    tools: convertOpenAIToolsToAntigravity(openaiTools, token.sessionId, actualModelName),
    generationConfig: generateGenerationConfig(parameters, enableThinking, actualModelName),
    sessionId: token.sessionId,
    systemInstruction: mergedSystemInstruction
  }, token, actualModelName);
}
