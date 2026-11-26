import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

// builds /sw.js from src/sw.js with this build's file list baked in, so every deploy ships a new worker
// that precaches exactly its own shell and drops the previous one
const sw = () => ({
  name: 'sw',
  apply: 'build',
  generateBundle(_, bundle) {
    const files = Object.keys(bundle).filter((f) => /\.(js|css)$/.test(f)).map((f) => `/${f}`).sort();
    const shell = [...files, '/manifest.webmanifest', '/icons/favicon.svg', '/icons/icon-96.png', '/icons/icon-192.png', '/icons/apple-touch-icon.png', '/icons/island.svg', '/fonts/lisboa-display.woff2'];
    const version = createHash('sha1').update(files.join()).digest('hex').slice(0, 10);
    const src = readFileSync(new URL('./src/sw.js', import.meta.url), 'utf8').replace('__VERSION__', version).replace('__SHELL__', JSON.stringify(shell));
    this.emitFile({ type: 'asset', fileName: 'sw.js', source: src });
  },
});

export default defineConfig({
  build: { target: 'es2022', chunkSizeWarningLimit: 900 },
  plugins: [sw()],
});
