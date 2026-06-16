// Células de apresentação da linha de pedido (preço com delta + badge de confiança).
// Extraídas verbatim de src/components/reposicao/CicloHojePanel.tsx (god-component split).
import { Info } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { formatBRL } from "@/lib/reposicao";
import type { PedidoItem } from "@/types/reposicao";
import { inferConfianca } from "./confianca";

export function PrecoCell({ row }: { row: PedidoItem }) {
  const atual = Number(row.valor_total ?? 0);
  const anterior = Number(row.pedido_anterior_valor ?? NaN);
  if (!Number.isFinite(anterior) || anterior === 0) {
    return <span className="font-medium">{formatBRL(atual)}</span>;
  }
  const deltaPct = ((atual - anterior) / anterior) * 100;
  const tone =
    Math.abs(deltaPct) < 0.5
      ? "text-muted-foreground"
      : deltaPct < 0
        ? "text-status-success"
        : "text-destructive";
  return (
    <div className="flex flex-col items-end">
      <span className="font-medium">{formatBRL(atual)}</span>
      <span className={`text-[11px] ${tone}`}>
        {deltaPct > 0 ? "+" : ""}
        {deltaPct.toFixed(1)}%
      </span>
    </div>
  );
}

export function ConfiancaBadge({ row }: { row: PedidoItem }) {
  const { level, reason } = inferConfianca(row);
  const map = {
    alta: { label: "Alta", cls: "bg-status-success-bg text-status-success border-status-success/40" },
    media: { label: "Média", cls: "bg-status-warning-bg text-status-warning border-status-warning/40" },
    baixa: { label: "Baixa", cls: "bg-muted text-muted-foreground border-border" },
  } as const;
  const m = map[level];
  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-medium ${m.cls}`}
          >
            <Info className="h-3 w-3" /> {m.label}
          </span>
        </TooltipTrigger>
        <TooltipContent className="max-w-[240px] text-xs">{reason}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
