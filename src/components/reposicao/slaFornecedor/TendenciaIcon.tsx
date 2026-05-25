// Ícone de tendência do lead time (piorando/melhorando/estável/sem dados).
// Extraído verbatim de src/pages/AdminReposicaoSlaFornecedor.tsx (god-component split).
import { ArrowDown, ArrowRight, ArrowUp, Minus } from "lucide-react";
import type { Tendencia } from "./types";

export const TendenciaIcon = ({ t }: { t: Tendencia }) => {
  if (t === "piorando") return <ArrowUp className="h-3.5 w-3.5 text-destructive" aria-label="piorando" />;
  if (t === "melhorando") return <ArrowDown className="h-3.5 w-3.5 text-success" aria-label="melhorando" />;
  if (t === "sem_dados") return <Minus className="h-3.5 w-3.5 text-muted-foreground/50" aria-label="sem dados de tendência" />;
  return <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" aria-label="estável" />;
};
