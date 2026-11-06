import { cp, mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const source = join(root, 'src');
const output = join(root, 'dist');
const files = [
  'manifest.json',
  'popup.html',
  'popup.js',
  'noise-bridge.js',
  'noise-suppression.js',
  'noise-voice-filter.js',
];

const manifest = JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8'));
if (manifest.name !== 'Sona' || manifest.description.includes('Bidirectional')) {
  throw new Error('Expected the microphone-only Sona manifest');
}

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const file of files) await cp(join(source, file), join(output, file));
await cp(join(source, 'vendor'), join(output, 'vendor'), { recursive: true });
await cp(join(source, 'icons'), join(output, 'icons'), { recursive: true });
console.log(`Built microphone-only Sona at ${output}`);
