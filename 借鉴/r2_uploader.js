import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import crypto from 'crypto';
import config from '../config/config.js';
import logger from './logger.js';

class R2Uploader {
    constructor() {
        this.client = null;
        this.initialized = false;
        this.init();
    }

    init() {
        const r2Config = config.r2;
        logger.info(`R2 初始化检查: enabled=${r2Config?.enabled}`);

        if (r2Config && r2Config.enabled) {
            if (!r2Config.accountId || !r2Config.accessKeyId || !r2Config.secretAccessKey || !r2Config.bucketName) {
                logger.warn('R2_ENABLED 为 true 但配置不完整，R2 上传功能将禁用');
                return;
            }

            logger.info(`R2 配置: Bucket=${r2Config.bucketName}, Account=${r2Config.accountId}`);

            try {
                this.client = new S3Client({
                    region: 'auto',
                    endpoint: `https://${r2Config.accountId}.r2.cloudflarestorage.com`,
                    credentials: {
                        accessKeyId: r2Config.accessKeyId,
                        secretAccessKey: r2Config.secretAccessKey
                    }
                });
                this.bucketName = r2Config.bucketName;
                this.publicUrl = r2Config.publicUrl ? r2Config.publicUrl.replace(/\/$/, '') : '';
                this.initialized = true;
                logger.info(`R2 Uploader 初始化成功。Bucket: ${this.bucketName}`);
            } catch (error) {
                logger.error(`R2 客户端初始化失败: ${error.message}`);
            }
        }
    }

    generateFilename(imageBuffer, mimeType) {
        const extMap = {
            'image/png': 'png',
            'image/jpeg': 'jpg',
            'image/jpg': 'jpg',
            'image/gif': 'gif',
            'image/webp': 'webp',
            'image/bmp': 'bmp',
            'image/svg+xml': 'svg'
        };
        const ext = extMap[mimeType.toLowerCase()] || 'png';

        // 生成内容哈希
        const hash = crypto.createHash('md5').update(imageBuffer).digest('hex').substring(0, 16);

        // 时间戳
        const timestamp = Date.now();

        // 年月
        const date = new Date();
        const yearMonth = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}`;

        return `images/${yearMonth}/${hash}_${timestamp}.${ext}`;
    }

    async uploadImage(base64Data, mimeType) {
        if (!this.initialized) {
            logger.warn('R2 未初始化，无法上传图片');
            return null;
        }

        logger.info(`准备上传图片: type=${mimeType}, size=${base64Data.length} chars`);

        try {
            const imageBuffer = Buffer.from(base64Data, 'base64');
            const filename = this.generateFilename(imageBuffer, mimeType);
            logger.info(`生成文件名: ${filename}`);

            const command = new PutObjectCommand({
                Bucket: this.bucketName,
                Key: filename,
                Body: imageBuffer,
                ContentType: mimeType,
                CacheControl: 'public, max-age=31536000' // 1年
            });

            await this.client.send(command);

            const imageUrl = `${this.publicUrl}/${filename}`;
            logger.info(`图片已上传到 R2: ${imageUrl}`);

            return imageUrl;
        } catch (error) {
            logger.error(`R2 上传失败: ${error.message}`);
            return null;
        }
    }

    async uploadText(content, filename) {
        if (!this.initialized) {
            logger.warn('R2 未初始化，无法上传文本');
            return null;
        }

        try {
            const key = `signatures/${filename}`;
            const command = new PutObjectCommand({
                Bucket: this.bucketName,
                Key: key,
                Body: content,
                ContentType: 'text/plain',
                CacheControl: 'public, max-age=2592000' // 30天
            });

            await this.client.send(command);
            return `${this.publicUrl}/${key}`;
        } catch (error) {
            logger.error(`R2 文本上传失败: ${error.message}`);
            return null;
        }
    }

    isEnabled() {
        return this.initialized;
    }
}

const r2Uploader = new R2Uploader();
export default r2Uploader;