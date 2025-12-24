# Cloudflare R2 集成技术文档

本文档详细说明了本项目如何集成 Cloudflare R2 对象存储，用于持久化保存 AI 生成的图片和思维链签名。

## 1. 概述

本项目使用 Cloudflare R2（兼容 AWS S3 协议的对象存储）来存储：
1.  **AI 生成的图片**：模型生成的图片通常以 Base64 格式返回，直接传输效率低且不便持久化。系统将其上传至 R2 并替换为公共 URL。
2.  **思维链签名 (Thought Signatures)**：部分模型生成的思维链包含加密签名，系统将其作为文本文件上传保存。

## 2. 配置说明

R2 的配置位于 `config.json` 文件中（由 `src/config/config.js` 加载）。

### 配置结构
```json
{
  "r2": {
    "enabled": true,
    "bucketName": "your-bucket-name",
    "accountId": "your-cloudflare-account-id",
    "accessKeyId": "your-access-key-id",
    "secretAccessKey": "your-secret-access-key",
    "publicUrl": "https://your-custom-domain.com"
  }
}
```

*   **enabled**: 开关，设置为 `true` 启用上传功能。
*   **bucketName**: R2 存储桶名称。
*   **accountId**: Cloudflare 账户 ID。
*   **accessKeyId** & **secretAccessKey**: R2 API 凭证。
*   **publicUrl**: 绑定到存储桶的公共访问域名（用于生成访问链接）。

## 3. 核心实现 (`src/utils/r2_uploader.js`)

该模块封装了一个 `R2Uploader` 类，使用 `@aws-sdk/client-s3` 库与 R2 进行交互。

### 3.1 初始化
*   在构造函数中读取配置。
*   使用 `S3Client` 初始化客户端，Endpoint 格式为 `https://{accountId}.r2.cloudflarestorage.com`。
*   如果配置不完整，会自动禁用上传功能并记录警告。

### 3.2 图片上传 (`uploadImage`)
*   **输入**: Base64 编码的图片数据, MIME 类型。
*   **文件命名策略**:
    *   计算图片内容的 MD5 哈希（前16位）。
    *   结合当前时间戳。
    *   路径格式: `images/YYYYMM/{hash}_{timestamp}.{ext}`。
    *   这种策略既避免了文件名冲突，又利用哈希实现了简单的去重（虽然加上时间戳后文件名总是唯一的，但哈希有助于识别内容）。
*   **缓存策略**: `Cache-Control: public, max-age=31536000` (1年)。
*   **输出**: 图片的完整公共 URL。

### 3.3 文本/签名上传 (`uploadText`)
*   **输入**: 文本内容, 文件名建议。
*   **路径格式**: `signatures/{filename}`。
*   **缓存策略**: `Cache-Control: public, max-age=2592000` (30天)。
*   **输出**: 文本文件的完整公共 URL。

## 4. 业务集成 (`src/api/client.js`)

在 `generateAssistantResponse` 函数中，系统处理来自 AI 模型的流式响应，并实时拦截特定数据进行上传。

### 4.1 处理流程

1.  **流式解析**: 读取 API 返回的 SSE (Server-Sent Events) 数据流。
2.  **检测图片**:
    *   检查响应对象中的 `inlineData` 字段。
    *   如果 R2 已启用，调用 `r2Uploader.uploadImage(base64Data, mimeType)`。
    *   **异步处理**: 上传过程是异步的，不会阻塞流的读取。
    *   **回调替换**: 上传成功后，通过回调函数发送 Markdown 图片语法 `![Image](url)` 给客户端。
3.  **检测签名**:
    *   检查响应对象中的 `thoughtSignature` 字段。
    *   如果满足条件（特定模型且 R2 启用），调用 `r2Uploader.uploadText`。
    *   上传成功后，发送隐藏的 Markdown 注释 `<!-- SIG_URL: url -->` 给客户端。
4.  **并发控制**:
    *   所有上传 Promise 被收集到 `uploadPromises` 数组中。
    *   在函数结束前，使用 `Promise.all(uploadPromises)` 确保所有后台上传任务完成，防止进程过早退出导致上传中断。

## 5. 依赖库

*   `@aws-sdk/client-s3`: AWS 官方 S3 SDK，用于连接 Cloudflare R2。
*   `crypto`: Node.js 内置模块，用于生成文件哈希。

## 6. 错误处理

*   如果 R2 未配置或初始化失败，上传操作会被跳过，系统会记录警告日志。
*   如果上传过程中发生网络错误，错误会被捕获并记录日志，不会导致整个对话请求崩溃。