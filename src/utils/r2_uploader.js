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
        // Don't log enabled status here to avoid spamming logs on import if not used, 
        // but it's fine for singleton initialization.

        if (r2Config && r2Config.enabled) {
            if (!r2Config.accountId || !r2Config.accessKeyId || !r2Config.secretAccessKey || !r2Config.bucketName) {
                logger.warn('R2_ENABLED is true but configuration is incomplete. R2 upload will be disabled.');
                return;
            }

            logger.info(`R2 Configuration: Bucket=${r2Config.bucketName}, Account=${r2Config.accountId}`);

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
                logger.info(`R2 Uploader initialized successfully. Bucket: ${this.bucketName}`);
            } catch (error) {
                logger.error(`R2 Client initialization failed: ${error.message}`);
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

        // Content hash
        const hash = crypto.createHash('md5').update(imageBuffer).digest('hex').substring(0, 16);

        // Timestamp
        const timestamp = Date.now();

        // Year-Month folder
        const date = new Date();
        const yearMonth = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}`;

        return `images/${yearMonth}/${hash}_${timestamp}.${ext}`;
    }

    async uploadImage(base64Data, mimeType) {
        if (!this.initialized) {
            // If R2 is not enabled/initialized, return null to indicate fallback or failure
            return null;
        }

        logger.info(`Uploading image: type=${mimeType}, size=${base64Data.length} chars`);

        try {
            const imageBuffer = Buffer.from(base64Data, 'base64');
            const filename = this.generateFilename(imageBuffer, mimeType);

            const command = new PutObjectCommand({
                Bucket: this.bucketName,
                Key: filename,
                Body: imageBuffer,
                ContentType: mimeType,
                CacheControl: 'public, max-age=31536000' // 1 year
            });

            await this.client.send(command);

            const imageUrl = `${this.publicUrl}/${filename}`;
            logger.info(`Image uploaded to R2: ${imageUrl}`);

            return imageUrl;
        } catch (error) {
            logger.error(`R2 upload failed: ${error.message}`);
            return null;
        }
    }

    async uploadText(content, filename) {
        if (!this.initialized) {
            return null;
        }

        try {
            const key = `signatures/${filename}`;
            const command = new PutObjectCommand({
                Bucket: this.bucketName,
                Key: key,
                Body: content,
                ContentType: 'text/plain',
                CacheControl: 'public, max-age=2592000' // 30 days
            });

            await this.client.send(command);
            return `${this.publicUrl}/${key}`;
        } catch (error) {
            logger.error(`R2 text upload failed: ${error.message}`);
            return null;
        }
    }

    isEnabled() {
        return this.initialized;
    }
}

const r2Uploader = new R2Uploader();
export default r2Uploader;
