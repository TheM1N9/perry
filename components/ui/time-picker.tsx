"use client"

import * as React from "react"
import { NumberField as NumberFieldPrimitive } from "@base-ui/react/number-field"
import { cn } from "cn"
import { ClockIcon } from "lucide-react"

/** "07:30" as its hours and minutes; null for anything else. */
function parseTime(value: string | undefined): [number, number] | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value ?? "")
  if (!match) return null
  const hours = Number(match[1])
  const minutes = Number(match[2])
  return hours < 24 && minutes < 60 ? [hours, minutes] : null
}

const pad = (n: number) => String(n).padStart(2, "0")

function TimeSegment({
  label,
  value,
  max,
  disabled,
  id,
  onValueChange,
}: {
  label: string
  value: number | null
  max: number
  disabled?: boolean
  id?: string
  onValueChange: (value: number) => void
}) {
  return (
    <NumberFieldPrimitive.Root
      id={id}
      value={value}
      min={0}
      max={max}
      disabled={disabled}
      format={{ minimumIntegerDigits: 2, useGrouping: false }}
      onValueChange={(next) => {
        if (next !== null && Number.isInteger(next) && next >= 0 && next <= max) onValueChange(next)
      }}
    >
      <NumberFieldPrimitive.Input
        aria-label={label}
        onFocus={(event) => event.currentTarget.select()}
        className="w-[2.5ch] bg-transparent text-center tabular-nums outline-none selection:bg-primary/20 disabled:cursor-not-allowed"
      />
    </NumberFieldPrimitive.Root>
  )
}

/**
 * A time of day, 24-hour, as "HH:MM": the hours and the minutes each typed,
 * or stepped with the arrow keys (by ten with Shift). Drawn in Perry's own
 * look, where the browser's time field opens a picker of its own.
 */
function TimePicker({
  value,
  onValueChange,
  id,
  disabled,
  className,
  onBlur,
  "aria-label": label = "Time",
}: {
  value: string | undefined
  onValueChange: (value: string) => void
  /** The hours field's id, for a label's htmlFor. */
  id?: string
  disabled?: boolean
  className?: string
  /** Focus has left both fields. */
  onBlur?: () => void
  "aria-label"?: string
}) {
  const time = parseTime(value)
  const hours = time?.[0] ?? null
  const minutes = time?.[1] ?? null
  return (
    <div
      role="group"
      aria-label={label}
      data-slot="time-picker"
      data-disabled={disabled || undefined}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onBlur?.()
      }}
      className={cn(
        "inline-flex h-8 w-fit items-center gap-0.5 rounded-lg border border-input bg-transparent px-2.5 text-base transition-colors data-disabled:pointer-events-none data-disabled:bg-input/50 data-disabled:opacity-50 md:text-sm dark:bg-input/30 dark:data-disabled:bg-input/80",
        className
      )}
    >
      <ClockIcon className="mr-1.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
      <TimeSegment id={id} label={`${label}: hours`} value={hours} max={23} disabled={disabled}
        onValueChange={(next) => onValueChange(`${pad(next)}:${pad(minutes ?? 0)}`)} />
      <span className="text-muted-foreground" aria-hidden>:</span>
      <TimeSegment label={`${label}: minutes`} value={minutes} max={59} disabled={disabled}
        onValueChange={(next) => onValueChange(`${pad(hours ?? 0)}:${pad(next)}`)} />
    </div>
  )
}

export { TimePicker, parseTime }
