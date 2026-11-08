import { cp, mkdir, access } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkgRoot = path.dirname(require.resolve('stockfish'));
const bin = path.join(pkgRoot, 'bin');
const destination = path.resolve('public/engine');
const files = [
  'stockfish-19-lite-single.js',
  'stockfish-19-lite-single.wasm',
];

await mkdir(destination, { recursive: true });
const missing = [];
for (const file of files) {
  const source = path.join(bin, file);
  try {
    await access(source);
    await cp(source, path.join(destination, file));
    console.log(`Copied Stockfish asset: ${file}`);
  } catch {
    missing.push(source);
  }
}
if (missing.length) {
  console.error('Stockfish engine assets are missing:');
  for (const file of missing) console.error(`  - ${file}`);
  console.error('Reinstall the stockfish@19.0.1 package, then run npm run copy:engine.');
  process.exitCode = 1;
}
