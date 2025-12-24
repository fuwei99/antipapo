import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const responsePath = path.join(__dirname, 'response.txt');

try {
    const content = fs.readFileSync(responsePath, 'utf8');
    const lines = content.split('\n');
    const dataLine = lines.find(line => line.startsWith('data: '));

    if (!dataLine) {
        console.error('No data line found in response.txt');
        process.exit(1);
    }

    const jsonStr = dataLine.substring(6);
    const data = JSON.parse(jsonStr);

    // Function to recursively truncate specific keys
    function truncateKeys(obj) {
        if (!obj) return obj;
        if (typeof obj !== 'object') return obj;

        if (Array.isArray(obj)) {
            return obj.map(truncateKeys);
        }

        const newObj = {};
        for (const key in obj) {
            if (key === 'thoughtSignature' || key === 'inlineData') {
                newObj[key] = `<${key} TRUNCATED, length: ${String(obj[key]).length}>`;
            } else if (key === 'data' && obj['mimeType']) {
                // Handle inlineData structure if it's inside an object like { mimeType:..., data:... }
                // The API usually returns parts: [{ inlineData: { mimeType:..., data:... } }]
                newObj[key] = `<BASE64_DATA TRUNCATED, length: ${String(obj[key]).length}>`;
            } else {
                newObj[key] = truncateKeys(obj[key]);
            }
        }
        return newObj;
    }

    const cleanData = truncateKeys(data);
    console.log(JSON.stringify(cleanData, null, 2));

} catch (e) {
    console.error('Error processing response:', e);
}
