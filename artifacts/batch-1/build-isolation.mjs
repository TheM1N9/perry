// Build-only isolation: do not load this checkout's real dotenv configuration.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { basename, resolve, dirname } from 'node:path';
const repo = resolve(process.cwd());
const guarded = (value) => {
  if (typeof value !== 'string' && !(value instanceof URL)) return false;
  const file = resolve(value instanceof URL ? value.pathname : value);
  return dirname(file).toLowerCase() === repo.toLowerCase() && /^\.env(?:\.|$)/.test(basename(file));
};
for (const name of ['statSync', 'readFileSync']) {
  const original = fs[name];
  fs[name] = function(file, ...args) {
    if (guarded(file)) { const error = new Error('Build isolation excludes dotenv files'); error.code = 'ENOENT'; throw error; }
    return original.call(this, file, ...args);
  };
}
syncBuiltinESMExports();
