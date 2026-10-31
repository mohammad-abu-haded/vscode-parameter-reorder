const esbuild = require('esbuild');
const production = process.argv.includes('--production');
esbuild.build({
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['vscode'],
  minify: production,
  sourcemap: !production,
  logLevel: 'info',
}).catch(() => process.exit(1));
