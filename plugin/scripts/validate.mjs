import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const projectRoot = resolve(import.meta.dirname, '..');
const buildRoot = resolve(projectRoot, 'dist', '_build');
const cliPath = resolve(
  projectRoot,
  'node_modules',
  '@songloft',
  'plugin-builder',
  'dist',
  'cli.js',
);

if (!existsSync(resolve(buildRoot, 'plugin.json'))) {
  console.error('Build output is missing. Run `npm run build` before validation.');
  process.exit(1);
}

const result = spawnSync(process.execPath, [cliPath, 'validate'], {
  cwd: buildRoot,
  stdio: 'inherit',
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
