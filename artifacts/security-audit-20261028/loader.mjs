import '../secrets-at-rest/node-loader.mjs';
import { registerHooks } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = resolve(import.meta.dirname, '../..');
registerHooks({ resolve(specifier, context, next) {
  if (specifier.startsWith('@/')) {
    const target = pathToFileURL(resolve(root, specifier.slice(2))).href;
    for (const suffix of ['.ts', '.js', '.tsx', '']) {
      try { return next(target + suffix, context); }
      catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
    }
  }
  return next(specifier, context);
} });
