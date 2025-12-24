import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import https from 'https';
import AntigravityRequester from '../src/AntigravityRequester.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Hardcoded OAuth Config from src/constants/oauth.js
const CLIENT_ID = '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com';
const CLIENT_SECRET = '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';

// Simple implementation of axios-like post for token refresh to avoid dependency issues if any
function refreshAccessToken(refreshToken) {
    return new Promise((resolve, reject) => {
        const body = new URLSearchParams({
            client_id: CLIENT_ID,
            client_secret: CLIENT_SECRET,
            grant_type: 'refresh_token',
            refresh_token: refreshToken
        }).toString();

        const options = {
            hostname: 'oauth2.googleapis.com',
            port: 443,
            path: '/token',
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(body)
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                if (res.statusCode === 200) {
                    try {
                        resolve(JSON.parse(data));
                    } catch (e) {
                        reject(new Error('Failed to parse token response'));
                    }
                } else {
                    reject(new Error(`Token refresh failed: ${res.statusCode} ${data}`));
                }
            });
        });

        req.on('error', (e) => reject(e));
        req.write(body);
        req.end();
    });
}

async function main() {
    try {
        // 1. 读取 Token
        const tokenPath = path.join(__dirname, 'test-token.json');
        console.log(`📂 Reading token from: ${tokenPath}`);
        const tokenData = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
        let token = tokenData[1];

        if (!token || !token.refresh_token) {
            console.error('❌ No refresh token found in file.');
            return;
        }

        console.log('🔄 Refreshing token manually...');
        try {
            const newData = await refreshAccessToken(token.refresh_token);
            token.access_token = newData.access_token;
            console.log(`✅ Token refreshed! New Access Token: ...${token.access_token.slice(-8)}`);
        } catch (e) {
            console.error('❌ Failed to refresh token:', e.message);
            return;
        }

        // 2. 初始化 Requester
        const requester = new AntigravityRequester();

        // 3. 构造请求
        const url = 'https://daily-cloudcode-pa.sandbox.googleapis.com/v1internal:streamGenerateContent?alt=sse';

        const requestBody = {
            model: 'gemini-3-pro-image', // Remove models/ prefix
            requestId: `agent-${Date.now()}`,
            requestType: 'image_gen',
            request: {
                contents: [
                    {
                        role: 'user',
                        parts: [{ text: '生成一个爷们体育生' }]
                    }
                ],
                generationConfig: {
                    candidateCount: 1,
                    imageConfig: {
                        imageSize: "1K"
                    }
                },
                sessionId: token.sessionId || String(-Math.floor(Math.random() * 9e18))
            }
        };

        const headers = {
            'Host': 'daily-cloudcode-pa.sandbox.googleapis.com',
            'User-Agent': 'antigravity/1.11.3 windows/amd64',
            'Authorization': `Bearer ${token.access_token}`,
            'Content-Type': 'application/json',
            'Accept-Encoding': 'gzip'
        };

        const config = {
            method: 'POST',
            headers: headers,
            body: JSON.stringify(requestBody),
            timeout_ms: 300000
        };

        console.log('🚀 Sending request to Antigravity (Go Binary)...');

        const stream = requester.antigravity_fetchStream(url, config);
        const outputPath = path.join(__dirname, 'response.txt');
        const writeStream = fs.createWriteStream(outputPath);

        await new Promise((resolve, reject) => {
            stream.onStart(({ status, statusText }) => {
                console.log(`📡 Response Status: ${status} ${statusText}`);
                writeStream.write(`[STATUS] ${status} ${statusText}\n`);
                if (status !== 200) {
                    // Log error body if possible?
                    // stream.onData will handle it
                }
            });

            stream.onData((chunk) => {
                process.stdout.write('.');
                writeStream.write(chunk);
            });

            stream.onEnd(() => {
                console.log('\n✅ Stream finished.');
                writeStream.end();
                resolve();
            });

            stream.onError((error) => {
                console.error('\n❌ Stream Error:', error);
                reject(error);
            });
        });

        requester.close();
        console.log(`💾 Response saved to ${outputPath}`);

    } catch (error) {
        console.error('Main Error:', error);
    }
}

main();
