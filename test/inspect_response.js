import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const responsePath = path.join(__dirname, 'response.txt');

try {
    const content = fs.readFileSync(responsePath, 'utf8');
    // Find the line starting with "data: "
    const lines = content.split('\n');
    const dataLine = lines.find(line => line.startsWith('data: '));

    if (!dataLine) {
        console.error('No data line found');
        process.exit(1);
    }

    const jsonStr = dataLine.substring(6); // remove "data: "
    const data = JSON.parse(jsonStr);

    console.log('Response Structure Inspection:');
    if (data.response && data.response.candidates && data.response.candidates.length > 0) {
        const parts = data.response.candidates[0].content.parts;
        console.log(`Number of parts: ${parts.length}`);
        parts.forEach((part, index) => {
            console.log(`Part ${index} keys:`, Object.keys(part));
            if (part.text) console.log(`Part ${index} text length:`, part.text.length);
            if (part.reasoningContent) console.log(`Part ${index} reasoningContent available`);
            if (part.thoughtSignature) console.log(`Part ${index} thoughtSignature available`);
            if (part.inlineData) console.log(`Part ${index} inlineData (Base64) available`);
        });
    } else {
        console.log('No candidates found', JSON.stringify(data, null, 2));
    }

} catch (e) {
    console.error('Error parsing response:', e);
}
