import { useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { useChatDeadline } from "../../components/dashboard/chat/render-isolation";

declare global {
  interface Window {
    runDeadlineProbe: () => Promise<{ checks: Record<string, boolean>; scheduled: number[][] }>;
  }
}

window.runDeadlineProbe = async () => {
  const nativeNow = Date.now;
  const timers: Pick<Window, "setTimeout" | "clearTimeout"> = window;
  const nativeTimeout = timers.setTimeout;
  const nativeClear = timers.clearTimeout;
  const pending = new Set<number>();
  const checks: Record<string, boolean> = {};
  const scheduled: number[][] = [];
  let delays: number[] = [];
  let offset = 0;
  let root: Root | undefined;
  const host = document.createElement("div");
  document.body.append(host);
  const wait = (ms: number) => new Promise<void>(resolve => nativeTimeout(resolve, ms));
  Date.now = () => nativeNow() + offset;
  timers.setTimeout = (callback, delay = 0, ...args) => {
    const id = nativeTimeout(() => {
      pending.delete(id);
      if (typeof callback === "function") callback(...args);
      else window.eval(callback);
    }, delay);
    pending.add(id);
    delays.push(delay);
    return id;
  };
  timers.clearTimeout = id => {
    if (id !== undefined) pending.delete(id);
    nativeClear(id);
  };

  function Probe({ deadlines, cross }: { deadlines: Array<number | undefined>; cross?: number }) {
    const revision = useChatDeadline(deadlines);
    const expired = deadlines.filter(time => time !== undefined && Number.isFinite(time) && time <= Date.now()).length;
    useLayoutEffect(() => { if (cross !== undefined) offset = cross - nativeNow(); }, [cross]);
    return <output>{JSON.stringify({ revision, expired })}</output>;
  }
  const state = (): { revision: number; expired: number } => JSON.parse(host.querySelector("output")!.textContent!);
  const mount = (deadlines: Array<number | undefined>, cross?: number) => {
    offset = 0;
    delays = [];
    scheduled.push(delays);
    root = createRoot(host);
    flushSync(() => root!.render(<Probe deadlines={deadlines} cross={cross} />));
  };
  const unmount = () => { flushSync(() => root?.unmount()); root = undefined; };
  try {
    let now = nativeNow();
    mount([now + 1000], now + 1001);
    checks.crossedAfterRender = state().expired === 0 && Date.now() > now + 1000;
    await wait(100);
    checks.crossedDeadlineWakesOnce = state().expired === 1 && state().revision === 1 && delays.length === 1 && delays[0] === 1;
    await wait(100);
    checks.expiredDeadlineDoesNotLoop = state().revision <= 1 && pending.size === 0 && delays.length <= 1;
    unmount();

    now = nativeNow();
    mount([undefined, NaN, Infinity, now - 1000]);
    await wait(30);
    checks.expiredAndInvalidDeadlinesStayIdle = state().revision === 0 && state().expired === 1 && delays.length === 0;
    unmount();

    now = nativeNow();
    mount([now + 1500, now + 500]);
    checks.futureDeadlineDoesNotFireEarly = state().revision === 0 && state().expired === 0 && pending.size === 1;
    await wait(700);
    checks.earliestDeadlineFirst = state().revision === 1 && state().expired === 1 && pending.size === 1;
    await wait(1000);
    checks.nextDeadlineAlsoWakes = state().revision === 2 && state().expired === 2 && pending.size === 0;
    unmount();

    now = nativeNow();
    mount([now + 60_000]);
    flushSync(() => root!.render(<Probe deadlines={[nativeNow() + 100]} />));
    checks.replacementCancelsPreviousTimer = pending.size === 1 && delays.length === 2;
    await wait(200);
    checks.replacementDeadlineWakes = state().revision === 1 && state().expired === 1 && pending.size === 0;
    unmount();

    mount([nativeNow() + 60_000]);
    checks.futureTimerOwned = pending.size === 1;
    unmount();
    checks.unmountClearsTimer = pending.size === 0;

    mount([nativeNow() + 2_147_483_647 + 60_000]);
    checks.longDeadlineUsesNativeLimit = pending.size === 1 && delays[0] === 2_147_483_647;
    unmount();
    checks.longTimerAlsoClears = pending.size === 0;
    return { checks, scheduled };
  } finally {
    unmount();
    for (const id of pending) nativeClear(id);
    pending.clear();
    Date.now = nativeNow;
    timers.setTimeout = nativeTimeout;
    timers.clearTimeout = nativeClear;
    host.remove();
  }
};
