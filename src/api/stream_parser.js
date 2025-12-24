import memoryManager, { registerMemoryPoolCleanup } from '../utils/memoryManager.js';
import { generateToolCallId } from '../utils/idGenerator.js';
import { setReasoningSignature, setToolSignature } from '../utils/thoughtSignatureCache.js';
import { getOriginalToolName } from '../utils/toolNameCache.js';

// 预编译的常量（避免重复创建字符串）
const DATA_PREFIX = 'data: ';
const DATA_PREFIX_LEN = DATA_PREFIX.length;

// 高效的行分割器（零拷贝，避免 split 创建新数组）
// 使用对象池复用 LineBuffer 实例
class LineBuffer {
  constructor() {
    this.buffer = '';
    this.lines = [];
  }

  // 追加数据并返回完整的行
  append(chunk) {
    this.buffer += chunk;
    this.lines.length = 0; // 重用数组

    let start = 0;
    let end;
    while ((end = this.buffer.indexOf('\n', start)) !== -1) {
      this.lines.push(this.buffer.slice(start, end));
      start = end + 1;
    }

    // 保留未完成的部分
    this.buffer = start < this.buffer.length ? this.buffer.slice(start) : '';
    return this.lines;
  }

  clear() {
    this.buffer = '';
    this.lines.length = 0;
  }
}

// LineBuffer 对象池
const lineBufferPool = [];
const getLineBuffer = () => {
  const buffer = lineBufferPool.pop();
  if (buffer) {
    buffer.clear();
    return buffer;
  }
  return new LineBuffer();
};
const releaseLineBuffer = (buffer) => {
  const maxSize = memoryManager.getPoolSizes().lineBuffer;
  if (lineBufferPool.length < maxSize) {
    buffer.clear();
    lineBufferPool.push(buffer);
  }
};

// toolCall 对象池
const toolCallPool = [];
const getToolCallObject = () => toolCallPool.pop() || { id: '', type: 'function', function: { name: '', arguments: '' } };
const releaseToolCallObject = (obj) => {
  const maxSize = memoryManager.getPoolSizes().toolCall;
  if (toolCallPool.length < maxSize) toolCallPool.push(obj);
};

// 注册内存清理回调（供外部统一调用）
function registerStreamMemoryCleanup() {
  registerMemoryPoolCleanup(toolCallPool, () => memoryManager.getPoolSizes().toolCall);
  registerMemoryPoolCleanup(lineBufferPool, () => memoryManager.getPoolSizes().lineBuffer);
}

// 转换 functionCall 为 OpenAI 格式（使用对象池）
// 会尝试将安全工具名还原为原始工具名
function convertToToolCall(functionCall, sessionId, model) {
  const toolCall = getToolCallObject();
  toolCall.id = functionCall.id || generateToolCallId();
  let name = functionCall.name;
  if (sessionId && model) {
    const original = getOriginalToolName(sessionId, model, functionCall.name);
    if (original) name = original;
  }
  toolCall.function.name = name;
  toolCall.function.arguments = JSON.stringify(functionCall.args);
  return toolCall;
}

// 解析并发送流式响应片段（会修改 state 并触发 callback）
// 支持 DeepSeek 格式：思维链内容通过 reasoning_content 字段输出
// 同时透传 thoughtSignature，方便客户端后续复用
function parseAndEmitStreamChunk(line, state, callback) {
  if (!line.startsWith(DATA_PREFIX)) return;

  try {
    const data = JSON.parse(line.slice(DATA_PREFIX_LEN));
    const parts = data.response?.candidates?.[0]?.content?.parts;

    if (parts) {
      for (const part of parts) {
        // 全局检测 thoughtSignature并更新状态
        let currentPartSignature = null;
        if (part.thoughtSignature) {
          state.reasoningSignature = part.thoughtSignature;
          currentPartSignature = part.thoughtSignature;
          if (state.sessionId && state.model) {
            setReasoningSignature(state.sessionId, state.model, part.thoughtSignature);
          }
          // 即使没有 text/thought，也应该触发一次回调以便 client.js 能捕获签名
          // 但通常签名会附带在某种 content 上。
        }

        if (part.thought === true) {
          callback({
            type: 'reasoning',
            reasoning_content: part.text || '',
            thoughtSignature: currentPartSignature || state.reasoningSignature || null
          });
        } else if (part.text !== undefined) {
          callback({
            type: 'text',
            content: part.text,
            thoughtSignature: currentPartSignature // 传递签名给 text 类型
          });
        } else if (part.functionCall) {
          const toolCall = convertToToolCall(part.functionCall, state.sessionId, state.model);
          if (part.thoughtSignature) {
            toolCall.thoughtSignature = part.thoughtSignature;
            if (state.sessionId && state.model) {
              setToolSignature(state.sessionId, state.model, part.thoughtSignature);
            }
          }
          state.toolCalls.push(toolCall);
        } else if (part.inlineData) {
          // Detected inline image data
          callback({
            type: 'image_data',
            data: part.inlineData.data,
            mimeType: part.inlineData.mimeType,
            thoughtSignature: currentPartSignature // 传递签名给 image 类型
          });
        }

        // 如果只有签名而没有任何 content 类型匹配 (罕见情况)，我们可以发一个特殊的 event?
        // 目前 client.js 里只处理 text, reasoning, image_data 的回调用于上传。
        // 如果签名单独作为一个 part (不带 text/thought/inlineData)，上面的逻辑会漏掉吗？
        // 假设 part 至少有一个 key. 如果只有 thoughtSignature? 
        // 应该加一个兜底。
        if (currentPartSignature && !part.text && !part.thought && !part.functionCall && !part.inlineData) {
          callback({
            type: 'signature_only',
            thoughtSignature: currentPartSignature
          });
        }
      }
    }

    if (data.response?.candidates?.[0]?.finishReason) {
      if (state.toolCalls.length > 0) {
        callback({ type: 'tool_calls', tool_calls: state.toolCalls });
        state.toolCalls = [];
      }
      const usage = data.response?.usageMetadata;
      if (usage) {
        callback({
          type: 'usage',
          usage: {
            prompt_tokens: usage.promptTokenCount || 0,
            completion_tokens: usage.candidatesTokenCount || 0,
            total_tokens: usage.totalTokenCount || 0
          }
        });
      }
    }
  } catch {
    // 忽略 JSON 解析错误
  }
}

export {
  getLineBuffer,
  releaseLineBuffer,
  parseAndEmitStreamChunk,
  convertToToolCall,
  registerStreamMemoryCleanup,
  releaseToolCallObject
};
