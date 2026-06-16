// Barra fixa de ações em lote (aparece no modo revisão com itens selecionados).
// Extraída verbatim de src/components/reposicao/CicloHojePanel.tsx (god-component split).
import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatBRL } from "@/lib/reposicao";

interface BatchActionsBarProps {
  count: number;
  totalValue: number;
  busy: boolean;
  onReject: () => void;
  onApprove: () => void;
}

export function BatchActionsBar({ count, totalValue, busy, onReject, onApprove }: BatchActionsBarProps) {
  return (
    <div className="fixed bottom-0 left-0 right-0 z-40 border-t bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 shadow-lg">
      <div className="container max-w-7xl mx-auto px-4 py-3 flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm">
          <span className="font-semibold">{count}</span> itens selecionados |{" "}
          <span className="font-semibold">Total: {formatBRL(totalValue)}</span>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={onReject} disabled={busy}>
            <XCircle className="h-4 w-4 mr-1.5" /> Rejeitar selecionados
          </Button>
          <Button size="sm" onClick={onApprove} disabled={busy}>
            {busy ? (
              <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
            ) : (
              <CheckCircle2 className="h-4 w-4 mr-1.5" />
            )}
            Aprovar selecionados
          </Button>
        </div>
      </div>
    </div>
  );
}
