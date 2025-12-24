// Claude 格式转换工具
import config from '../../config/config.js';
import { convertClaudeToolsToAntigravity } from '../toolConverter.js';
import { downloadImage, downloadText } from '../imageDownloader.js';
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
  mergeSystemInstruction,
  modelMapping,
  isEnableThinking,
  generateGenerationConfig
} from './common.js';

// 匹配 markdown 图片语法: ![alt](url)
const MD_IMAGE_REGEX = /!\[.*?\]\((https?:\/\/[^\s)]+)\)/g;

async function extractImagesFromClaudeContent(content) {
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
        result.text += processText(item.text || '');
      } else if (item.type === 'image') {
        const source = item.source;
        if (source && source.type === 'base64' && source.data) {
          result.images.push({
            inlineData: {
              mimeType: source.media_type || 'image/png',
              data: source.data
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

async function handleClaudeAssistantMessage(message, antigravityMessages, enableThinking, actualModelName, sessionId) {
  const content = message.content;
  const { reasoningSignature, toolSignature } = getSignatureContext(sessionId, actualModelName);

  // 匹配隐藏的思维标签文件: [](url) 且以 .txt 结尾
  const MD_TXT_REGEX = /\[\]\((https?:\/\/[^\s)]+\.txt)\)/g;

  let textContent = '';
  const toolCalls = [];
  let restoredSignature = null;
  const tasks = [];

  if (typeof content === 'string') {
    textContent = content;
    // 提取签名链接
    const txtMatches = [...textContent.matchAll(MD_TXT_REGEX)];
    if (txtMatches.length > 0) {
      const [fullMatch, url] = txtMatches[0];
      const sig = await downloadText(url);
      if (sig) restoredSignature = sig.trim();
      textContent = textContent.replace(fullMatch, '').trim();
    }
  } else if (Array.isArray(content)) {
    for (const item of content) {
      if (item.type === 'text') {
        let t = item.text || '';
        // 简单处理：假设文本块里含有签名链接
        const txtMatches = [...t.matchAll(MD_TXT_REGEX)];
        if (txtMatches.length > 0) {
          const [fullMatch, url] = txtMatches[0];
          // 这里为了简化流程，我们await下载
          const sig = await downloadText(url);
          if (sig) restoredSignature = sig.trim();
          t = t.replace(fullMatch, '').trim();
        }
        textContent += t;
      } else if (item.type === 'tool_use') {
        const safeName = processToolName(item.name, sessionId, actualModelName);
        const signature = enableThinking ? toolSignature : null;
        toolCalls.push(createFunctionCallPart(item.id, safeName, JSON.stringify(item.input || {}), signature));
      }
    }
  }

  const hasContent = textContent && textContent.trim() !== '';
  const parts = [];

  if (enableThinking) {
    parts.push(createThoughtPart(' '));
  }

  const finalSignature = restoredSignature || reasoningSignature;

  if (hasContent) parts.push({ text: textContent.trimEnd(), thoughtSignature: finalSignature });
  if (!enableThinking && parts[0]) delete parts[0].thoughtSignature;

  pushModelMessage({ parts, toolCalls, hasContent }, antigravityMessages);
}

function handleClaudeToolResult(message, antigravityMessages) {
  const content = message.content;
  if (!Array.isArray(content)) return;

  for (const item of content) {
    if (item.type !== 'tool_result') continue;

    const toolUseId = item.tool_use_id;
    const functionName = findFunctionNameById(toolUseId, antigravityMessages);

    let resultContent = '';
    if (typeof item.content === 'string') {
      resultContent = item.content;
    } else if (Array.isArray(item.content)) {
      resultContent = item.content.filter(c => c.type === 'text').map(c => c.text).join('');
    }

    pushFunctionResponse(toolUseId, functionName, resultContent, antigravityMessages);
  }
}

async function claudeMessageToAntigravity(claudeMessages, enableThinking, actualModelName, sessionId) {
  const antigravityMessages = [];
  for (const message of claudeMessages) {
    if (message.role === 'user') {
      const content = message.content;
      if (Array.isArray(content) && content.some(item => item.type === 'tool_result')) {
        handleClaudeToolResult(message, antigravityMessages);
      } else {
        const extracted = await extractImagesFromClaudeContent(content);
        pushUserMessage(extracted, antigravityMessages);
      }
    } else if (message.role === 'assistant') {
      await handleClaudeAssistantMessage(message, antigravityMessages, enableThinking, actualModelName, sessionId);
    }
  }
  return antigravityMessages;
}

export async function generateClaudeRequestBody(claudeMessages, modelName, parameters, claudeTools, systemPrompt, token) {
  const enableThinking = isEnableThinking(modelName);
  const actualModelName = modelMapping(modelName);
  const mergedSystem = mergeSystemInstruction(config.systemInstruction || '', systemPrompt);

  const contents = await claudeMessageToAntigravity(claudeMessages, enableThinking, actualModelName, token.sessionId);

  return buildRequestBody({
    contents,
    tools: convertClaudeToolsToAntigravity(claudeTools, token.sessionId, actualModelName),
    generationConfig: generateGenerationConfig(parameters, enableThinking, actualModelName),
    sessionId: token.sessionId,
    systemInstruction: mergedSystem
  }, token, actualModelName);
}
