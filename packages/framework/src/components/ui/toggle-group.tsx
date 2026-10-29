import * as React from "react"
import { Toggle as TogglePrimitive } from "@base-ui/react/toggle"
import { ToggleGroup as ToggleGroupPrimitive } from "@base-ui/react/toggle-group"
import { type VariantProps } from "class-variance-authority"

import { toggleVariants } from "@/components/ui/toggle.js"
import { cn } from "@/lib/utils.js"

const ToggleGroupContext = React.createContext<
  VariantProps<typeof toggleVariants> & {
    orientation?: "horizontal" | "vertical"
  }
>({
  size: "default",
  variant: "default",
  orientation: "horizontal",
})

// A pill group: an outlined pill holding pill toggles, the pressed one filled with the
// muted surface. The same shape as the tab list, so a choice reads as one control.
function ToggleGroup({
  className,
  variant,
  size,
  orientation = "horizontal",
  children,
  ...props
}: ToggleGroupPrimitive.Props &
  VariantProps<typeof toggleVariants> & {
    orientation?: "horizontal" | "vertical"
  }) {
  return (
    <ToggleGroupPrimitive
      data-slot="toggle-group"
      data-variant={variant}
      data-size={size}
      data-orientation={orientation}
      className={cn(
        "group/toggle-group flex w-fit flex-row flex-wrap items-center gap-0.5 rounded-full border border-border/70 p-0.5 data-vertical:flex-col data-vertical:items-stretch",
        className
      )}
      {...props}
    >
      <ToggleGroupContext.Provider value={{ variant, size, orientation }}>
        {children}
      </ToggleGroupContext.Provider>
    </ToggleGroupPrimitive>
  )
}

function ToggleGroupItem({
  className,
  children,
  variant = "default",
  size = "default",
  ...props
}: TogglePrimitive.Props & VariantProps<typeof toggleVariants>) {
  const context = React.useContext(ToggleGroupContext)

  return (
    <TogglePrimitive
      data-slot="toggle-group-item"
      data-variant={context.variant || variant}
      data-size={context.size || size}
      className={cn(
        "shrink-0 focus:z-10 focus-visible:z-10",
        toggleVariants({
          variant: context.variant || variant,
          size: context.size || size,
        }),
        className
      )}
      {...props}
    >
      {children}
    </TogglePrimitive>
  )
}

export { ToggleGroup, ToggleGroupItem }
