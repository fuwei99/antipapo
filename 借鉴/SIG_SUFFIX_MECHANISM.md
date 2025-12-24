# `-sig` 后缀模型机制详解

本文档详细解释了本项目中 `-sig` 后缀（例如 `gemini-3-pro-high-sig`）的设计初衷、工作原理以及在系统中的完整流转过程。

## 1. 设计初衷

Gemini 的某些高级模型（特别是 Thinking 模型）在多轮对话中强制要求回传 `thought_signature`。然而，并非所有用户或所有场景都需要这个功能，且上传签名到 R2 会产生额外的网络开销和存储成本。

为了灵活控制这一行为，我们引入了虚拟的 `-sig` 后缀机制：
*   **默认行为**：普通模型名称（如 `gemini-3-pro-high`）**不**触发签名上传逻辑。
*   **启用签名**：带有 `-sig` 后缀的模型名称（如 `gemini-3-pro-high-sig`）**强制开启**签名提取与上传逻辑。
*   **自动识别**：包含 `image` 的模型（如 `gemini-3-pro-image`）默认开启签名上传（因为图片生成通常伴随着复杂的推理过程，且需要长上下文编辑）。

## 2. 工作原理与流转过程

整个机制涉及请求预处理、API 调用、响应拦截三个关键环节。

### 2.1 请求预处理 (Request Pre-processing)

**涉及文件**: `src/utils/utils.js`, `src/server/index.js`

当客户端发起请求时（例如请求 `gemini-3-pro-high-sig`）：

1.  **后缀剥离**:
    *   在 `generateRequestBody` 函数中，系统检测到 `-sig` 后缀。
    *   系统将后缀剥离，得到真实的模型名称 `gemini-3-pro-high`。这是为了确保发给 Google API 的模型名称是有效的（Google 不认识 `-sig` 后缀）。
    *   代码逻辑：
        ```javascript
        if (modelName.endsWith('-sig')) {
          actualModelName = modelName.slice(0, -4);
        }
        ```

2.  **原始名称透传**:
    *   虽然 `requestBody.model` 变成了真实名称，但我们需要保留原始名称以供后续判断。
    *   在 `src/server/index.js` 中，调用 `generateAssistantResponse` 时，将原始的 `model` 变量（包含 `-sig`）作为参数传递进去。
    *   代码逻辑：
        ```javascript
        // src/server/index.js
        await generateAssistantResponse(requestBody, req.tokenSource, callback, 0, model);
        ```

### 2.2 响应拦截与签名上传 (Response Interception)

**涉及文件**: `src/api/client.js`

当 Google API 返回流式响应时，系统需要在**不阻塞流式输出**的前提下，完成签名的提取、上传和 URL 注入。这是一个并发处理的关键点。

1.  **判断逻辑**:
    *   `generateAssistantResponse` 函数接收到了 `originalModelName` 参数。
    *   系统使用这个原始名称来判断是否需要开启签名上传逻辑。
    *   判断条件：模型名称包含 `image` **或者** 以 `-sig` 结尾。
    *   代码逻辑：
        ```javascript
        // src/api/client.js
        const modelToCheck = originalModelName || requestBody.model;
        const shouldUploadSig = modelToCheck && (modelToCheck.includes('image') || modelToCheck.endsWith('-sig'));
        ```

2.  **流式处理与异步上传 (Streaming & Async Upload)**:
    *   **实时转发**: 当收到 Google 的 SSE 数据块（chunk）时，如果包含文本内容 (`part.text`)，系统会**立即**通过 `callback` 将其发送给客户端。这保证了用户体验的流畅性，不会因为后台在上传文件而感到卡顿。
    *   **签名捕获**: 同时，系统检查数据块中是否包含 `thoughtSignature`。
    *   **异步上传**: 一旦捕获到签名，系统**不会等待**，而是立即启动一个异步上传任务 (`r2Uploader.uploadText`)。
    *   **Promise 队列**: 这个上传任务的 Promise 被推入一个 `uploadPromises` 数组中。
    *   **URL 注入**: 当上传任务完成（Promise resolve）时，回调函数会被触发。此时，系统构造一个包含签名 URL 的 Markdown 注释（`<!-- SIG_URL: ... -->`），并通过 `callback` 发送给客户端。
        *   **关键点**: 这个 Markdown 注释是作为流的一部分追加到响应末尾的。客户端收到后，会将其渲染在消息中（虽然是注释，用户不可见，但存在于历史记录中）。

3.  **流的终结控制**:
    *   在 Google 的数据流结束（`done` 为 true）后，系统**不能立即关闭**对客户端的响应流。
    *   系统必须等待 `uploadPromises` 中的所有任务完成。
    *   代码逻辑：
        ```javascript
        // src/api/client.js
        // 等待所有图片/签名上传完成
        if (uploadPromises.length > 0) {
          await Promise.all(uploadPromises);
        }
        // 只有在所有上传完成后，才认为响应彻底结束
        ```
    *   这确保了即使 Google 的流已经结束，只要签名还在上传，连接就保持打开，直到签名 URL 被发送给客户端。

### 2.3 下一轮对话的签名回传 (Signature Restoration)

**涉及文件**: `src/utils/utils.js`

当用户发起下一轮对话时，客户端会将包含 `<!-- SIG_URL: ... -->` 的历史记录发回服务器。

1.  **解析与下载**:
    *   `openaiMessageToAntigravity` 函数同样接收 `modelName` 参数。
    *   **无条件还原 (Unconditional Restoration)**: 无论当前使用的模型是什么（即使没有 `-sig` 后缀），只要历史消息中包含 `<!-- SIG_URL: ... -->`，系统**总是**尝试下载并还原签名。
    *   **目的**: 保证上下文的完整性。防止用户从 `model-sig` 切换回普通 `model` 时，丢失上一轮的 thinking context 导致 API 报错。

2.  **注入请求**:
    *   下载的签名被注入到 `model` 消息的 `parts` 中（字段名 `thoughtSignature`）。
    *   这样，Google API 就能收到它需要的签名，从而避免 400 错误。

## 3. 总结

`-sig` 后缀是一个**控制开关**。它允许用户在不修改代码的情况下，通过改变模型名称来动态开启或关闭“思维签名保持”功能。

*   **Client -> Server**: 请求 `model-sig`。
*   **Server -> Google**: 请求 `model` (去除后缀)。
*   **Google -> Server**: 返回响应 + 签名。
*   **Server**:
    *   实时转发文本内容给 Client。
    *   异步上传签名到 R2。
    *   上传完成后，追加 `<!-- SIG_URL -->` 给 Client。
    *   等待上传完成才关闭连接。
*   **Server -> Client**: 最终收到完整的响应 + 隐形签名链接。

这一机制完美解决了 OpenAI 协议无状态性与 Gemini 有状态特性之间的矛盾，同时通过异步并发处理保证了流式响应的低延迟体验。