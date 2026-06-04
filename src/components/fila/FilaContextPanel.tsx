// src/components/fila/FilaContextPanel.tsx
// Painel lateral de contexto de um item da fila (G1 Fase 3, flag-gated).
// Reusa AcaoOutcomeMenu (outcomes) e adiciona contexto + "Continuar pedido".
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Badge } from '@/components/ui/badge';
import type { AcaoSugerida, CategoriaAcao } from '@/lib/fila/types';

const CAT_LABEL: Record<CategoriaAcao, string> = {
  prazo: 'Prazo', certo: 'Certo', esperado: 'Oportunidade', risco: 'Risco',
};

interface Props {
  acao: AcaoSugerida | null;
  onClose: () => void;
}

/** Conteúdo por fonte entra na Task 2. Aqui só o casulo (Sheet + header). */
export function FilaContextPanel({ acao, onClose }: Props) {
  return (
    <Sheet open={acao !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <SheetContent side="right" className="w-full sm:max-w-md overflow-y-auto">
        {acao && (
          <>
            <SheetHeader>
              <SheetTitle className="text-base">{acao.clienteNome ?? acao.titulo}</SheetTitle>
              <div className="flex items-center gap-2 text-2xs text-muted-foreground">
                <Badge variant="outline" className="text-2xs">{CAT_LABEL[acao.categoria]}</Badge>
                <span>{acao.motivo}</span>
              </div>
            </SheetHeader>
            <div className="mt-4 text-sm text-muted-foreground">{/* conteúdo por kind — Task 2 */}</div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
