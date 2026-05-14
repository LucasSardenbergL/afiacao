import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  // transition-all (não só colors) pra captar ring + shadow no hover/active.
  // ease custom Vercel-style aplicado globalmente em button via index.css.
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md text-sm font-medium transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        // Primary com ring sutil no hover (tactility) + inner shadow no active ("press feel")
        default:
          "bg-primary text-primary-foreground shadow-sm hover:bg-primary/90 hover:ring-2 hover:ring-foreground/5 active:bg-primary/80 active:shadow-[inset_0_1px_0_hsl(0_0%_0%/0.08)]",
        destructive:
          "bg-destructive text-destructive-foreground shadow-sm hover:bg-destructive/90 hover:ring-2 hover:ring-destructive/15",
        outline:
          "border border-input bg-background hover:bg-accent hover:text-accent-foreground hover:border-foreground/20",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        // Link com underline animado da esquerda pra direita (Vercel pattern)
        link: "relative text-primary inline-block after:content-[''] after:absolute after:left-0 after:bottom-0 after:h-px after:w-0 after:bg-current after:transition-[width] after:duration-200 hover:after:w-full",
        muted: "bg-muted text-muted-foreground hover:bg-muted/80",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 rounded-md px-3 text-xs",
        lg: "h-10 rounded-md px-6",
        icon: "h-9 w-9",
        // Touch targets for operational mobile (WCAG AA min, recommended for gloved hands)
        touch: "h-11 px-5 py-2.5 text-base",          // 44px — separador / vendedor externo
        "touch-icon": "h-11 w-11",
        balcao: "h-14 px-6 py-3 text-base font-semibold",  // 56px — operador tintométrico touchscreen
        "balcao-icon": "h-14 w-14",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button"
    return (
      <Comp
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    )
  }
)
Button.displayName = "Button"

export { Button, buttonVariants }
