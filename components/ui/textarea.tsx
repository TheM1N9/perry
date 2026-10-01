"use client"

import * as React from "react"
import { cn } from "cn"

/**
 * Grows with what is typed, up to a limit, then scrolls; never dragged to a
 * size. `field-sizing: content` does the growing where the browser has it; where
 * it does not (older Firefox and Safari), the height follows the text instead.
 */
function Textarea({ className, ref, onInput, ...props }: React.ComponentProps<"textarea">) {
  const own = React.useRef<HTMLTextAreaElement>(null)
  React.useImperativeHandle(ref, () => own.current as HTMLTextAreaElement)
  React.useLayoutEffect(() => fit(own.current), [props.value])
  React.useEffect(() => {
    const area = own.current
    // Where the browser cannot size it, a new width rewraps the text, so the height must follow it too.
    if (!area || CSS.supports("field-sizing", "content") || typeof ResizeObserver === "undefined") return
    let width: number | undefined
    const observer = new ResizeObserver(([entry]) => {
      // Its own height changes come here as well; only a change of width needs a new height.
      if (entry.contentRect.width === width) return
      width = entry.contentRect.width
      // Next frame: a height set inside the callback would loop back into it.
      requestAnimationFrame(() => fit(area))
    })
    observer.observe(area)
    return () => observer.disconnect()
  }, [])
  return (
    <textarea
      ref={own}
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-16 max-h-[60vh] w-full resize-none rounded-lg border border-input bg-transparent px-2.5 py-2 text-base transition-colors outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
        className
      )}
      onInput={(event) => { fit(event.currentTarget); onInput?.(event) }}
      {...props}
    />
  )
}

/** Where the browser cannot size it to its text, set its height to what the text needs. */
function fit(area: HTMLTextAreaElement | null) {
  if (!area || CSS.supports("field-sizing", "content")) return
  area.style.height = "auto"
  area.style.height = `${area.scrollHeight + area.offsetHeight - area.clientHeight}px`
}

export { Textarea }
