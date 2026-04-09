import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Card, CardContent } from '@/components/ui/card';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import {
  ShoppingCart, Send, Loader2, Building2, Scissors, AlertCircle, Check, ChevronsUpDown,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type {
  ProductCartItem, ServiceCartItem, FormaPagamento,
} from '@/hooks/useUnifiedOrder';
import { fmt } from '@/hooks/useUnifiedOrder';

interface CartSummaryBarProps {
  cart: { length: number };
  obenProductItems: ProductCartItem[];
  colacorProductItems: ProductCartItem[];
  serviceItems: ServiceCartItem[];
  totalEstimated: number;
  submitting: boolean;
  vendedorDivergencias: string[];
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
  notes: string;
  setNotes: (v: string) => void;
  // Volumes (auto-calculated)
  volumesOben: number;
  volumesColacor: number;
  // Ordem de compra (exceção CNPJ específico)
  ordemCompra?: string;
  setOrdemCompra?: (v: string) => void;
  isOrdemCompraCustomer?: boolean;
  // Actions
  onSubmit: () => void;
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

  if (loading) {
    return (
      <div>
        <Label className="text-xs font-medium">{label}</Label>
        <Loader2 className="w-4 h-4 animate-spin mt-1" />
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
            className="w-full justify-between text-sm h-9 mt-1 font-normal"
          >
            <span className="truncate">
              {selected ? (
                <>
                  {customerRanking.includes(selected) ? '⭐ ' : ''}
                  {selectedLabel}
                </>
              ) : 'Selecione...'}
            </span>
            <ChevronsUpDown className="ml-2 h-3.5 w-3.5 shrink-0 opacity-50" />
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
  cart, obenProductItems, colacorProductItems, serviceItems, totalEstimated,
  submitting, vendedorDivergencias,
  sortedFormasPagamentoOben, sortedFormasPagamentoColacor,
  selectedParcelaOben, setSelectedParcelaOben,
  selectedParcelaColacor, setSelectedParcelaColacor,
  loadingFormas, customerParcelaRankingOben, customerParcelaRankingColacor,
  notes, setNotes,
  volumesOben, volumesColacor,
  ordemCompra, setOrdemCompra, isOrdemCompraCustomer,
  onSubmit,
}: CartSummaryBarProps) {
  const disableSubmit = submitting || serviceItems.some(s => !s.servico) || vendedorDivergencias.length > 0;

  return (
    <>
      <Card>
        <CardContent className="pt-4 space-y-3">
          {obenProductItems.length > 0 && (
            <PaymentCombobox
              label="Pagamento Oben"
              formas={sortedFormasPagamentoOben}
              selected={selectedParcelaOben}
              onSelect={setSelectedParcelaOben}
              customerRanking={customerParcelaRankingOben}
              loading={loadingFormas}
            />
          )}
          {colacorProductItems.length > 0 && (
            <PaymentCombobox
              label="Pagamento Colacor"
              formas={sortedFormasPagamentoColacor}
              selected={selectedParcelaColacor}
              onSelect={setSelectedParcelaColacor}
              customerRanking={customerParcelaRankingColacor}
              loading={loadingFormas}
            />
          )}
          {isOrdemCompraCustomer && setOrdemCompra && (
            <div>
              <Label className="text-xs font-medium">Nº Ordem de Compra do Cliente</Label>
              <Input value={ordemCompra || ''} onChange={e => setOrdemCompra(e.target.value)} className="text-sm h-9 mt-1" placeholder="Ex: OC-12345" />
            </div>
          )}
          <div>
            <Label className="text-xs font-medium">Observações gerais</Label>
            <Textarea placeholder="Observações do pedido..." value={notes} onChange={e => setNotes(e.target.value)} rows={2} className="text-sm mt-1" />
          </div>
          {serviceItems.some(s => !s.servico) && (
            <p className="text-xs text-amber-600">
              <AlertCircle className="w-3 h-3 inline mr-1" />
              Selecione o serviço para cada ferramenta na aba Afiação.
            </p>
          )}
          <Button className="w-full gap-2" onClick={onSubmit} disabled={disableSubmit}>
            {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            Enviar pedido
            {(() => {
              const count = (obenProductItems.length > 0 ? 1 : 0) + (colacorProductItems.length > 0 ? 1 : 0) + (serviceItems.length > 0 ? 1 : 0);
              return count > 1 ? <span className="text-[10px] opacity-70">({count} pedidos)</span> : null;
            })()}
          </Button>
        </CardContent>
      </Card>

      <div className="fixed bottom-0 left-0 right-0 z-50 bg-background border-t shadow-lg px-4 py-2.5 safe-bottom">
        <div className="max-w-screen-xl mx-auto flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <ShoppingCart className="w-4 h-4 text-muted-foreground shrink-0" />
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-semibold">{cart.length} {cart.length === 1 ? 'item' : 'itens'}</span>
              <span className="text-sm font-bold">{totalEstimated > 0 ? fmt(totalEstimated) : 'A definir'}</span>
              <div className="flex gap-1">
                {obenProductItems.length > 0 && <Badge variant="outline" className="text-[9px] py-0"><Building2 className="w-2.5 h-2.5 mr-0.5" />Oben</Badge>}
                {colacorProductItems.length > 0 && <Badge variant="outline" className="text-[9px] py-0"><Building2 className="w-2.5 h-2.5 mr-0.5" />Colacor</Badge>}
                {serviceItems.length > 0 && <Badge variant="outline" className="text-[9px] py-0"><Scissors className="w-2.5 h-2.5 mr-0.5" />Afiação</Badge>}
              </div>
            </div>
          </div>
          <Button size="sm" className="gap-1.5 shrink-0" onClick={onSubmit} disabled={disableSubmit}>
            {submitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
            Enviar pedido
          </Button>
        </div>
      </div>
    </>
  );
}
