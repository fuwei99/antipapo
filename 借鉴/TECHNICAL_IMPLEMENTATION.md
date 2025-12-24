# 技术路线：思维标签与图片的长上下文 R2 集成方案

本文档详细阐述了本项目如何通过 Cloudflare R2 对象存储，解决 Gemini 模型在多轮对话中丢失 `thought_signature`（导致 400 错误）以及实现长上下文图片编辑（基于生成的图片进行修改）的技术实现路径。

## 1. 核心挑战

Gemini 的高级模型（如 `gemini-3-pro-image` 或带有 `thinking` 功能的模型）具有以下特性：
1.  **思维链签名 (Thought Signature)**: 模型在生成回答前会进行“思考”，并返回一个加密的 `thought_signature`。在下一轮对话中，必须将此签名原样传回，否则 API 会报错 `INVALID_ARGUMENT`。
2.  **图片生成**: 模型生成的图片以 Base64 `inlineData` 形式返回。
3.  **OpenAI 协议限制**: OpenAI 的 Chat Completion 接口标准中没有字段来承载 `thought_signature`，且直接在历史记录中传递巨大的 Base64 图片会导致上下文极其臃肿甚至超出 Token 限制。

## 2. 解决方案架构

我们采用 **"R2 中转 + Markdown 隐写"** 的策略：
*   **上行 (Response)**: 拦截 Gemini 响应 -> 提取签名/图片 -> 上传 R2 -> 替换为 Markdown 链接 -> 返回给客户端。
*   **下行 (Request)**: 解析客户端历史消息 -> 提取 Markdown 链接 -> 下载 R2 内容 -> 还原 Base64/签名 -> 重组 Gemini Payload。

---

## 3. 详细技术流程

### 第一阶段：响应处理 (Server -> Client)

**涉及文件**: `src/api/client.js`, `src/utils/r2_uploader.js`

当 Gemini API 返回流式数据（SSE）时，服务器作为代理进行实时拦截和处理。

1.  **流式解析**:
    *   `generateAssistantResponse` 函数监听数据流。
    *   使用 `TextDecoder` 和缓冲区机制处理可能被截断的 JSON 数据块。

2.  **思维签名提取与上传**:
    *   **检测**: 检查数据块中是否存在 `thoughtSignature` (或 `thought_signature`) 字段。
    *   **过滤**: 仅针对特定模型（包含 `image` 或以 `-sig` 结尾）启用此逻辑。
    *   **上传**: 调用 `r2Uploader.uploadText(signature, filename)` 将签名文本上传到 R2。
    *   **注入**: 上传成功后，生成一个隐形的 Markdown 注释 `<!-- SIG_URL: https://... -->`，并通过 SSE 发送给客户端。客户端用户看不到它，但它会保存在客户端的对话历史中。

3.  **图片提取与上传**:
    *   **检测**: 检查数据块中是否存在 `inlineData` (Base64 图片)。
    *   **上传**: 调用 `r2Uploader.uploadImage(base64Data, mimeType)` 将图片上传到 R2。
    *   **注入**: 上传成功后，生成标准的 Markdown 图片链接 `![Image](https://...)` 发送给客户端。这既展示了图片，又保留了图片的远程引用。

### 第二阶段：请求重组 (Client -> Server)

**涉及文件**: `src/utils/utils.js`, `src/server/index.js`

当用户发起新一轮对话时，客户端会将包含上述 Markdown 链接的历史记录发送给服务器。

1.  **历史消息遍历**:
    *   `generateRequestBody` 调用 `openaiMessageToAntigravity` 处理消息数组。
    *   函数被改造为 `async`，以支持网络下载。

2.  **思维签名还原 (Signature Restoration)**:
    *   **正则匹配**: 在 `assistant` 消息中查找 `<!-- SIG_URL: (url) -->`。
    *   **下载**: 使用 `fetchText(url)` 从 R2 下载原始签名字符串。
    *   **重组**: 构造 Gemini 的 `model` 消息部分。
        *   **关键修正**: 将下载的签名注入到 `parts` 数组的第一个元素中，字段名为 `thoughtSignature` (驼峰命名)。
        *   示例结构：
          ```json
          {
            "role": "model",
            "parts": [{ "text": "...", "thoughtSignature": "RAW_SIGNATURE_STRING..." }]
          }
          ```
    *   **清理**: 从文本内容中移除 `<!-- SIG_URL... -->`，避免模型看到无关的注释。

3.  **图片回传与编辑 (Image Context Injection)**:
    *   **正则匹配**: 在 `assistant` 消息中查找 `![...](url)` 图片链接。
    *   **下载**: 使用 `fetchImageBase64(url)` 下载图片并转回 Base64。
    *   **暂存**: 将下载的 Base64 数据存入 `pendingImages` 队列。
    *   **注入策略 (Long Context Editing)**:
        *   Gemini 通常期望图片作为 User 的输入。
        *   因此，我们将暂存的图片**移动到下一条 User 消息**中。
        *   在 User 消息的 `parts` 中添加 `inlineData` 节点。
        *   自动添加提示词 `"Attached is the image you just generated"`，引导模型关注该图片。

### 4. 关键组件实现细节

#### R2Uploader (`src/utils/r2_uploader.js`)
*   封装了 AWS SDK v3 (`@aws-sdk/client-s3`)。
*   `uploadText`: 设置 `ContentType: 'text/plain'`，用于签名。
*   `uploadImage`: 设置正确的 MIME 类型，用于图片。
*   自动处理文件名生成（UUID/时间戳）和目录结构。

#### 异步流处理 (`src/api/client.js`)
*   引入了 `retryCount` 和 `MAX_RETRIES` (等于 Token 总数) 机制，防止在 429/403 错误时无限循环。
*   使用 `originalModelName` 参数透传原始模型名称，防止因后缀剥离导致签名上传逻辑失效。

## 总结

通过这种**“以 URL 换空间，以 Hook 换状态”**的技术路线，我们成功地：
1.  **解决了 400 错误**: 满足了 Gemini 对 `thought_signature` 的严格要求。
2.  **实现了图片编辑**: 让无状态的 HTTP 请求能够携带上一轮生成的图片上下文。
3.  **优化了传输**: 避免了在客户端和服务器之间反复传输巨大的 Base64 数据，仅传输轻量级的 URL。