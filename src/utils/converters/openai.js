// OpenAI 格式转换工具
import config from '../../config/config.js';
import { extractSystemInstruction } from '../utils.js';
import { convertOpenAIToolsToAntigravity } from '../toolConverter.js';
import { downloadImage } from '../imageDownloader.js';
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

// 匹配 markdown 图片语法: ![alt](url)
const MD_IMAGE_REGEX = /!\[.*?\]\((https?:\/\/[^\s)]+)\)/g;

async function extractImagesFromContent(content) {
  const result = { text: '', images: [] };
  const tasks = [];

  const processText = (text) => {
    // 查找所有 markdown 图片链接
    const matches = [...text.matchAll(MD_IMAGE_REGEX)];

    // 如果没有图片，直接返回原文本
    if (matches.length === 0) {
      return text;
    }

    let lastIndex = 0;
    let newText = '';

    for (const match of matches) {
      const [fullMatch, url] = match;
      const index = match.index;

      // 添加图片前的文本
      newText += text.slice(lastIndex, index);

      // 添加下载任务
      tasks.push(
        downloadImage(url).then(imgData => {
          if (imgData) {
            result.images.push({
              inlineData: {
                mimeType: imgData.mimeType,
                data: imgData.data
              }
            });
          }
        })
      );

      lastIndex = index + fullMatch.length;
    }

    // 添加剩余文本
    newText += text.slice(lastIndex);
    return newText;
  };

  if (typeof content === 'string') {
    result.text = processText(content);
  } else if (Array.isArray(content)) {
    for (const item of content) {
      if (item.type === 'text') {
        result.text += processText(item.text);
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

  // 等待所有图片下载完成
  await Promise.all(tasks);

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

async function openaiMessageToAntigravity(openaiMessages, enableThinking, actualModelName, sessionId) {
  const antigravityMessages = [];
  for (const message of openaiMessages) {
    if (message.role === 'user' || message.role === 'system') {
      const extracted = await extractImagesFromContent(message.content);
      pushUserMessage(extracted, antigravityMessages);
    } else if (message.role === 'assistant') {
      handleAssistantMessage(message, antigravityMessages, enableThinking, actualModelName, sessionId);
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
    contents,
    tools: convertOpenAIToolsToAntigravity(openaiTools, token.sessionId, actualModelName),
    generationConfig: generateGenerationConfig(parameters, enableThinking, actualModelName),
    sessionId: token.sessionId,
    systemInstruction: mergedSystemInstruction
  }, token, actualModelName);
}
