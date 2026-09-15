// Painel lateral (read-only) com o conteúdo de um pedido de venda.
// Abre ao clicar no card da listagem — ver itens/valores/observações sem sair
// da lista, e disparar Imprimir / Compartilhar / Editar.
import { useState } from 'react';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Printer, Share2, Pencil, Loader2, RotateCcw, ShieldAlert } from 'lucide-react';
import { formatarDataPedido } from '@/lib/pedido/data-pedido';
import { ExcecaoCreditoDialog } from '@/components/unified-order/ExcecaoCreditoDialog';
import { AvisoLeituraFalhou } from '@/components/leitura/AvisoLeituraFalhou';
import { resolverDescontoCupom } from '@/components/sales/print/descontoCupom';
import { receitaLiquidaItem } from '@/lib/pedido/desconto-item';
import { statusDoPedido, type SalesOrder } from './types';
import { itemTotal } from './print';
import { descontosDoPainel, type FatiaDescontosItens } from './descontosDoPainel';
import { formatPrecoOuAusente } from '@/lib/format';

interface SalesOrderDetailSheetProps {
  // O painel abre antes do detalhe chegar (busca por id sob demanda) — `open`
  // controla o Sheet e `loading` mostra o estado enquanto `order` é null.
  open: boolean;
  loading?: boolean;
  order: SalesOrder | null;
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
}

// Era `(v || 0).toLocaleString(...)`: o `|| 0` engolia o preco ausente e exibia R$ 0,00,
// afirmando "de graca" onde o Omie apenas nao informou. Ausente agora aparece como "-".
const fmt = formatPrecoOuAusente;

// Pedido cancelado/entregue/faturado não é editável (mesma regra do card).
const canEditStatus = (status: string) => !['cancelado', 'entregue', 'faturado'].includes(status);

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
  order,
  customerName,
  descontosItens,
  onClose,
  onPrint,
  onShare,
  onEdit,
  onRepeat,
}: SalesOrderDetailSheetProps) {
  const status = order ? statusDoPedido(order.status) : null;
  const accountLabel =
    order?.account === 'colacor_sc' ? 'Colacor SC' : order?.account === 'colacor' ? 'Colacor' : 'Oben';
  const pv = order?.omie_numero_pedido ? order.omie_numero_pedido.replace(/^0+/, '') || '0' : null;
  // Trava de crédito (Fase 2): ponto de aprovação do gestor FORA do wizard — a
  // vendedora manda o resumo (WhatsApp), o gestor abre o pedido aqui e aprova.
  const [excecaoOpen, setExcecaoOpen] = useState(false);
  const contaComGate = order?._source !== 'afiacao' && (order?.account === 'oben' || order?.account === 'colacor');
  const leituraDesconto = order ? descontosDoPainel(order, descontosItens) : null;
  const desconto = order && leituraDesconto ? resolverDescontoCupom(order.items || [], leituraDesconto.leitura, order.total) : null;
  const quebra = desconto && desconto.quebra ? desconto : null;
  const falhaDesconto = leituraDesconto?.falha ?? null;

  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full sm:max-w-md overflow-y-auto flex flex-col">
        {!order && loading && (
          <div className="flex-1 flex items-center justify-center">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        )}
        {!order && !loading && open && (
          <p className="text-sm text-muted-foreground pt-8 text-center">
            Não foi possível carregar o pedido.
          </p>
        )}
        {order && (
          <>
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
                {formatarDataPedido(order.created_at)}
              </SheetDescription>
            </SheetHeader>

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
                  {(order.items?.length || 0) === 0 && (
                    <p className="text-sm text-muted-foreground">Sem itens neste pedido.</p>
                  )}
                </div>
              </div>

              {/* Desconto dos itens que não se conseguiu ler: a tela de hoje, e não "sem desconto" */}
              {falhaDesconto && (
                <AvisoLeituraFalhou oque="o desconto dos itens" estado={falhaDesconto} testId="aviso-desconto-itens" />
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
            <div className="flex gap-2 border-t border-border pt-4">
              <Button onClick={onPrint} className="flex-1 gap-2">
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
              <Button variant="outline" onClick={onShare} className="gap-2">
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
              {canEditStatus(order.status) && (
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
