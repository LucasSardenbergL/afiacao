import { cn } from "@/lib/utils";

/**
 * Skeleton com shimmer gradient (Vercel/Linear style) — substitui o pulse genérico.
 * A utility .shimmer é definida em src/index.css (gradient horizontal animado).
 */
function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "rounded-md bg-muted overflow-hidden relative animate-shimmer",
        className,
      )}
      {...props}
    />
  );
}

export { Skeleton };
