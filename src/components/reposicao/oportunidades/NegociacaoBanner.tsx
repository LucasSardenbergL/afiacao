// Banner de sugestões de negociação paralela (Oportunidades).
// Extraído de src/pages/AdminReposicaoOportunidades.tsx (god-component split).
import { Button } from "@/components/ui/button";
import { Handshake, X } from "lucide-react";

export function NegociacaoBanner({
  count, onVerSugestoes, onFechar,
}: {
  count: number;
  onVerSugestoes: () => void;
  onFechar: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-status-info/30 bg-status-info/10 px-4 py-3 text-sm">
      <div className="flex items-center gap-2 flex-1">
        <Handshake className="h-4 w-4 text-status-info dark:text-status-info shrink-0" />
        <span>
          <strong>{count}</strong> SKU{count === 1 ? '' : 's'}{' '}
          {count === 1 ? 'foi sugerido' : 'foram sugeridos'} para negociação paralela.
        </span>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <Button size="sm" variant="outline" onClick={onVerSugestoes}>
          Ver sugestões
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          onClick={onFechar}
          aria-label="Fechar"
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
