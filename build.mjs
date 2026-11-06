/**
 * build.mjs - produces single-file builds of the app.
 *
 *   dist/freshtrack.html  a complete standalone page (host it anywhere)
 *   dist/artifact.html    the same page without the document skeleton,
 *                         for publishing as a Claude artifact
 *
 * There is no toolchain: the modules are concatenated by a ~50 line bundler
 * so that `node build.mjs` works on a bare checkout.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const ORDER = ['gs1', 'shelflife', 'store', 'off', 'receipt', 'ocr', 'scanner', 'app'];

function transform(name) {
  let src = readFileSync(join(root, 'js', `${name}.js`), 'utf8');
  const exported = new Set();

  src = src
    .replace(/^import\s*\{([^}]+)\}\s*from\s*'\.\/(\w+)\.js';?$/gm,
      (_, names, mod) => `const {${names}} = __mod_${mod};`)
    .replace(/^import\s*\*\s*as\s*(\w+)\s*from\s*'\.\/(\w+)\.js';?$/gm,
      (_, alias, mod) => `const ${alias} = __mod_${mod};`)
    .replace(/^export\s+(async\s+)?function\s+(\w+)/gm, (_, async_, id) => { exported.add(id); return `${async_ || ''}function ${id}`; })
    .replace(/^export\s+(const|let|class)\s+(\w+)/gm, (_, kw, id) => { exported.add(id); return `${kw} ${id}`; });

  return `const __mod_${name} = (() => {\n${src}\nreturn {${[...exported].join(', ')}};\n})();`;
}

const bundle = ORDER.map(transform).join('\n\n');

const html = readFileSync(join(root, 'index.html'), 'utf8');
const css = readFileSync(join(root, 'css', 'styles.css'), 'utf8');
const icon = readFileSync(join(root, 'icons', 'icon.svg'), 'utf8');
const iconData = 'data:image/svg+xml;base64,' + Buffer.from(icon).toString('base64');

const head = html.slice(html.indexOf('<head>') + 6, html.indexOf('</head>'));
const body = html.slice(html.indexOf('<body>') + 6, html.indexOf('</body>'));

const title = /<title>([^<]*)<\/title>/.exec(head)[1];
const inner = body
  .replace(/<script type="module"[\s\S]*?<\/script>/, '')
  .replace(/<script>[\s\S]*?<\/script>/, '')
  .trim();

const page = (withSkeleton) => {
  const content =
`<title>${title}</title>
<style>
${css}
</style>
${inner}
<script>
${bundle}
</script>`;
  if (!withSkeleton) return content;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#1f8a54">
<meta name="apple-mobile-web-app-capable" content="yes">
<link rel="icon" href="${iconData}">
${content.slice(0, content.indexOf('<style>'))}<style>
${css}
</style>
</head>
<body style="margin:0">
${inner}
<script>
${bundle}
</script>
</body>
</html>`;
};

mkdirSync(join(root, 'dist'), { recursive: true });
writeFileSync(join(root, 'dist', 'freshtrack.html'), page(true));
writeFileSync(join(root, 'dist', 'artifact.html'), page(false));
console.log('built dist/freshtrack.html and dist/artifact.html');
