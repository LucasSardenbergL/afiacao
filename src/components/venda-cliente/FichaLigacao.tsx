// src/components/venda-cliente/FichaLigacao.tsx
// A ficha da ligação: o `FilaContextPanel` promovido (sem flag) — Fase 5 / Onda 1 do
// programa "Venda por cliente". Cabeçalho (telefone `tel:` + munição), Recomprar, Histórico,
// link para o 360 e o desfecho em 1 toque. Seções separadas e SEM score comum; "Oferecer
// também" e "Preço" entram nas Ondas 2–3 (Task 9).
import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { ExternalLink } from 'lucide-react';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { supabase } from '@/integrations/supabase/client';
import { useImpersonation } from '@/contexts/ImpersonationContext';
import { useMunicaoLigacao } from '@/hooks/useMunicaoLigacao';
import { useHistoricoCompras } from '@/hooks/useHistoricoCompras';
import { useSugestoesDoComprador } from '@/hooks/useMinhasSugestoes';
import { registrarNoLedger } from '@/lib/analytics-ledger';
import { logger } from '@/lib/logger';
import { formatPrecoOuAusente } from '@/lib/format';
import { sugestoesDeRecompra } from '@/lib/venda-cliente/sugestoes';
import { LinkTelefone } from './LinkTelefone';
import { SecaoRecomprar } from './SecaoRecomprar';
import { SecaoHistorico } from './SecaoHistorico';
import { BotoesContato } from './BotoesContato';

interface Props {
  /** comprador canônico; `null` = ficha fechada */
  compradorId: string | null;
  /** fallback de cabeçalho para item que não veio da lista de recompra (ex.: oportunidade) */
  nome?: string | null;
  telefone?: string | null;
  motivo?: string | null;
  onClose: () => void;
}

function Municao({ compradorId }: { compradorId: string }) {
  const { municao, loading, erro } = useMunicaoLigacao(compradorId);
  if (loading) return <Skeleton className="h-10 w-full" />;
  if (erro) return <p className="text-2xs text-status-warning">Não consegui ler as compras deste cliente agora.</p>;
  const dias = municao?.diasDesdeUltima ?? null;
  return (
    <dl className="grid grid-cols-2 divide-x divide-border rounded-md border">
      <div className="px-3 py-2">
        <dt className="text-2xs text-muted-foreground">Última compra</dt>
        <dd className="text-sm font-medium tabular-nums">
          {dias == null ? 'sem compra' : dias === 0 ? 'hoje' : `há ${dias} ${dias === 1 ? 'dia' : 'dias'}`}
        </dd>
      </div>
      <div className="px-3 py-2">
        <dt className="text-2xs text-muted-foreground">Ticket médio</dt>
        <dd className="text-sm font-medium tabular-nums">{formatPrecoOuAusente(municao?.ticketMedio ?? null)}</dd>
      </div>
    </dl>
  );
}

export function FichaLigacao({ compradorId, nome, telefone, motivo, onClose }: Props) {
  const comprador = useSugestoesDoComprador(compradorId);
  const historico = useHistoricoCompras(compradorId);
  const { isImpersonating } = useImpersonation();
  const itens = comprador ? sugestoesDeRecompra(comprador) : [];
  const nomeExibido = comprador?.nome ?? nome ?? 'Cliente';
  const telExibido = comprador?.telefone ?? telefone ?? null;
  const motivoExibido = comprador ? comprador.motivoEntrada : motivo ?? null;

  // 1 marcação + 1 sensor por ABERTURA (não por render): a ref zera quando a ficha fecha.
  const marcadoRef = useRef<string | null>(null);
  useEffect(() => {
    if (!compradorId) {
      marcadoRef.current = null;
      return;
    }
    if (marcadoRef.current === compradorId) return;
    marcadoRef.current = compradorId;
    void registrarNoLedger('venda.ficha_aberta', compradorId, { n_sugestoes: itens.length });
    // Na lente o uid é o do master (não é dono de nada) e o write-guard bloquearia: não chama.
    const ids = itens.map((s) => s.id);
    if (isImpersonating || ids.length === 0) return;
    void supabase.rpc('venda_marcar_mostrada', { p_ids: ids }).then(({ error }) => {
      // Fail-open: a ficha não quebra por telemetria, mas a perda fica no log.
      if (error) logger.warn('venda_marcar_mostrada falhou', { compradorId, erro: error.message });
    });
  }, [compradorId, itens, isImpersonating]);

  return (
    <Sheet open={compradorId !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <SheetContent side="right" className="w-full sm:max-w-md p-0 flex flex-col">
        {compradorId && (
          <>
            <div className="flex-1 overflow-y-auto px-5 pt-6 pb-4 space-y-5">
              <SheetHeader className="space-y-1.5 text-left">
                <SheetTitle className="text-base leading-snug pr-6">{nomeExibido}</SheetTitle>
                {motivoExibido && <SheetDescription className="text-2xs">{motivoExibido}</SheetDescription>}
                <LinkTelefone telefone={telExibido} compradorId={compradorId} origem="ficha" variante="destaque" className="pt-1" />
              </SheetHeader>

              <Municao compradorId={compradorId} />

              {itens.length > 0 && (
                <SecaoRecomprar itens={itens} produtos={historico.historico?.produtos ?? null} historicoErro={historico.erro} />
              )}

              <SecaoHistorico historico={historico.historico} loading={historico.loading} erro={historico.erro} />

              <Button asChild variant="ghost" size="sm" className="gap-1 text-2xs px-0 h-auto">
                <Link to={`/admin/customers/${compradorId}/360`}>
                  <ExternalLink className="w-3.5 h-3.5" /> Ver ficha completa do cliente
                </Link>
              </Button>
            </div>

            <div className="border-t bg-background px-5 py-4">
              <BotoesContato compradorId={compradorId} />
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
