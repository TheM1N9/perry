import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
registerHooks({ resolve(specifier, context, next) {
  const target = specifier.startsWith('@/') ? pathToFileURL(resolve(specifier.slice(2))).href : specifier;
  try { return next(target, context); } catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
    for (const suffix of ['.ts', '.js']) { try { return next(target + suffix, context); } catch {} }
    throw error;
  }
} });
