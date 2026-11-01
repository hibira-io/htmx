// Builds the script-tag files: dist/hibira.js and dist/hibira.min.js. They
// register the extension with the global htmx (2 or 4) and pusher-js, and
// expose the API as window.HibiraHtmx.
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const common = {
  entryPoints: [new URL('./auto.js', import.meta.url).pathname],
  bundle: true,
  format: 'iife',
  target: 'es2020',
  banner: { js: `/*! @hibira-io/htmx v${version} | MIT | https://github.com/hibira-io/htmx */` },
  logLevel: 'warning',
};

await build({ ...common, outfile: 'dist/hibira.js' });
await build({ ...common, outfile: 'dist/hibira.min.js', minify: true });
