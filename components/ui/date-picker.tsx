"use client"

import * as React from "react"
import { cn } from "cn"
import { CalendarIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { TimePicker } from "@/components/ui/time-picker"

const pad = (n: number) => String(n).padStart(2, "0")

/**
 * A day from a calendar, on this browser's clock, and with `time` the time of
 * day too, below the calendar: one button, which says both. In the calendar
 * the arrow keys move by day and week, Page Up and Down by month; picking a
 * day keeps the time, and closes it unless there is a time to set as well.
 */
function DatePicker({
  value,
  onValueChange,
  id,
  time = false,
  disabled,
  placeholder = "Pick a day",
  className,
}: {
  value: Date | undefined
  onValueChange: (value: Date) => void
  /** The button's id, for a label's htmlFor. */
  id?: string
  /** Also pick the time of day. */
  time?: boolean
  disabled?: boolean
  placeholder?: string
  className?: string
}) {
  const [open, setOpen] = React.useState(false)
  const shown = value
    ? value.toLocaleString(undefined, {
        weekday: "short",
        day: "numeric",
        month: "short",
        year: "numeric",
        ...(time ? { hour: "2-digit", minute: "2-digit" } : {}),
      })
    : placeholder
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            id={id}
            type="button"
            variant="outline"
            disabled={disabled}
            data-slot="date-picker"
            className={cn("w-full justify-start font-normal", !value && "text-muted-foreground", className)}
          />
        }
      >
        <CalendarIcon className="text-muted-foreground" />
        {shown}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto gap-0 p-0">
        <Calendar
          mode="single"
          selected={value}
          defaultMonth={value}
          autoFocus
          onSelect={(picked) => {
            if (!picked) return
            const next = new Date(picked)
            next.setHours(value?.getHours() ?? 9, value?.getMinutes() ?? 0, 0, 0)
            onValueChange(next)
            if (!time) setOpen(false)
          }}
        />
        {time && (
          <div className="flex items-center justify-between gap-3 border-t px-3 py-2.5">
            <span className="text-sm text-muted-foreground">Time</span>
            <TimePicker
              aria-label="Time"
              value={value ? `${pad(value.getHours())}:${pad(value.getMinutes())}` : undefined}
              onValueChange={(next) => {
                const [hours, minutes] = next.split(":").map(Number)
                const at = new Date(value ?? Date.now())
                at.setHours(hours, minutes, 0, 0)
                onValueChange(at)
              }}
            />
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

export { DatePicker }
