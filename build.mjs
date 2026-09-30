import { build } from 'esbuild';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const directory = path.dirname(fileURLToPath(import.meta.url));
const sourceDirectory = path.join(directory, 'src');
const outputDirectory = path.join(directory, 'dist');
const result = await build({
  entryPoints: [path.join(sourceDirectory, 'scene.js')],
  bundle: true,
  minify: true,
  format: 'iife',
  target: ['es2020'],
  write: false,
  legalComments: 'inline'
});
const template = await readFile(path.join(sourceDirectory, 'index.template.html'), 'utf8');
const styles = await readFile(path.join(sourceDirectory, 'style.css'), 'utf8');
const script = result.outputFiles[0].text.replaceAll('</script', '<\\/script');
const html = template.replace('/* APP_STYLES */', () => styles).replace('/* APP_SCRIPT */', () => script);
await mkdir(outputDirectory, { recursive: true });
await writeFile(path.join(outputDirectory, 'forest-shelter.html'), html);
console.log(`Built forest-shelter.html: ${(Buffer.byteLength(html) / 1024).toFixed(0)} KB, no external runtime resources`);
