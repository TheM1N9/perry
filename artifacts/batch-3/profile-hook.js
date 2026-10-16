/* Disposable browser instrumentation only. Load before React; no imports/network. */
(() => {
  const previousTrees = new WeakMap();
  const wanted = new Set(['ChatScreen', 'ComposerDraft', 'Composer', 'MessageRow', 'LiveReply', 'ReplyInProgress', 'LiveApproval', 'QueueRemoveButton', 'Pet', 'PetChat', 'Listening', 'Body']);
  let phase = 'settling';
  let commits = [];
  let totals = {};
  let renderers = [];
  const original = window.__REACT_DEVTOOLS_GLOBAL_HOOK__;
  const hook = original ?? { supportsFiber: true, renderers: new Map(), inject(renderer) {
    const id = this.renderers.size + 1;
    this.renderers.set(id, renderer);
    return id;
  }};
  const onCommit = hook.onCommitFiberRoot;
  const inject = hook.inject;
  hook.inject = function (renderer) {
    renderers.push({version: renderer.version, package: renderer.rendererPackageName, bundleType: renderer.bundleType});
    return inject.call(this, renderer);
  };
  hook.onCommitFiberRoot = function (id, root, priority, didError) {
    // A bailed-out subtree may retain PerformedWork from an earlier commit.
    // Reject fibers reused verbatim from the immediately preceding tree.
    const previous = previousTrees.get(root) ?? new WeakSet();
    const current = new WeakSet();
    const rendered = {};
    const stack = [root.current];
    while (stack.length) {
      const fiber = stack.pop();
      current.add(fiber);
      if (fiber.sibling) stack.push(fiber.sibling);
      if (fiber.child) stack.push(fiber.child);
      if (![0, 1, 11, 15].includes(fiber.tag)) continue;
      const type = fiber.type;
      const name = type?.displayName ?? type?.name ?? type?.render?.displayName ?? type?.render?.name;
      if (!wanted.has(name) || previous.has(fiber) || !(fiber.flags & 1)) continue;
      const entry = rendered[name] ??= {mounts: 0, updates: 0, actualDurationMs: 0};
      entry[fiber.alternate ? 'updates' : 'mounts']++;
      entry.actualDurationMs += fiber.actualDuration ?? 0;
    }
    previousTrees.set(root, current);
    if (phase !== 'settling') {
      for (const [name, entry] of Object.entries(rendered)) {
        const sum = totals[name] ??= {mounts: 0, updates: 0, actualDurationMs: 0};
        sum.mounts += entry.mounts;
        sum.updates += entry.updates;
        sum.actualDurationMs += entry.actualDurationMs;
      }
      if (commits.length < 500) commits.push({at: performance.now(), priority, didError: !!didError, rendered});
    }
    if (onCommit) return onCommit.call(this, id, root, priority, didError);
  };
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = hook;
  window.__perryRenderProbe = {
    start(label) { phase = label; totals = {}; commits = []; },
    read() { return {phase, renderers, totals, commits, truncated: commits.length >= 500}; },
    settle() { phase = 'settling'; },
  };
})();

(() => {
  document.addEventListener("DOMContentLoaded", () => {
    const panel = document.createElement("details");
    panel.id = "batch-profile";
    panel.style = "position:fixed;bottom:0;left:0;z-index:99999;background:#fff;color:#111;max-width:430px;max-height:130px;overflow:auto;font:10px monospace";
    const summary = document.createElement("summary"); summary.textContent = "Fixture profiling"; panel.append(summary);
    const input = document.createElement("input"); input.setAttribute("aria-label", "Profile phase"); input.value = "typing"; panel.append(input);
    const reset = document.createElement("button"); reset.textContent = "Begin profile phase";
    reset.onclick = () => { window.__perryRenderProbe.start(input.value); publish(); }; panel.append(reset);
    const output = document.createElement("pre"); output.id = "batch-profile-data"; panel.append(output);
    document.body.append(panel);
    function publish() {
      output.textContent = JSON.stringify(window.__perryRenderProbe.read());
    }
    setInterval(publish, 500); publish();
  });
})();
