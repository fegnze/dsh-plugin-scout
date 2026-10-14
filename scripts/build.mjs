// 构建两个产物并**执行**校验（不只是解析）：
//   lib/host.js   —— Node ESM，打包 semver；@deepseek-ai/* 由 DSH 运行时提供，保持外部。
//   lib/client.js —— 包进 window.__ModuleLoader__ 信封的 CJS；react 由宿主提供。
// 校验跑在写盘之后，检查的永远是这一版产物。
import * as esbuild from 'esbuild';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const pkg = JSON.parse(await readFile(new URL('package.json', root), 'utf8'));
await mkdir(new URL('lib/', root), { recursive: true });

const host = await esbuild.build({
  absWorkingDir: fileURLToPath(root),
  entryPoints: ['src/host.mjs'], bundle: true, write: false,
  format: 'esm', platform: 'node', target: 'node22',
  external: ['@deepseek-ai/*'],
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
await writeFile(new URL('lib/host.js', root), host.outputFiles[0].text);

const client = await esbuild.build({
  absWorkingDir: fileURLToPath(root),
  entryPoints: ['src/client/index.jsx'], bundle: true, write: false,
  format: 'cjs', platform: 'browser', target: 'es2022', jsx: 'automatic',
  external: ['react', 'react/*'], loader: { '.css': 'text' },
});
await writeFile(new URL('lib/client.js', root), `window.__ModuleLoader__.load({
  id: ${JSON.stringify(pkg.name)},
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
${client.outputFiles[0].text}
    return module.exports;
  }
});\n`);

// ── 执行校验 ──
const hostMod = await import(`${pathToFileURL(fileURLToPath(new URL('lib/host.js', root))).href}?t=${Date.now()}`);
for (const k of ['apply', 'inject', 'Config', 'name']) if (!(k in hostMod)) throw new Error(`lib/host.js missing export ${k}`);
let loaded;
const req = createRequire(import.meta.url);
const sandbox = { window: { __ModuleLoader__: { load: ({ id, factory }) => { loaded = { id, exports: factory(req) }; } } } };
vm.runInNewContext(await readFile(new URL('lib/client.js', root), 'utf8'), sandbox, { filename: 'lib/client.js' });
if (loaded?.id !== pkg.name) throw new Error('client envelope did not load under the package id');
if (typeof loaded.exports.apply !== 'function') throw new Error('client bundle has no apply()');
console.log(`Built ${pkg.name}: host ${(host.outputFiles[0].text.length / 1024).toFixed(0)} KB, client ${(client.outputFiles[0].text.length / 1024).toFixed(0)} KB; both executed.`);
