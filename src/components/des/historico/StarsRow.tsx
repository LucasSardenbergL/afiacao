// Linha de estrelas da faixa DES.
// Extraído verbatim de src/components/des/HistoricoTab.tsx (god-component split).
import { Star } from "lucide-react";
import { cn } from "@/lib/utils";

export function StarsRow({ count, max = 6 }: { count: number; max?: number }) {
  return (
    <div className="flex items-center gap-0.5">
      {Array.from({ length: max }).map((_, i) => (
        <Star
          key={i}
          className={cn(
            "h-3.5 w-3.5",
            i < count ? "fill-amber-400 text-amber-400" : "text-muted-foreground/30",
          )}
        />
      ))}
    </div>
  );
}
