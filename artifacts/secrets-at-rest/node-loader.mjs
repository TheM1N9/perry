// Node-only E2E runner: resolve Perry's bundler-style extensionless TS imports.
// No transpiled files or dependency changes; Node performs its native TS transform.
import { registerHooks } from "node:module";
registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); }
    catch (error) {
      if (error.code !== "ERR_MODULE_NOT_FOUND" || !specifier.startsWith(".") || /\.[cm]?[jt]sx?$/.test(specifier)) throw error;
      for (const extension of [".ts", ".js"]) {
        try { return nextResolve(`${specifier}${extension}`, context); }
        catch (candidate) { if (candidate.code !== "ERR_MODULE_NOT_FOUND") throw candidate; }
      }
      throw error;
    }
  },
});
