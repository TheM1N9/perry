"use client";

import { useCallback, useLayoutEffect, useRef, useState } from "react";

/** Native anchoring keeps history steady; this only owns the intent to follow. */
export function useChatScroll(scope: string | null) {
  const scroller = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const readerScrolling = useRef(false);
  const readerRevision = useRef(0);
  const previousTop = useRef(0);
  const pagination = useRef<{ element: Element; offset: number } | null>(null);
  const [atBottom, setAtBottom] = useState(true);

  const release = useCallback(() => {
    readerRevision.current += 1;
    following.current = false;
    readerScrolling.current = false;
    pagination.current = null;
    setAtBottom(false);
    // Also cancel any browser-initiated smooth navigation before it moves again.
    const element = scroller.current;
    if (element) element.scrollTo({ top: element.scrollTop, behavior: "instant" });
  }, []);

  const followLiveReply = useCallback(() => {
    const element = scroller.current;
    if (!element || !following.current || pagination.current) return;
    element.scrollTo({ top: element.scrollHeight, behavior: "instant" });
    previousTop.current = element.scrollTop;
  }, []);

  const onScroll = useCallback(() => {
    const element = scroller.current;
    if (!element) return;
    const bottom = element.scrollHeight - element.clientHeight - element.scrollTop <= 2;
    // Layout/anchoring events never reclaim follow after an explicit release.
    // Scrolling down to the actual end is the reader's opt-in to follow again.
    if (readerScrolling.current && element.scrollTop > previousTop.current && bottom) {
      following.current = true;
      readerScrolling.current = false;
    }
    previousTop.current = element.scrollTop;
    setAtBottom(following.current && bottom);
  }, []);

  const jumpToLatest = useCallback(() => {
    pagination.current = null;
    readerScrolling.current = false;
    following.current = true;
    setAtBottom(true);
    // An immediate jump cannot race streamed layout or subsequent reader input,
    // and also respects reduced motion without a separate animation lifecycle.
    followLiveReply();
  }, [followLiveReply]);

  const beginPagination = useCallback(() => {
    release();
    const element = scroller.current;
    if (!element) return;
    const top = element.getBoundingClientRect().top;
    const anchor = [...element.querySelectorAll("[data-role]")]
      .find((row) => row.getBoundingClientRect().bottom > top);
    if (anchor) pagination.current = { element: anchor, offset: anchor.getBoundingClientRect().top - top };
  }, [release]);

  const restorePagination = useCallback(() => {
    const element = scroller.current;
    const anchor = pagination.current;
    if (!element || !anchor) return;
    pagination.current = null;
    if (element.contains(anchor.element)) {
      // Correct only what native anchoring did not already preserve. Heights
      // below the anchor (including a growing live reply) do not enter this sum.
      element.scrollTop += anchor.element.getBoundingClientRect().top - element.getBoundingClientRect().top - anchor.offset;
    }
    previousTop.current = element.scrollTop;
  }, []);

  useLayoutEffect(() => {
    pagination.current = null;
    readerScrolling.current = false;
    following.current = true;
    previousTop.current = 0;
    setAtBottom(true);
  }, [scope]);

  useLayoutEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const readerInput = () => {
      release();
      readerScrolling.current = true;
      previousTop.current = element.scrollTop;
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.target instanceof Element && event.target.closest("input, textarea, select, [contenteditable]:not([contenteditable=false])")) return;
      if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) readerInput();
    };
    const click = (event: MouseEvent) => {
      // Capture runs before either WorkSteps or WorkSummary changes layout,
      // including clicks synthesized by keyboard activation.
      if (event.target instanceof Element && event.target.closest("[data-work] button[aria-expanded], [data-work-steps] button[aria-expanded]")) release();
    };
    const pointerdown = (event: PointerEvent) => {
      if (event.target === element) readerInput(); // Native scrollbar drag/track.
    };
    element.addEventListener("wheel", readerInput, { passive: true });
    element.addEventListener("touchstart", readerInput, { passive: true });
    element.addEventListener("keydown", keydown);
    element.addEventListener("click", click, true);
    element.addEventListener("pointerdown", pointerdown);
    const observer = new ResizeObserver(followLiveReply);
    observer.observe(element);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    return () => {
      observer.disconnect();
      element.removeEventListener("wheel", readerInput);
      element.removeEventListener("touchstart", readerInput);
      element.removeEventListener("keydown", keydown);
      element.removeEventListener("click", click, true);
      element.removeEventListener("pointerdown", pointerdown);
    };
  }, [release, followLiveReply]);

  return { scroller, atBottom, onScroll, followLiveReply, jumpToLatest, release, readerRevision, beginPagination, restorePagination };
}
