import { registerHooks } from 'node:module';
registerHooks({resolve(specifier, context, next) {
  if (specifier === '@composio/core') return {url: new URL('./fake-sdk.mjs', import.meta.url).href, shortCircuit:true};
  return next(specifier,context);
}});
