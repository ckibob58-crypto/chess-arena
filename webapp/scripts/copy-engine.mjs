import { cp, mkdir, access } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const pkgRoot = path.dirname(require.resolve('stockfish'));
const bin = path.join(pkgRoot, 'bin');
const dest = path.resolve('public/engine');
await mkdir(dest, { recursive: true });
for (const file of ['stockfish-19-lite-single.js','stockfish-19-lite-single.wasm']) {
  const src = path.join(bin,file);
  await access(src);
  await cp(src,path.join(dest,file));
  console.log(`Stockfish: ${file}`);
}
