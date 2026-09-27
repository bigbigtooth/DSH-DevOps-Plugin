// Build: host bundle (ESM, node) + client bundle (DSH client module IIFE).
import { build } from 'esbuild'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const outdir = join(root, 'dist')
mkdirSync(join(outdir, 'client'), { recursive: true })

// Host: single ESM file. DSH/cordis stay external (provided by the host at load).
await build({
  entryPoints: [join(root, 'src/index.ts')],
  outfile: join(outdir, 'index.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  sourcemap: true,
  // schemastery: the settings schema must be the SAME module family the host
  // settings service validates against — keep it external like zod.
  external: ['@deepseek-ai/*', 'zod', 'schemastery', 'node:*'],
  banner: {
    js: [
      "import { createRequire as __dshCreateRequire } from 'node:module';",
      'const require = __dshCreateRequire(import.meta.url);',
    ].join('\n'),
  },
})

// Client: DSH client module. The loader wraps every client bundle in
// window.__ModuleLoader__.load({ id, factory }) where factory(require) returns
// the module exports; `require` resolves the dsh.client.inject + react.
const clientExternals = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/dsh-client-ui-primitives',
]
const clientResult = await build({
  entryPoints: [{ in: join(root, 'src/client/index.ts'), out: 'client' }],
  outdir,
  bundle: true,
  platform: 'browser',
  // NOT 'iife': an IIFE wrapper owns the module scope, so every RETAINED
  // top-level local lands inside that scope instead of on `module.exports`.
  // The factory below would then return `{}`, `unwrapExports` would hand that
  // plain object to `registry.plugin`, and cordis aborts the whole web boot
  // with "invalid plugin, expect function or object with an apply method,
  // received object". 'cjs' keeps the host's `module`/`exports` bindings in
  // the OUTER scope, which is the contract the protocol expects and the shape
  // the official @deepseek-ai/dsh-client-ui-* bundles ship.
  format: 'cjs',
  target: 'es2022',
  sourcemap: false,
  external: clientExternals,
  write: false,
})
const clientJs = clientResult.outputFiles[0].text
// The host's factory scope already provides `module`/`exports`, so the CJS
// output is emitted verbatim between the two protocol halves.
const wrapped = `window.__ModuleLoader__.load({ id: "dsh-devops", factory: (require) => {\nvar module = { exports: {} };\nvar exports = module.exports;\n${clientJs}\nreturn module.exports;\n} });\n`
writeFileSync(join(outdir, 'client', 'client.js'), wrapped)

// Entry-level type declarations are produced by `pnpm typecheck` consumers'
// own toolchains; ship a minimal index type stub for npm consumers.
writeFileSync(
  join(outdir, 'index.d.ts'),
  [
    "import type { Context } from '@deepseek-ai/cordis'",
    'export declare const name: string',
    'export declare const inject: string[]',
    'export declare const Config: unknown',
    'export declare function apply(ctx: Context, config?: unknown): Promise<void> | void',
    '',
  ].join('\n'),
)
console.log('[dsh-devops] build done → dist/')
