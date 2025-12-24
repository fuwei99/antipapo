import { randomUUID } from 'crypto';
import config from '../config/config.js';

function generateRequestId() {
  return `agent-${randomUUID()}`;
}

function generateSessionId() {
  return String(-Math.floor(Math.random() * 9e18));
}

function generateProjectId() {
  const adjectives = ['useful', 'bright', 'swift', 'calm', 'bold'];
  const nouns = ['fuze', 'wave', 'spark', 'flow', 'core'];
  const randomAdj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const randomNoun = nouns[Math.floor(Math.random() * nouns.length)];
  const randomNum = Math.random().toString(36).substring(2, 7);
  return `${randomAdj}-${randomNoun}-${randomNum}`;
}
function extractImagesFromContent(content) {
  const result = { text: '', images: [] };

  // 如果content是字符串，直接返回
  if (typeof content === 'string') {
    result.text = content;
    return result;
  }

  // 如果content是数组（multimodal格式）
  if (Array.isArray(content)) {
    for (const item of content) {
      if (item.type === 'text') {
        result.text += item.text;
      } else if (item.type === 'image_url') {
        // 提取base64图片数据
        const imageUrl = item.image_url?.url || '';

        // 匹配 data:image/{format};base64,{data} 格式
        const match = imageUrl.match(/^data:image\/(\w+);base64,(.+)$/);
        if (match) {
          const format = match[1]; // 例如 png, jpeg, jpg
          const base64Data = match[2];
          result.images.push({
            inlineData: {
              mimeType: `image/${format}`,
              data: base64Data
            }
          })
        }
      }
    }
  }

  return result;
}
function handleUserMessage(extracted, antigravityMessages) {
  antigravityMessages.push({
    role: "user",
    parts: [
      {
        text: extracted.text
      },
      ...extracted.images
    ]
  })
}
function handleAssistantMessage(message, antigravityMessages, signature = null) {
  const lastMessage = antigravityMessages[antigravityMessages.length - 1];
  const hasToolCalls = message.tool_calls && message.tool_calls.length > 0;
  const hasContent = message.content && message.content.trim() !== '';

  const antigravityTools = hasToolCalls ? message.tool_calls.map(toolCall => ({
    functionCall: {
      id: toolCall.id,
      name: toolCall.function.name,
      args: {
        query: toolCall.function.arguments
      }
    }
  })) : [];

  // 如果需要注入签名，我们不能简单地追加到上一条消息，必须创建一个新的 model 消息
  // 除非上一条消息也是 model 且我们能找到合适的地方插入（这比较复杂，简单起见，有签名时总是新建消息）

  if (lastMessage?.role === "model" && hasToolCalls && !hasContent && !signature) {
    lastMessage.parts.push(...antigravityTools)
  } else {
    const parts = [];
    if (hasContent) parts.push({ text: message.content });
    parts.push(...antigravityTools);

    // 将签名注入到第一个 part
    if (signature && parts.length > 0) {
      parts[0].thoughtSignature = signature;
    }

    antigravityMessages.push({
      role: "model",
      parts
    })
  }
}
function handleToolCall(message, antigravityMessages) {
  // 从之前的 model 消息中找到对应的 functionCall name
  let functionName = '';
  for (let i = antigravityMessages.length - 1; i >= 0; i--) {
    if (antigravityMessages[i].role === 'model') {
      const parts = antigravityMessages[i].parts;
      for (const part of parts) {
        if (part.functionCall && part.functionCall.id === message.tool_call_id) {
          functionName = part.functionCall.name;
          break;
        }
      }
      if (functionName) break;
    }
  }

  const lastMessage = antigravityMessages[antigravityMessages.length - 1];
  const functionResponse = {
    functionResponse: {
      id: message.tool_call_id,
      name: functionName,
      response: {
        output: message.content
      }
    }
  };

  // 如果上一条消息是 user 且包含 functionResponse，则合并
  if (lastMessage?.role === "user" && lastMessage.parts.some(p => p.functionResponse)) {
    lastMessage.parts.push(functionResponse);
  } else {
    antigravityMessages.push({
      role: "user",
      parts: [functionResponse]
    });
  }
}
async function fetchText(url) {
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } catch (error) {
    console.error(`下载文本失败 ${url}:`, error);
    return null;
  }
}

async function fetchImageBase64(url) {
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer).toString('base64');
  } catch (error) {
    console.error(`下载图片失败 ${url}:`, error);
    return null;
  }
}

async function openaiMessageToAntigravity(openaiMessages, modelName) {
  const antigravityMessages = [];
  let pendingImages = [];

  // 判断是否需要处理签名（包含 image 或以 -sig 结尾）
  const shouldProcessSig = modelName && (modelName.includes('image') || modelName.endsWith('-sig'));

  for (const message of openaiMessages) {
    if (message.role === "user" || message.role === "system") {
      const extracted = extractImagesFromContent(message.content);

      // 如果有待处理的图片（来自上一条 Assistant 消息），注入到当前 User 消息
      if (pendingImages.length > 0 && message.role === "user") {
        const imageParts = pendingImages.map(img => ({
          inlineData: {
            mimeType: "image/jpeg", // 假设是 JPEG，或者可以从 URL 推断
            data: img
          }
        }));

        // 在文本前添加提示
        extracted.text = `Attached is the image you just generated\n${extracted.text}`;
        extracted.images.unshift(...imageParts);
        pendingImages = []; // 清空
      }

      handleUserMessage(extracted, antigravityMessages);
    } else if (message.role === "assistant") {
      let currentSignature = null;

      // 1. 处理签名 URL
      if (shouldProcessSig) {
        const sigMatch = message.content?.match(/<!-- SIG_URL: (https?:\/\/[^ ]+) -->/);
        if (sigMatch) {
          const sigUrl = sigMatch[1];
          console.log(`[DEBUG] 发现签名 URL: ${sigUrl}`);
          const signature = await fetchText(sigUrl);
          if (signature) {
            console.log(`[DEBUG] 签名下载成功，长度: ${signature.length}`);
            currentSignature = signature;
          } else {
            console.error(`[DEBUG] 签名下载失败或为空`);
          }
          // 从内容中移除签名注释
          message.content = message.content.replace(sigMatch[0], '');
        } else {
          // console.log(`[DEBUG] 未在 Assistant 消息中发现签名 URL`);
        }
      }

      // 2. 处理图片回传
      const imgMatches = [...message.content?.matchAll(/!\[.*?\]\((https?:\/\/[^)]+)\)/g)];
      if (imgMatches.length > 0) {
        console.log(`[DEBUG] 发现 ${imgMatches.length} 个图片链接`);
      }
      for (const match of imgMatches) {
        const imgUrl = match[1];
        console.log(`[DEBUG] 正在下载图片: ${imgUrl}`);
        const base64 = await fetchImageBase64(imgUrl);
        if (base64) {
          console.log(`[DEBUG] 图片下载成功，Base64 长度: ${base64.length}`);
          pendingImages.push(base64);
        } else {
          console.error(`[DEBUG] 图片下载失败`);
        }
      }

      handleAssistantMessage(message, antigravityMessages, currentSignature);
    } else if (message.role === "tool") {
      handleToolCall(message, antigravityMessages);
    }
  }

  return antigravityMessages;
}
function generateGenerationConfig(parameters, enableThinking, actualModelName) {
  const generationConfig = {
    topP: parameters.top_p ?? config.defaults.top_p,
    topK: parameters.top_k ?? config.defaults.top_k,
    temperature: parameters.temperature ?? config.defaults.temperature,
    candidateCount: 1,
    maxOutputTokens: parameters.max_tokens ?? config.defaults.max_tokens,
    stopSequences: [
      "<|user|>",
      "<|bot|>",
      "<|context_request|>",
      "<|endoftext|>",
      "<|end_of_turn|>"
    ],
    thinkingConfig: {
      includeThoughts: enableThinking,
      thinkingBudget: enableThinking ? 1024 : 0
    }
  }

  // 如果不启用思考，完全移除 thinkingConfig 字段，防止 API 报错
  if (!enableThinking) {
    delete generationConfig.thinkingConfig;
  }

  if (enableThinking && actualModelName.includes("claude")) {
    delete generationConfig.topP;
  }

  // 针对图片生成模型的特殊配置
  if (actualModelName.includes('image')) {
    generationConfig.responseModalities = ["TEXT", "IMAGE"];

    // 仅 gemini-3-pro-image 支持 imageSize 参数
    if (actualModelName.includes('gemini-3-pro-image')) {
      let imageSize = null;
      if (actualModelName.endsWith('-2k')) {
        imageSize = '2k';
      } else if (actualModelName.endsWith('-4k')) {
        imageSize = '4k';
      }

      // 只有当明确指定了尺寸时才添加 imageConfig
      if (imageSize) {
        generationConfig.imageConfig = {
          "imageSize": imageSize
        };
      }
    }
  }

  return generationConfig
}
function convertOpenAIToolsToAntigravity(openaiTools) {
  if (!openaiTools || openaiTools.length === 0) return [];
  return openaiTools.map((tool) => {
    delete tool.function.parameters.$schema;
    return {
      functionDeclarations: [
        {
          name: tool.function.name,
          description: tool.function.description,
          parameters: tool.function.parameters
        }
      ]
    }
  })
}
async function generateRequestBody(openaiMessages, modelName, parameters, openaiTools) {
  const enableThinking = modelName.endsWith('-thinking') ||
    modelName === 'gemini-2.5-pro' ||
    modelName.startsWith('gemini-3-pro-') ||
    modelName === "rev19-uic3-1p" ||
    modelName === "gpt-oss-120b-medium"
  let actualModelName = modelName;

  if (modelName.endsWith('-thinking') && !modelName.includes('opus')) {
    actualModelName = modelName.slice(0, -9);
  } else if (modelName.endsWith('-sig')) {
    actualModelName = modelName.slice(0, -4);
  }

  // 剥离尺寸后缀，以获取真实的模型名称
  if (actualModelName.startsWith('gemini-3-pro-image-')) {
    actualModelName = 'gemini-3-pro-image';
  }

  const contents = await openaiMessageToAntigravity(openaiMessages, modelName);

  return {
    project: generateProjectId(),
    requestId: generateRequestId(),
    request: {
      contents: contents,
      systemInstruction: {
        role: "user",
        parts: [{ text: config.systemInstruction }]
      },
      tools: convertOpenAIToolsToAntigravity(openaiTools),
      toolConfig: {
        functionCallingConfig: {
          mode: "VALIDATED"
        }
      },
      generationConfig: generateGenerationConfig(parameters, enableThinking, actualModelName),
      sessionId: generateSessionId()
    },
    model: actualModelName,
    userAgent: "antigravity"
  }
}
// HTML转义函数，防止XSS攻击
function escapeHtml(unsafe) {
  if (!unsafe) return '';
  return unsafe
    .toString()
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export {
  generateRequestId,
  generateSessionId,
  generateProjectId,
  generateRequestBody,
  escapeHtml
}
