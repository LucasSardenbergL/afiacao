import { useState, useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';

import { Card, CardContent } from '@/components/ui/card';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import {
  Loader2, AlertCircle, Check, ChevronsUpDown, Calendar,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { proximosDiasUteis } from '@/components/unified-order/dias-entrega';
import type {
  ProductCartItem, ServiceCartItem, FormaPagamento,
} from '@/hooks/useUnifiedOrder';
import { findInvalidPricedProductItems } from '@/services/orderSubmission/priceGuard';
import {
  condicoesBloqueantesDoCarrinho,
  mensagemCondicoesIndisponiveis,
  ESTADO_FORMAS_UI_OK,
  type EstadoFormasUI,
} from '@/services/orderSubmission/formasDegradacao';
import { AvisoFormasPagamento } from '@/components/sales/AvisoFormasPagamento';
import { AvisoPrazoCliente } from '@/components/unified-order/AvisoPrazoCliente';
import type { ClienteComCodigos } from '@/hooks/useAlertaCreditoCliente';
import type { ContaPedido, PrazoDecisaoEstado } from '@/services/orderSubmission/prazoDecisao';

interface CartSummaryBarProps {
  cart: { length: number };
  obenProductItems: ProductCartItem[];
  colacorProductItems: ProductCartItem[];
  serviceItems: ServiceCartItem[];
  // Payment
  sortedFormasPagamentoOben: FormaPagamento[];
  sortedFormasPagamentoColacor: FormaPagamento[];
  selectedParcelaOben: string;
  setSelectedParcelaOben: (v: string) => void;
  selectedParcelaColacor: string;
  setSelectedParcelaColacor: (v: string) => void;
  loadingFormas: boolean;
  customerParcelaRankingOben: string[];
  customerParcelaRankingColacor: string[];
  /** Degradação da listagem de condições por conta (edge #1597). Default = tudo ok. */
  estadoFormasOben?: EstadoFormasUI;
  estadoFormasColacor?: EstadoFormasUI;
  onRecarregarFormas?: () => void;
  /** Frente B (PR1): aviso + sugestão de prazo para cliente com vencido, por conta. Ausente = sem aviso
   *  (autoatendimento não escolhe condição; a RPC exige staff). */
  avisoPrazo?: { cliente: (ClienteComCodigos & { razao_social?: string | null }) | null; onEstado: (conta: ContaPedido, estado: PrazoDecisaoEstado | null) => void };
  notes: string;
  setNotes: (v: string) => void;
  // Volumes (auto-calculated)
  volumesOben: number;
  volumesColacor: number;
  // Ordem de compra (exceção CNPJ específico)
  ordemCompra?: string;
  setOrdemCompra?: (v: string) => void;
  isOrdemCompraCustomer?: boolean;
  // Ready by date
  readyByDate?: string;
  setReadyByDate?: (v: string) => void;
  /** Só decide o texto do aviso de condição indisponível ("salve como orçamento"). */
  onSubmitQuote?: () => void;
}

function PaymentCombobox({
  label,
  formas,
  selected,
  onSelect,
  customerRanking,
  loading,
}: {
  label: string;
  formas: FormaPagamento[];
  selected: string;
  onSelect: (v: string) => void;
  customerRanking: string[];
  loading: boolean;
}) {
  const [open, setOpen] = useState(false);
  const selectedLabel = formas.find(f => f.codigo === selected)?.descricao || '';
  // Nome acessível no botão: o leitor anuncia "Pagamento Oben: 30/60 dias", não só "Selecione…".

  if (loading) {
    return (
      <div role="status">
        <Label className="text-xs font-medium">{label}</Label>
        <p className="flex items-center gap-1.5 mt-1 text-xs text-muted-foreground">
          <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden /> Carregando condições…
        </p>
      </div>
    );
  }

  return (
    <div>
      <Label className="text-xs font-medium">{label}</Label>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            role="combobox"
            aria-expanded={open}
            aria-label={`${label}: ${selectedLabel || 'nenhuma condição selecionada'}`}
            className="w-full justify-between text-sm h-9 mt-1 font-normal"
          >
            <span className="truncate">
              {selected ? (
                <>
                  {customerRanking.includes(selected) ? <span aria-hidden>⭐ </span> : ''}
                  {selectedLabel}
                </>
              ) : 'Selecione...'}
            </span>
            <ChevronsUpDown className="ml-2 h-3.5 w-3.5 shrink-0 opacity-50" aria-hidden />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
          <Command>
            <CommandInput placeholder="Buscar prazo... ex: 30, 60, vista" className="h-8 text-sm" />
            <CommandList>
              <CommandEmpty className="py-2 text-center text-xs text-muted-foreground">Nenhuma condição encontrada.</CommandEmpty>
              {customerRanking.length > 0 && (
                <CommandGroup heading="Condições do cliente">
                  {formas.filter(f => customerRanking.includes(f.codigo)).map(f => (
                    <CommandItem
                      key={f.codigo}
                      value={f.descricao}
                      onSelect={() => { onSelect(f.codigo); setOpen(false); }}
                      className="text-sm"
                    >
                      <Check className={cn('mr-2 h-3.5 w-3.5', selected === f.codigo ? 'opacity-100' : 'opacity-0')} />
                      ⭐ {f.descricao}
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
              <CommandGroup heading={customerRanking.length > 0 ? 'Outras condições' : 'Condições de pagamento'}>
                {formas.filter(f => !customerRanking.includes(f.codigo)).map(f => (
                  <CommandItem
                    key={f.codigo}
                    value={f.descricao}
                    onSelect={() => { onSelect(f.codigo); setOpen(false); }}
                    className="text-sm"
                  >
                    <Check className={cn('mr-2 h-3.5 w-3.5', selected === f.codigo ? 'opacity-100' : 'opacity-0')} />
                    {f.descricao}
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}

export function CartSummaryBar({
  obenProductItems, colacorProductItems, serviceItems,
  sortedFormasPagamentoOben, sortedFormasPagamentoColacor,
  selectedParcelaOben, setSelectedParcelaOben,
  selectedParcelaColacor, setSelectedParcelaColacor,
  loadingFormas, customerParcelaRankingOben, customerParcelaRankingColacor,
  estadoFormasOben = ESTADO_FORMAS_UI_OK,
  estadoFormasColacor = ESTADO_FORMAS_UI_OK,
  onRecarregarFormas, avisoPrazo,
  ordemCompra, setOrdemCompra, isOrdemCompraCustomer,
  readyByDate, setReadyByDate,
  notes, setNotes,
  onSubmitQuote,
}: CartSummaryBarProps) {
  // Guard money-path (espelha submitOrder/submitQuote): produto a preço ≤ 0 barra o envio
  // na UI antes do clique — defense-in-depth + feedback imediato (o item fica destacado no
  // carrinho). Serviço de afiação não entra (preço 0 = "a orçar" legítimo).
  const hasInvalidPrice = useMemo(
    () => findInvalidPricedProductItems([...obenProductItems, ...colacorProductItems]).length > 0,
    [obenProductItems, colacorProductItems],
  );
  // Guard money-path da condição de pagamento (espelha o submitOrder, que decide pelo MESMO
  // helper): a listagem do Omie caiu no fallback genérico E este cliente usa condição que
  // não está lá. Só as contas com item no carrinho contam. "Salvar como Orçamento" segue
  // liberado de propósito — submitQuote não grava codigo_parcela, então é a saída sem risco.
  const condicoesBloqueantes = useMemo(
    () => condicoesBloqueantesDoCarrinho([
      { temItens: obenProductItems.length > 0, estado: estadoFormasOben },
      { temItens: colacorProductItems.length > 0, estado: estadoFormasColacor },
    ]),
    [obenProductItems.length, colacorProductItems.length, estadoFormasOben, estadoFormasColacor],
  );

  // B3 (rodada 2): próximos 5 dias úteis a partir de hoje — nunca um dia que já passou.
  const diasEntrega = useMemo(() => proximosDiasUteis(new Date()), []);

  return (
    <>
      <Card>
        <CardContent className="pt-4 space-y-3">
          {obenProductItems.length > 0 && (
            <div className="space-y-1.5">
              <PaymentCombobox
                label="Pagamento Oben"
                formas={sortedFormasPagamentoOben}
                selected={selectedParcelaOben}
                onSelect={setSelectedParcelaOben}
                customerRanking={customerParcelaRankingOben}
                loading={loadingFormas}
              />
              {!loadingFormas && (
                <AvisoFormasPagamento
                  degradado={estadoFormasOben.degradado}
                  erro={estadoFormasOben.erro}
                  motivo={estadoFormasOben.motivo}
                  condicoesAusentes={estadoFormasOben.condicoesAusentes}
                  onRecarregar={onRecarregarFormas}
                />
              )}
              {!loadingFormas && avisoPrazo && (
                <AvisoPrazoCliente
                  company="oben" codigo={avisoPrazo.cliente?.codigo_cliente ?? null}
                  nomeCliente={avisoPrazo.cliente?.razao_social ?? null}
                  formas={sortedFormasPagamentoOben} selected={selectedParcelaOben} onSelect={setSelectedParcelaOben}
                  onEstado={avisoPrazo.onEstado}
                />
              )}
            </div>
          )}
          {colacorProductItems.length > 0 && (
            <div className="space-y-1.5">
              <PaymentCombobox
                label="Pagamento Colacor"
                formas={sortedFormasPagamentoColacor}
                selected={selectedParcelaColacor}
                onSelect={setSelectedParcelaColacor}
                customerRanking={customerParcelaRankingColacor}
                loading={loadingFormas}
              />
              {!loadingFormas && (
                <AvisoFormasPagamento
                  degradado={estadoFormasColacor.degradado}
                  erro={estadoFormasColacor.erro}
                  motivo={estadoFormasColacor.motivo}
                  condicoesAusentes={estadoFormasColacor.condicoesAusentes}
                  onRecarregar={onRecarregarFormas}
                />
              )}
              {!loadingFormas && avisoPrazo && (
                <AvisoPrazoCliente
                  company="colacor" codigo={avisoPrazo.cliente?.codigo_cliente_colacor ?? null}
                  nomeCliente={avisoPrazo.cliente?.razao_social ?? null}
                  formas={sortedFormasPagamentoColacor} selected={selectedParcelaColacor} onSelect={setSelectedParcelaColacor}
                  onEstado={avisoPrazo.onEstado}
                />
              )}
            </div>
          )}
          {isOrdemCompraCustomer && setOrdemCompra && (
            <div>
              <Label className="text-xs font-medium">Nº Ordem de Compra do Cliente</Label>
              <Input value={ordemCompra || ''} onChange={e => setOrdemCompra(e.target.value)} className="text-sm h-9 mt-1" placeholder="Ex: OC-12345" />
            </div>
          )}
          {/* Delivery day picker */}
          {setReadyByDate && (
            <div>
              <Label id="rotulo-dia-entrega" className="text-xs font-medium flex items-center gap-1">
                <Calendar className="h-3 w-3" aria-hidden />
                Dia de entrega (próximos dias úteis)
              </Label>
              <div role="group" aria-labelledby="rotulo-dia-entrega" className="flex flex-wrap gap-1.5 mt-1.5">
                {diasEntrega.map(d => (
                  <button
                    key={d.value}
                    type="button"
                    aria-pressed={readyByDate === d.value}
                    onClick={() => setReadyByDate(readyByDate === d.value ? '' : d.value)}
                    className={cn(
                      "text-xs min-h-9 [@media(pointer:coarse)]:min-h-11 px-2.5 py-1.5 rounded-md border transition-colors capitalize",
                      readyByDate === d.value
                        ? "bg-primary text-primary-foreground border-primary"
                        : "bg-background border-border hover:bg-accent hover:text-accent-foreground"
                    )}
                  >
                    {d.label}
                  </button>
                ))}
              </div>
            </div>
          )}
          {/* B1 (rodada 2): `notes` sempre foi enviado (PV, OS e orçamento), mas não havia onde digitá-lo. */}
          <div>
            <Label htmlFor="observacoes-pedido" className="text-xs font-medium">Observações do pedido</Label>
            <Textarea
              id="observacoes-pedido"
              rows={2}
              value={notes}
              onChange={e => setNotes(e.target.value)}
              className="text-sm mt-1"
              placeholder="Ex.: entregar no portão dos fundos"
            />
          </div>
          {serviceItems.some(s => !s.servico) && (
            <p className="text-xs text-status-warning">
              <AlertCircle className="w-3 h-3 inline mr-1" />
              Selecione o serviço para cada ferramenta na aba Afiação.
            </p>
          )}
          {hasInvalidPrice && (
            <p className="text-xs text-status-error">
              <AlertCircle className="w-3 h-3 inline mr-1" />
              Defina um preço maior que zero para os itens destacados antes de enviar.
            </p>
          )}
          {condicoesBloqueantes.length > 0 && (
            <p className="text-xs text-status-error">
              <AlertCircle className="w-3 h-3 inline mr-1" />
              {mensagemCondicoesIndisponiveis(condicoesBloqueantes)}
              {onSubmitQuote && ' Você pode salvar como orçamento e enviar quando o Omie voltar.'}
            </p>
          )}
          {/* C1/C2 (rodada 2): o Enviar, o Orçamento e o total moraram aqui; agora ficam na
              BarraEnvioPedido, presa ao fim da tela — os avisos acima continuam junto dos campos. */}
        </CardContent>
      </Card>

    </>
  );
}
