// Painel lateral (read-only) com o conteúdo de um pedido de venda.
// Abre ao clicar no card da listagem — ver itens/valores/observações sem sair
// da lista, e disparar Imprimir / Compartilhar / Editar.
// Abre JÁ com o que a linha sabe (cliente, PV, status, total, data) no cabeçalho; só o corpo espera o
// detalhe (skeleton). Falha do detalhe → mensagem + "Tentar de novo", sem derrubar o cabeçalho.
import { useState } from 'react';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Printer, Share2, Pencil, RotateCcw, ShieldAlert, AlertTriangle } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { formatarDataPedido } from '@/lib/pedido/data-pedido';
import { ExcecaoCreditoDialog } from '@/components/unified-order/ExcecaoCreditoDialog';
import { AvisoLeituraFalhou } from '@/components/leitura/AvisoLeituraFalhou';
import { resolverDescontoCupom } from '@/components/sales/print/descontoCupom';
import { receitaLiquidaItem } from '@/lib/pedido/desconto-item';
import { podeEditarPedido, rotuloEmpresa, statusDoPedido, type SalesOrder } from './types';
import { itemTotal, motivoSemDocumento } from './print';
import { descontosDoPainel, type FatiaDescontosItens } from './descontosDoPainel';
import { formatPrecoOuAusente } from '@/lib/format';

interface SalesOrderDetailSheetProps {
  // O painel abre antes do detalhe chegar (busca por id sob demanda) — `open`
  // controla o Sheet e `loading` mostra o estado enquanto `order` é null.
  open: boolean;
  loading?: boolean;
  /** A busca do detalhe falhou (≠ ainda carregando): mostra a falha e o "Tentar de novo". */
  erro?: boolean;
  onRetry?: () => void;
  order: SalesOrder | null;
  /**
   * O que a LINHA da listagem já sabe — o cabeçalho aparece com isso antes do detalhe chegar.
   * Quando o detalhe chega, ele manda (é a leitura mais fresca).
   */
  resumo?: ResumoDoPedido | null;
  customerName: string;
  /**
   * A query de `order_items` do pedido (`useDescontosItensPedido`), INTEIRA: estado junto com o dado.
   * É dela que sai o desconto de cada item — sem o estado, "não consegui ler" chegaria como "sem desconto".
   */
  descontosItens: FatiaDescontosItens;
  onClose: () => void;
  onPrint: () => void;
  onShare: () => void;
  onEdit: () => void;
  /** "Repetir pedido": abre o wizard com cliente + itens deste pedido. */
  onRepeat?: () => void;
  /**
   * Repassado ao Sheet: o painel é controlado SEM trigger, então quem abriu (a linha) decide para
   * onde o foco volta ao fechar.
   */
  onCloseAutoFocus?: (e: Event) => void;
}

/** Campos da linha da listagem que bastam para o cabeçalho do painel. */
interface ResumoDoPedido {
  status: string;
  account?: string | null;
  /** Nº do PV no Omie (com zeros à esquerda, como vem da view). */
  pv?: string | null;
  total: number | null;
  created_at?: string | null;
}

// Era `(v || 0).toLocaleString(...)`: o `|| 0` engolia o preco ausente e exibia R$ 0,00,
// afirmando "de graca" onde o Omie apenas nao informou. Ausente agora aparece como "-".
const fmt = formatPrecoOuAusente;


// ── Desconto de item: a régua do cupom impresso (`resolverDescontoCupom`, #2502) na tela ─────────────
// O jsonb `items` é BRUTO e o cabeçalho (`subtotal`/`total`) é LÍQUIDO desde o #2469. A quebra — desconto
// na sublinha, líquido na linha, Subtotal bruto / Desconto / Total — só aparece quando a conta FECHA em
// centavos; sem quebra (não fecha, sem desconto a explicar, leitura que não aconteceu) a tela é a de hoje.

/** Sufixo da sublinha do item na quebra: "—" quando não apurado (nunca R$ 0,00); zero apurado não acrescenta nada. */
function sufixoDesconto(desconto: number | null | undefined): string | null {
  if (desconto === 0) return null;
  return typeof desconto === 'number' ? ` · desconto - ${fmt(desconto)}` : ' · desconto —';
}

/** Com linha não apurada, o rótulo diz quantos itens entraram no desconto — o mesmo do cupom. */
function rotuloDesconto(apurados: number, itens: number): string {
  return apurados < itens ? `Desconto (${apurados} de ${itens} itens)` : 'Desconto';
}

export function SalesOrderDetailSheet({
  open,
  loading,
  erro = false,
  onRetry,
  order,
  resumo,
  customerName,
  descontosItens,
  onClose,
  onPrint,
  onShare,
  onEdit,
  onRepeat,
  onCloseAutoFocus,
}: SalesOrderDetailSheetProps) {
  // Cabeçalho: o detalhe manda quando chega; até lá, o resumo da linha.
  const cab = order
    ? { status: order.status, account: order.account, pv: order.omie_numero_pedido, total: order.total, created_at: order.created_at }
    : resumo ?? null;
  const status = cab ? statusDoPedido(cab.status) : null;
  const accountLabel = rotuloEmpresa(cab?.account ?? undefined);
  const pv = cab?.pv ? cab.pv.replace(/^0+/, '') || '0' : null;
  // Trava de crédito (Fase 2): ponto de aprovação do gestor FORA do wizard — a
  // vendedora manda o resumo (WhatsApp), o gestor abre o pedido aqui e aprova.
  const [excecaoOpen, setExcecaoOpen] = useState(false);
  const contaComGate = order?._source !== 'afiacao' && (order?.account === 'oben' || order?.account === 'colacor');
  const leituraDesconto = order ? descontosDoPainel(order, descontosItens) : null;
  const desconto = order && leituraDesconto ? resolverDescontoCupom(order.items || [], leituraDesconto.leitura, order.total) : null;
  const quebra = desconto && desconto.quebra ? desconto : null;
  // Desconto apurado que NÃO fecha com o total: as linhas ficam brutas sob um total líquido — a
  // diferença precisa estar dita na tela, não só no toast do cupom (revisão /sales #23).
  const divergencia = desconto && !desconto.quebra ? desconto.divergencia ?? null : null;
  const falhaDesconto = leituraDesconto?.falha ?? null;
  // Cupom/WhatsApp não saem com itens ilegíveis nem como outra empresa — a mesma recusa do clique.
  const motivoBloqueio = order ? motivoSemDocumento(order) : null;
  const documentoBloqueado = motivoBloqueio !== null;

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full sm:max-w-md overflow-y-auto flex flex-col" onCloseAutoFocus={onCloseAutoFocus}>
        {cab && (
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2 flex-wrap text-base">
              <span className="truncate">{customerName}</span>
              <Badge variant="outline" className="text-[10px] px-1.5 py-0 shrink-0">
                {accountLabel}
              </Badge>
              {status && (
                <Badge variant={status.variant} className="shrink-0">
                  {status.label}
                </Badge>
              )}
            </SheetTitle>
            <SheetDescription className="text-xs">
              {pv && (
                <>
                  PV <span className="font-tabular text-foreground">{pv}</span>
                  {' · '}
                </>
              )}
              {cab.created_at && (
                <>
                  {formatarDataPedido(cab.created_at)}
                  {' · '}
                </>
              )}
              <span className="font-tabular text-foreground">{fmt(cab.total)}</span>
            </SheetDescription>
          </SheetHeader>
        )}
        {!cab && open && (
          // Sem resumo nem detalhe (não deveria acontecer pela listagem): o título é obrigatório no diálogo.
          <SheetHeader>
            <SheetTitle className="text-base">{customerName}</SheetTitle>
            <SheetDescription className="sr-only">Detalhe do pedido</SheetDescription>
          </SheetHeader>
        )}
        {/* Status persistente (fora do trecho que troca): o leitor de tela ouve "carregando" → "carregado". */}
        {open && (
          <p role="status" className="sr-only">
            {order ? 'Pedido carregado' : loading ? 'Carregando o pedido…' : ''}
          </p>
        )}
        {!order && loading && (
          <div className="flex-1 space-y-3 py-4" data-testid="detalhe-carregando" aria-hidden>
            <Skeleton className="h-3 w-24" />
            {[0, 1, 2].map((i) => (
              <div key={i} className="flex items-start justify-between gap-3 border-b border-border/50 pb-2">
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-4 w-3/4" />
                  <Skeleton className="h-3 w-1/3" />
                </div>
                <Skeleton className="h-4 w-16" />
              </div>
            ))}
          </div>
        )}
        {!order && !loading && open && (
          <div role="alert" className="flex flex-col items-center gap-3 pt-8 text-center">
            <AlertTriangle className="h-5 w-5 text-status-warning" aria-hidden />
            <p className="text-sm text-muted-foreground">
              {erro ? 'Não foi possível carregar o pedido.' : 'Não encontrei o detalhe deste pedido.'}
            </p>
            {onRetry && (
              <Button variant="outline" size="sm" onClick={onRetry}>
                Tentar de novo
              </Button>
            )}
          </div>
        )}
        {order && (
          <>
            <div className="flex-1 space-y-4 py-4">
              {/* Itens */}
              <div>
                <p className="text-xs font-medium text-muted-foreground mb-2 uppercase tracking-wide">
                  Itens ({order.items?.length || 0})
                </p>
                <div className="space-y-2">
                  {(order.items || []).map((item, i) => (
                    <div key={i} className="flex items-start justify-between gap-3 text-sm border-b border-border/50 pb-2 last:border-0">
                      <div className="min-w-0 flex-1">
                        <p className="truncate">{item.descricao || 'Item'}</p>
                        {item.tint_nome_cor && (
                          <p className="text-xs text-muted-foreground truncate">
                            🎨 {item.tint_cor_id ? `${item.tint_cor_id} - ` : ''}{item.tint_nome_cor}
                          </p>
                        )}
                        <p className="text-xs text-muted-foreground">
                          {item.quantidade} × {fmt(item.valor_unitario)}
                          {quebra && sufixoDesconto(quebra.descontoPorItem[i])}
                        </p>
                      </div>
                      <span className="font-medium tabular-nums shrink-0">
                        {fmt(quebra ? receitaLiquidaItem(item.valor_unitario, item.quantidade, quebra.descontoPorItem[i]) : itemTotal(item))}
                      </span>
                    </div>
                  ))}
                  {/* Ilegível ≠ vazio (revisão /sales #27): o jsonb não é lista — não se sabe o que há. */}
                  {order.itensIlegiveis ? (
                    <p role="alert" data-testid="itens-ilegiveis" className="text-sm text-status-error">
                      Não foi possível ler os itens deste pedido. Cupom e WhatsApp ficam bloqueados até a leitura voltar.
                    </p>
                  ) : (order.items?.length || 0) === 0 && (
                    <p className="text-sm text-muted-foreground">Sem itens neste pedido.</p>
                  )}
                </div>
              </div>

              {/* Desconto dos itens que não se conseguiu ler: a tela de hoje, e não "sem desconto" */}
              {falhaDesconto && (
                <AvisoLeituraFalhou oque="o desconto dos itens" estado={falhaDesconto} testId="aviso-desconto-itens" />
              )}

              {divergencia && (
                <p role="status" data-testid="aviso-desconto-divergente" className="text-xs text-status-warning">
                  Há {fmt(divergencia.apurado)} de desconto nos itens que não fecha com o total gravado
                  ({fmt(divergencia.totalGravado)}). Os itens aparecem pelo valor bruto.
                </p>
              )}

              {/* Totais */}
              <div className="space-y-1 text-sm border-t border-border pt-3">
                <div className="flex justify-between text-muted-foreground">
                  <span>Subtotal</span>
                  <span className="tabular-nums">{fmt(quebra ? quebra.subtotalBruto : order.subtotal)}</span>
                </div>
                {quebra && (
                  <div className="flex justify-between text-muted-foreground">
                    <span>{rotuloDesconto(quebra.itensApurados, order.items?.length || 0)}</span>
                    <span className="tabular-nums">- {fmt(quebra.descontoTotal)}</span>
                  </div>
                )}
                <div className="flex justify-between font-semibold text-base">
                  <span>Total</span>
                  <span className="tabular-nums">{fmt(order.total)}</span>
                </div>
              </div>

              {/* Observações */}
              {order.notes && (
                <div>
                  <p className="text-xs font-medium text-muted-foreground mb-1 uppercase tracking-wide">
                    Observações
                  </p>
                  <p className="text-sm whitespace-pre-wrap">{order.notes}</p>
                </div>
              )}
            </div>

            {/* Ações */}
            {motivoBloqueio && !order.itensIlegiveis && (
              <p data-testid="documento-bloqueado" className="text-xs text-status-warning">{motivoBloqueio}</p>
            )}
            <div className="flex gap-2 border-t border-border pt-4">
              <Button onClick={onPrint} className="flex-1 gap-2" disabled={documentoBloqueado}>
                <Printer className="w-4 h-4" />
                Imprimir
              </Button>
              {/* Repetir: só pedidos comerciais com itens (afiação tem outro formato de item) */}
              {onRepeat && order._source !== 'afiacao' && (order.items?.length || 0) > 0 && (
                <Button variant="outline" onClick={onRepeat} className="gap-2" title="Repetir este pedido num pedido novo">
                  <RotateCcw className="w-4 h-4" />
                  Repetir
                </Button>
              )}
              <Button variant="outline" onClick={onShare} className="gap-2" disabled={documentoBloqueado}>
                <Share2 className="w-4 h-4" />
                Compartilhar
              </Button>
              {contaComGate && (
                <Button
                  variant="outline"
                  onClick={() => setExcecaoOpen(true)}
                  className="gap-2"
                  title="Exceção de crédito (pedido travado pelo gate)"
                >
                  <ShieldAlert className="w-4 h-4" />
                </Button>
              )}
              {podeEditarPedido(order) && (
                <Button variant="outline" onClick={onEdit} className="gap-2" title="Editar pedido">
                  <Pencil className="w-4 h-4" />
                </Button>
              )}
            </div>

            {/* Monta SÓ quando aberto: o dialog puxa auth/lente/react-query — montar
                fechado exigiria providers em todo teste/uso do sheet. */}
            {contaComGate && excecaoOpen && (
              <ExcecaoCreditoDialog
                open={excecaoOpen}
                onOpenChange={setExcecaoOpen}
                salesOrderId={order.id}
                nomeCliente={customerName}
              />
            )}
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
