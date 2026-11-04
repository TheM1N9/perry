import assert from "node:assert/strict";
import { BrowserWindow } from "electron";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Real capture windows and IPC, with failures injected at the pet's HTTP boundary. */
export async function cloudErrors({ ears, fault, call, report, save }) {
  const until = async (condition) => {
    for (let attempt = 0; attempt < 160; attempt++) {
      if (await condition()) return;
      await sleep(100);
    }
    throw new Error("Cloud error handling did not settle.");
  };
  for (const kind of ["missing", "rejected", "invalid", "transient", "stopping"]) {
    fault.kind = kind;
    fault.attempts = 0;
    const started = await ears.start({ title: `Cloud ${kind} failure fixture` });
    assert.equal(started.phase, "listening");
    const window = BrowserWindow.getAllWindows().find((item) => item.getTitle() === "Perry is listening");
    assert.ok(window);
    await window.webContents.executeJavaScript(`window.perryMeeting.chunk({seq:1000,source:'you',startMs:20000,endMs:21000,samples:new Float32Array(16000).fill(0.05)});${kind === "invalid" ? "window.perryMeeting.chunk({seq:1001,source:'you',startMs:21000,endMs:22000,samples:new Float32Array(16000).fill(0.05)})" : ""}`);
    if (kind === "stopping") { await until(() => fault.attempts === 1); await ears.stop(); }
    if (["missing", "rejected", "stopping"].includes(kind)) {
      await until(() => ears.state().phase === "off");
      assert.match(ears.state().error, /speech key/);
      const attempts = fault.attempts;
      await sleep(5_200);
      assert.equal(fault.attempts, attempts, "terminal errors must not leave a retry timer");
      assert.equal(attempts, 1);
      report.checks[`cloud ${kind} key error ends capture without retries`] = true;
    } else {
      await until(async () => (await call("meetings:transcript", { id: started.id })).some((segment) => segment.seq === (kind === "invalid" ? 1001 : 1000)));
      assert.ok(fault.attempts >= 2);
      if (kind === "invalid") {
        assert.equal((await call("meetings:transcript", { id: started.id })).some((segment) => segment.seq === 1000), false);
        assert.ok(ears.state().droppedMs >= 1000);
      }
      report.checks[`cloud ${kind} failure preserves later transcription`] = true;
      await ears.stop();
      await until(() => ears.state().phase === "off");
    }
    save();
  }
  fault.kind = null;
}
