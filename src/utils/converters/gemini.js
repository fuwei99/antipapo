// Gemini 格式转换工具
import config from '../../config/config.js';
import { generateRequestId } from '../idGenerator.js';
import { convertGeminiToolsToAntigravity } from '../toolConverter.js';
import { getSignatureContext, createThoughtPart, modelMapping, isEnableThinking } from './common.js';
import { normalizeGeminiParameters, toGenerationConfig } from '../parameterNormalizer.js';
import { fetchText, fetchImageBase64 } from '../utils.js';

/**
 * 为 functionCall 生成唯一 ID
 */
function generateFunctionCallId() {
  return `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * 处理 functionCall 和 functionResponse 的 ID 匹配
 */
function processFunctionCallIds(contents) {
  const functionCallIds = [];

  // 收集所有 functionCall 的 ID
  contents.forEach(content => {
    if (content.role === 'model' && content.parts && Array.isArray(content.parts)) {
      content.parts.forEach(part => {
        if (part.functionCall) {
          if (!part.functionCall.id) {
            part.functionCall.id = generateFunctionCallId();
          }
          functionCallIds.push(part.functionCall.id);
        }
      });
    }
  });

  // 为 functionResponse 分配对应的 ID
  let responseIndex = 0;
  contents.forEach(content => {
    if (content.role === 'user' && content.parts && Array.isArray(content.parts)) {
      content.parts.forEach(part => {
        if (part.functionResponse) {
          if (!part.functionResponse.id && responseIndex < functionCallIds.length) {
            part.functionResponse.id = functionCallIds[responseIndex];
            responseIndex++;
          }
        }
      });
    }
  });
}

/**
 * 处理 model 消息中的 thought 和签名
 */
function processModelThoughts(content, reasoningSignature, toolSignature) {
  const parts = content.parts;

  // 查找 thought 和独立 thoughtSignature 的位置
  let thoughtIndex = -1;
  let signatureIndex = -1;
  let signatureValue = null;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part.thought === true && !part.thoughtSignature) {
      thoughtIndex = i;
    }
    if (part.thoughtSignature && !part.thought) {
      signatureIndex = i;
      signatureValue = part.thoughtSignature;
    }
  }

  // 合并或添加 thought 和签名
  if (thoughtIndex !== -1 && signatureIndex !== -1) {
    parts[thoughtIndex].thoughtSignature = signatureValue;
    parts.splice(signatureIndex, 1);
  } else if (thoughtIndex !== -1 && signatureIndex === -1) {
    parts[thoughtIndex].thoughtSignature = reasoningSignature;
  } else if (thoughtIndex === -1) {
    parts.unshift(createThoughtPart(' ', reasoningSignature));
  }

  // 收集独立的签名 parts（用于 functionCall）
  const standaloneSignatures = [];
  for (let i = parts.length - 1; i >= 0; i--) {
    const part = parts[i];
    if (part.thoughtSignature && !part.thought && !part.functionCall && !part.text) {
      standaloneSignatures.unshift({ index: i, signature: part.thoughtSignature });
    }
  }

  // 为 functionCall 分配签名
  let sigIndex = 0;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part.functionCall && !part.thoughtSignature) {
      if (sigIndex < standaloneSignatures.length) {
        part.thoughtSignature = standaloneSignatures[sigIndex].signature;
        sigIndex++;
      } else {
        part.thoughtSignature = toolSignature;
      }
    }
  }

  // 移除已使用的独立签名 parts
  for (let i = standaloneSignatures.length - 1; i >= 0; i--) {
    if (i < sigIndex) {
      parts.splice(standaloneSignatures[i].index, 1);
    }
  }
}


// 递归处理 Gemini 格式内容，支持下载图片和签名
async function processGeminiContentAsync(requestContents, enableThinking, actualModelName, sessionId) {
  if (!requestContents || !Array.isArray(requestContents)) return;

  const shouldProcessSig = actualModelName && (actualModelName.includes('image') || actualModelName.endsWith('-sig'));

  // 并行处理每一条消息
  // 注意：Gemini 格式中，图片通常作为 part 的 inlineData 或 fileData 存在，
  // 但我们这里主要处理 text part 中包含的 markdown 链接。
  console.log(`[DEBUG] ${new Date().toISOString()} 开始处理 Gemini 内容, 消息数量: ${requestContents.length}, Model: ${actualModelName}`);

  for (const content of requestContents) {
    if (!content.parts || !Array.isArray(content.parts)) continue;

    console.log(`[DEBUG] ${new Date().toISOString()} 处理消息 role: ${content.role}, parts数量: ${content.parts.length}`);

    const newParts = [];
    const tasks = [];
    let currentSignature = null;
    const pendingImages = []; // 对应 markdown 图片下载后的 inlineData parts

    for (const part of content.parts) {
      if (typeof part.text === 'string') {
        let text = part.text;

        // 1.1 签名 URL 提取与下载任务
        if (shouldProcessSig) {
          const sigRegex = /<!-- SIG_URL: (https?:\/\/[^ ]+) -->|\[\]\(SIG_URL:(https?:\/\/[^)]+)\)/;
          const sigMatch = text.match(sigRegex);
          if (sigMatch) {
            const sigUrl = sigMatch[1] || sigMatch[2];
            tasks.push(fetchText(sigUrl).then(sig => {
              if (sig) currentSignature = sig;
            }));
            text = text.replace(sigMatch[0], '');
          }
        }

        // 1.2 图片 URL 提取与下载任务
        const imgRegex = /!\[.*?\]\((https?:\/\/[^)]+)\)/g;
        const imgMatches = [...text.matchAll(imgRegex)];

        if (imgMatches.length > 0) {
          console.log(`[DEBUG] ${new Date().toISOString()} 发现 ${imgMatches.length} 个图片链接`);
          const imageTasks = imgMatches.map(async (match) => {
            const url = match[1];
            console.log(`[DEBUG] ${new Date().toISOString()} 准备下载图片: ${url}`);
            const base64 = await fetchImageBase64(url);
            if (base64) {
              console.log(`[DEBUG] ${new Date().toISOString()} 图片下载成功, 长度: ${base64.length}`);
              return {
                inlineData: {
                  mimeType: "image/jpeg",
                  data: base64
                }
              };
            } else {
              console.error(`[ERROR] ${new Date().toISOString()} 图片下载失败: ${url}`);
            }
            return null;
          });

          tasks.push(Promise.all(imageTasks).then(images => {
            images.forEach(img => {
              if (img) pendingImages.push(img);
            });
            console.log(`[DEBUG] ${new Date().toISOString()} 本批次成功下载图片数: ${pendingImages.length}`);
          }));
        } else {
          console.log(`[DEBUG] ${new Date().toISOString()} 未发现图片链接, 文本片段: ${text.substring(0, 50)}...`);
        }

        // 修改后的文本 part
        part.text = text;
      }
      newParts.push(part);
    }

    // 等待下载完成
    if (tasks.length > 0) {
      await Promise.all(tasks);
    }

    // 注入图片 part (Gemini 不区分 User/Model 图片位置，通常追加在 text 后面或作为独立 part)
    // 如果是 model 回复中的图片，理论上不应该作为输入发回去？
    // 不，multiturn dialog 中 model 的回复包含图片，下一轮 turn 需要带上。
    // 但是 gemini api 中 model role 的 parts 通常只包含 text (functionCall 除外)，不支持 inlineData?
    // 实际上 Gemini 1.5 Pro/Flash 支持 model 输出图片，但输入时 model role 是否支持 inlineData 存疑。
    // 安全起见，如果是 user role，直接追加。如果是 model role，可能需要忽略图片或咨询文档。
    // 这里假设 restore 上下文主要针对 User 发送的历史（包含之前 Model 生成的图片）。
    // 但按照对话历史，图片是 Model 生成的，所以是在 Model role 下。
    // 如果 Model role 不支持 inlineData，那我们无法直接恢复图片上下文给 Model？
    // 实际上，Gemini 的 history 中 model role 确实主要是 text/functionCall.
    // 但如果是 User 引用了图片，或者是 User 上传的图片，则是 User role.
    // 对于生图模型，图片是 Model 产出的。
    // 如果 API 不允许 Model role 带 inlineData，我们可能只能把 text 恢复，图片无法完美恢复到 Model role 下。
    // 不过，根据 Antipapo 的逻辑，我们转换成 Google 内部 API 格式，可能支持。
    // 暂时将 pendingImages 追加到 parts 末尾。
    if (pendingImages.length > 0) {
      console.log(`[DEBUG] ${new Date().toISOString()} 准备将 ${pendingImages.length} 个图片 part 注入到消息中`);
      // 关键修复: API 要求 model 历史中的图片 part 必须携带 thoughtSignature
      if (currentSignature) {
        console.log(`[DEBUG] ${new Date().toISOString()} 为图片 part 附加签名: ${currentSignature.substring(0, 20)}...`);
        pendingImages.forEach(img => {
          img.thoughtSignature = currentSignature;
        });
        content.parts.push(...pendingImages);
      } else {
        console.warn(`[WARN] ${new Date().toISOString()} 图片 part 缺少签名 (currentSignature is null), 跳过注入以防止 400 错误`);
        // 不注入 pendingImages，避免 API 报错
      }
    }

    // 如果获取到了签名，尝试注入
    if (currentSignature && enableThinking && content.role === 'model') {
      // 注入到 thoughtSignature
      // 找到 thought part 或创建
      let thoughtPart = content.parts.find(p => p.thought === true);
      if (thoughtPart) {
        thoughtPart.thoughtSignature = currentSignature;
      } else {
        // 尝试找第一个 text part
        const textPart = content.parts.find(p => p.text !== undefined);
        if (textPart) {
          textPart.thoughtSignature = currentSignature;
        } else {
          // 建一个新的
          content.parts.unshift(createThoughtPart(' ', currentSignature));
        }
      }
    }
  }

  processFunctionCallIds(requestContents); // 保持原有 ID 处理

  if (enableThinking) {
    const { reasoningSignature, toolSignature } = getSignatureContext(sessionId, actualModelName);

    requestContents.forEach(content => {
      if (content.role === 'model' && content.parts && Array.isArray(content.parts)) {
        // 如果前面 currentSignature 已经注入了，processModelThoughts 会怎么处理？
        // processModelThoughts 优先使用 parts 中的 thoughtSignature.
        processModelThoughts(content, reasoningSignature, toolSignature);
      }
    });
  }
}

export async function generateGeminiRequestBody(geminiBody, modelName, token) {
  const enableThinking = isEnableThinking(modelName);
  const actualModelName = modelMapping(modelName);
  const request = JSON.parse(JSON.stringify(geminiBody));

  if (request.contents && Array.isArray(request.contents)) {
    // 替换原有的 processFunctionCallIds 和 processModelThoughts 调用
    // 改为统一的异步处理
    await processGeminiContentAsync(request.contents, enableThinking, actualModelName, token.sessionId);
  }

  // 使用统一参数规范化模块处理 Gemini 格式参数
  const normalizedParams = normalizeGeminiParameters(request.generationConfig || {});

  // 转换为 generationConfig 格式
  request.generationConfig = toGenerationConfig(normalizedParams, enableThinking, actualModelName);
  request.sessionId = token.sessionId;
  delete request.safetySettings;

  // 转换工具定义
  if (request.tools && Array.isArray(request.tools)) {
    request.tools = convertGeminiToolsToAntigravity(request.tools, token.sessionId, actualModelName);
  }

  // 添加工具配置
  if (request.tools && request.tools.length > 0 && !request.toolConfig) {
    request.toolConfig = { functionCallingConfig: { mode: 'VALIDATED' } };
  }

  const existingText = request.systemInstruction?.parts?.[0]?.text || '';
  const mergedText = existingText ? `${config.systemInstruction}\n\n${existingText}` : config.systemInstruction ?? "";
  request.systemInstruction = {
    role: 'user',
    parts: [{ text: mergedText }]
  };

  //console.log(JSON.stringify(request, null, 2))

  const requestBody = {
    project: token.projectId,
    requestId: generateRequestId(),
    request: request,
    model: actualModelName,
    userAgent: 'antigravity'
  };

  return requestBody;
}
