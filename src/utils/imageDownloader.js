import axios from 'axios';
import logger from './logger.js';

const MAX_IMAGE_SIZE = 20 * 1024 * 1024; // 20MB limit
const ALLOWED_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

/**
 * 下载图片并转换为 Base64
 * @param {string} url - 图片 URL
 * @returns {Promise<{ mimeType: string, data: string } | null>}
 */
export async function downloadImage(url) {
    try {
        const response = await axios.get(url, {
            responseType: 'arraybuffer',
            maxContentLength: MAX_IMAGE_SIZE,
            timeout: 15000, // 15s timeout
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            }
        });

        const mimeType = response.headers['content-type'];
        if (!mimeType || !mimeType.startsWith('image/')) {
            logger.warn(`URL returned non-image content type: ${mimeType} for ${url}`);
            return null;
        }

        // 简单校验一下是否在允许列表中，Gemini 对格式支持较广，但最好还是过滤下
        // if (!ALLOWED_MIME_TYPES.includes(mimeType)) { ... }

        const base64Data = Buffer.from(response.data).toString('base64');

        return {
            mimeType,
            data: base64Data
        };
    } catch (error) {
        logger.error(`Failed to download image from ${url}: ${error.message}`);
        return null;
    }
}
