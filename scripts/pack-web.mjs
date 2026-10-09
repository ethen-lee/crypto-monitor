import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

// WKWebView file origins do not support Vite's cross-origin module loading.
// Inline the locally built IIFE and CSS, authorizing only its exact script hash.
const root = new URL('../build/web/', import.meta.url);
let html = await readFile(new URL('index.html', root), 'utf8');
const scriptMatch = html.match(/<script\s+type="module"\s+crossorigin\s+src="([^"]+)"><\/script>/);
const styleMatch = html.match(/<link\s+rel="stylesheet"\s+crossorigin\s+href="([^"]+)">/);
if (!scriptMatch) throw new Error('Expected the Vite script asset.');
const script = (await readFile(new URL(scriptMatch[1], root), 'utf8')).replace(/<\/script/gi, '<\\/script');
const hash = createHash('sha256').update(script).digest('base64');
html = html.replace(scriptMatch[0], '');
if (styleMatch) {
  const style = await readFile(new URL(styleMatch[1], root), 'utf8');
  html = html.replace(styleMatch[0], `<style>${style}</style>`);
}
html = html.replace("script-src 'self'", `script-src 'sha256-${hash}'`);
html = html.replace('</body>', `<script>${script}</script></body>`);
await writeFile(new URL('index.html', root), html);
