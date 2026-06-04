// src/components/fila/FilaContextPanel.tsx
// Painel lateral de contexto de um item da fila (G1 Fase 3, flag-gated).
// Reusa AcaoOutcomeMenu (outcomes) e adiciona contexto + "Continuar pedido".
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Link } from 'react-router-dom';
import { Phone, ExternalLink } from 'lucide-react';
import { track } from '@/lib/analytics';
import { AcaoOutcomeMenu } from './AcaoOutcomeMenu';
import type { AcaoSugerida, CategoriaAcao } from '@/lib/fila/types';

const CAT_LABEL: Record<CategoriaAcao, string> = {
  prazo: 'Prazo', certo: 'Certo', esperado: 'Oportunidade', risco: 'Risco',
};

interface Props {
  acao: AcaoSugerida | null;
  onClose: () => void;
  onNaoUtilAgora: (dedupeKey: string) => void;
}

/** Conteúdo por fonte — Task 2. */
export function FilaContextPanel({ acao, onClose, onNaoUtilAgora }: Props) {
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
            <div className="mt-4 space-y-4">
              {acao.telefone && (
                <Button asChild variant="outline" className="w-full justify-start gap-2">
                  <a href={`tel:${acao.telefone.replace(/\D/g, '')}`}>
                    <Phone className="w-4 h-4" /> Ligar para {acao.clienteNome ?? 'cliente'}
                  </a>
                </Button>
              )}

              {acao.payload.kind === 'mixgap' && (
                <div className="rounded-md border p-3 text-2xs text-muted-foreground">
                  Oportunidade: oferecer <span className="font-medium text-foreground">{acao.payload.familia}</span>. {acao.motivo}
                </div>
              )}

              {acao.cta === 'pedido' && acao.clienteUserId && (
                <Button asChild className="w-full">
                  <Link
                    to={`/sales/new?customer=${acao.clienteUserId}&returnTo=${encodeURIComponent('/meu-dia')}`}
                    onClick={() => track('fila.pedido_iniciado', { fonte: acao.fonte, dedupeKey: acao.dedupeKey })}
                  >
                    Continuar pedido
                  </Link>
                </Button>
              )}

              <div className="flex items-center justify-between gap-2">
                <AcaoOutcomeMenu acao={acao} onNaoUtilAgora={(k) => { onNaoUtilAgora(k); onClose(); }} />
                {acao.clienteUserId && (
                  <Button asChild variant="ghost" size="sm" className="gap-1 text-2xs">
                    <Link to={`/admin/customers/${acao.clienteUserId}/360`}>
                      <ExternalLink className="w-3.5 h-3.5" /> Ver ficha completa
                    </Link>
                  </Button>
                )}
              </div>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
