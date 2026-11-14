// src/components/venda-cliente/FichaLigacao.tsx
// A ficha da ligação: o `FilaContextPanel` promovido (sem flag) — Fase 5 / Onda 1 do
// programa "Venda por cliente". Cabeçalho (telefone `tel:` + munição), Recomprar, Histórico,
// link para o 360 e o desfecho em 1 toque. Seções separadas e SEM score comum; "Oferecer
// também" (Onda 2) e "Preço" (Onda 3) entram entre Recomprar e Histórico quando o SERVIDOR liga
// a onda (Task 9) — sem a onda ligada, a seção não existe.
import { useEffect, useMemo, useRef } from 'react';
import { Link } from 'react-router-dom';
import { ExternalLink } from 'lucide-react';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { supabase } from '@/integrations/supabase/client';
import { useImpersonation } from '@/contexts/ImpersonationContext';
import { useMunicaoLigacao } from '@/hooks/useMunicaoLigacao';
import { useHistoricoCompras } from '@/hooks/useHistoricoCompras';
import { useOndasVenda, useSugestoesDoComprador } from '@/hooks/useMinhasSugestoes';
import { useComplementoComprador } from '@/hooks/useComplementoComprador';
import { useHerancaComprador } from '@/hooks/useHerancaComprador';
import { usePrecoAlvoComprador } from '@/hooks/usePrecoAlvoComprador';
import { registrarNoLedger } from '@/lib/analytics-ledger';
import { logger } from '@/lib/logger';
import { formatPrecoOuAusente } from '@/lib/format';
import { sugestoesDeComplemento, sugestoesDePreco, sugestoesDeRecompra, sugestoesDeSistema } from '@/lib/venda-cliente/sugestoes';
import { alvoDaSugestao } from '@/lib/venda-cliente/preco';
import { familiasHerdadas, textoHeranca } from '@/lib/venda-cliente/heranca';
import { LinkTelefone } from './LinkTelefone';
import { SecaoRecomprar } from './SecaoRecomprar';
import { SecaoComplemento } from './SecaoComplemento';
import { SecaoSistema } from './SecaoSistema';
import { SecaoPreco } from './SecaoPreco';
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
  const ondas = useOndasVenda();
  const historico = useHistoricoCompras(compradorId);
  const { isImpersonating } = useImpersonation();
  const itens = useMemo(() => (comprador ? sugestoesDeRecompra(comprador) : []), [comprador]);
  const complementos = useMemo(
    () => (comprador && ondas.complemento ? sugestoesDeComplemento(comprador) : []),
    [comprador, ondas.complemento],
  );
  const precos = useMemo(() => (comprador && ondas.preco ? sugestoesDePreco(comprador) : []), [comprador, ondas.preco]);
  const sistemas = useMemo(
    () => (comprador && ondas.sistema ? sugestoesDeSistema(comprador) : []),
    [comprador, ondas.sistema],
  );
  const complemento = useComplementoComprador(compradorId, complementos.length > 0 && !isImpersonating);
  const preco = usePrecoAlvoComprador(compradorId, precos.length > 0 && !isImpersonating);
  const heranca = useHerancaComprador(compradorId);
  const nHerdadas = itens.filter((s) => s.heranca).length;
  const herdadasComplemento = useMemo(() => familiasHerdadas(heranca.herancas ?? []), [heranca.herancas]);
  const nomeExibido = comprador?.nome ?? nome ?? 'Cliente';
  const telExibido = comprador?.telefone ?? telefone ?? null;
  const motivoExibido = comprador ? comprador.motivoEntrada : motivo ?? null;

  // O que a farmer VÊ nesta abertura: recompra, complemento e sistema ao abrir; preço só quando o alvo
  // foi de fato exibido (repasse confirmado ao vivo) — "mostrada" sem alvo na tela seria falsa.
  const idsExibidos = useMemo(() => [
    ...itens.map((s) => s.id),
    ...complementos.map((s) => s.id),
    ...sistemas.map((s) => s.id),
    ...precos.filter((s) => alvoDaSugestao(s, preco.alvos) !== undefined).map((s) => s.id),
  ], [itens, complementos, sistemas, precos, preco.alvos]);

  // 1 sensor por ABERTURA (não por render) e cada id marcado 1× por abertura: a ref zera quando
  // a ficha fecha ou troca de comprador.
  const aberturaRef = useRef<{ compradorId: string | null; marcados: Set<string> }>({ compradorId: null, marcados: new Set() });
  useEffect(() => {
    if (!compradorId) {
      aberturaRef.current = { compradorId: null, marcados: new Set() };
      return;
    }
    if (aberturaRef.current.compradorId === compradorId) return;
    aberturaRef.current = { compradorId, marcados: new Set() };
    // n_herdadas (sucessor declarado): o sinal de uso da herança, com o denominador n_sugestoes ao lado.
    void registrarNoLedger('venda.ficha_aberta', compradorId, { n_sugestoes: itens.length, n_herdadas: nHerdadas });
  }, [compradorId, itens.length, nHerdadas]);

  useEffect(() => {
    // Na lente o uid é o do master (não é dono de nada) e o write-guard bloquearia: não chama.
    if (!compradorId || isImpersonating || aberturaRef.current.compradorId !== compradorId) return;
    const novos = idsExibidos.filter((id) => !aberturaRef.current.marcados.has(id));
    if (novos.length === 0) return;
    novos.forEach((id) => aberturaRef.current.marcados.add(id));
    void supabase.rpc('venda_marcar_mostrada', { p_ids: novos }).then(({ error }) => {
      // Fail-open: a ficha não quebra por telemetria, mas a perda fica no log.
      if (error) logger.warn('venda_marcar_mostrada falhou', { compradorId, erro: error.message });
    });
  }, [compradorId, idsExibidos, isImpersonating]);

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

              {heranca.herancas && heranca.herancas.length > 0 && (
                <div className="rounded-md border px-3 py-2 text-2xs space-y-0.5" data-testid="ficha-heranca">
                  {heranca.herancas.map((h) => (
                    <p key={`${h.eventoId}-${h.outroDocumento}`} className="text-status-info">{textoHeranca(h)}</p>
                  ))}
                  <p className="text-muted-foreground">
                    O histórico desses itens conta para quem herdou nas sugestões de venda. Pedidos e preços não mudam.
                  </p>
                </div>
              )}
              {heranca.erro && nHerdadas > 0 && (
                <p className="text-2xs text-status-warning">Não consegui ler de onde vem o histórico herdado deste cliente.</p>
              )}

              {itens.length > 0 && (
                <SecaoRecomprar itens={itens} produtos={historico.historico?.produtos ?? null} historicoErro={historico.erro} />
              )}

              <SecaoComplemento
                ondaLigada={ondas.complemento}
                itens={complementos}
                familias={complemento.familias}
                loading={complemento.loading}
                erro={complemento.erro}
                herdadas={herdadasComplemento}
              />

              <SecaoSistema ondaLigada={ondas.sistema} itens={sistemas} />

              <SecaoPreco
                ondaLigada={ondas.preco}
                itens={precos}
                alvos={preco.alvos}
                loading={preco.loading}
                erro={preco.erro}
                produtos={historico.historico?.produtos ?? null}
              />

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
