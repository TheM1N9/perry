import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"

const alertVariants = cva(
  "group/alert relative grid w-full grid-cols-[minmax(0,1fr)] gap-y-1 rounded-lg border p-3 text-left text-sm has-[>svg]:grid-cols-[auto_minmax(0,1fr)] has-[>svg]:gap-x-2 sm:has-data-[slot=alert-action]:grid-cols-[minmax(0,1fr)_auto] sm:has-[>svg]:has-data-[slot=alert-action]:grid-cols-[auto_minmax(0,1fr)_auto] *:[svg]:row-span-2 *:[svg]:translate-y-0.5 *:[svg]:text-current *:[svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-card text-card-foreground",
        destructive:
          "bg-card text-destructive *:data-[slot=alert-description]:text-destructive/90 *:[svg]:text-current",
        // Information, not trouble: words on the page, with no border or fill.
        quiet: "border-transparent bg-transparent px-0 *:[svg]:text-muted-foreground",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Alert({
  className,
  variant,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
  return (
    <div
      data-slot="alert"
      role={variant === "quiet" ? "status" : "alert"}
      className={cn(alertVariants({ variant }), className)}
      {...props}
    />
  )
}

function AlertTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-title"
      className={cn(
        "col-start-1 min-w-0 font-medium group-has-[>svg]/alert:col-start-2 [&_a]:underline [&_a]:underline-offset-3 [&_a]:hover:text-foreground",
        className
      )}
      {...props}
    />
  )
}

function AlertDescription({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-description"
      className={cn(
        "col-start-1 min-w-0 text-sm text-balance text-muted-foreground group-has-[>svg]/alert:col-start-2 md:text-pretty [&_a]:underline [&_a]:underline-offset-3 [&_a]:hover:text-foreground [&_p:not(:last-child)]:mb-4",
        className
      )}
      {...props}
    />
  )
}

function AlertAction({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-action"
      className={cn("col-start-1 row-start-3 mt-2 flex flex-wrap items-center gap-2 group-has-[>svg]/alert:col-start-2 sm:col-start-2 sm:row-span-2 sm:row-start-1 sm:mt-0 sm:ml-4 sm:self-center sm:group-has-[>svg]/alert:col-start-3", className)}
      {...props}
    />
  )
}

export { Alert, AlertTitle, AlertDescription, AlertAction }
