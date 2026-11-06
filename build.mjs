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
  'background.js',
  'noise-bridge.js',
  'noise-suppression.js',
  'noise-voice-filter.js',
];

const manifest = JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8'));
if (manifest.name !== 'Sona' || manifest.description.includes('Bidirectional')) {
  throw new Error('Expected the microphone-only Sona manifest');
}
const sites = manifest.content_scripts[0].matches;
if (!sites.includes('https://meet.google.com/*') ||
    manifest.content_scripts.some(script => JSON.stringify(script.matches) !== JSON.stringify(sites)) ||
    JSON.stringify(manifest.web_accessible_resources[0].matches) !== JSON.stringify(sites)) {
  throw new Error('Content scripts and audio assets must cover the same call sites');
}

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
for (const file of files) await cp(join(source, file), join(output, file));
await cp(join(source, 'vendor'), join(output, 'vendor'), { recursive: true });
await cp(join(source, 'icons'), join(output, 'icons'), { recursive: true });
console.log(`Built microphone-only Sona at ${output}`);
