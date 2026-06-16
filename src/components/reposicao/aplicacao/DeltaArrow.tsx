// Indicador de delta (atual → novo, com %) da tela de Aplicação no Omie.
// Extraído de src/pages/AdminReposicaoAplicacao.tsx (god-component split).
import { ArrowRight } from "lucide-react";

function deltaPct(novo: number | null, atual: number | null): number | null {
  if (novo == null) return null;
  if (atual == null || atual === 0) return null;
  return ((novo - atual) / atual) * 100;
}

export function DeltaArrow({ novo, atual }: { novo: number | null; atual: number | null }) {
  const pct = deltaPct(novo, atual);
  return (
    <div className="flex items-center gap-1 text-xs whitespace-nowrap">
      <span className="text-muted-foreground">{atual ?? "—"}</span>
      <ArrowRight className="h-3 w-3 text-muted-foreground" />
      <span className="font-medium">{novo ?? "—"}</span>
      {pct != null && (
        <span
          className={
            Math.abs(pct) > 25
              ? "text-destructive ml-1"
              : Math.abs(pct) > 10
              ? "text-warning ml-1"
              : "text-muted-foreground ml-1"
          }
        >
          ({pct > 0 ? "+" : ""}
          {pct.toFixed(0)}%)
        </span>
      )}
    </div>
  );
}
