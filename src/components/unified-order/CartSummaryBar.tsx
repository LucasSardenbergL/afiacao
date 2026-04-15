import { useState, useMemo } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';

import { Card, CardContent } from '@/components/ui/card';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';
import {
  Send, Loader2, AlertCircle, Check, ChevronsUpDown, FileText, Calendar,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { format, addDays, startOfWeek, isWeekend } from 'date-fns';
import { ptBR } from 'date-fns/locale';
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
  // Ready by date
  readyByDate?: string;
  setReadyByDate?: (v: string) => void;
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
  readyByDate, setReadyByDate,
  onSubmit, onSubmitQuote,
}: CartSummaryBarProps) {
  const hasOnlyProducts = (obenProductItems.length > 0 || colacorProductItems.length > 0) && serviceItems.length === 0;
  const disableSubmit = submitting || serviceItems.some(s => !s.servico) || vendedorDivergencias.length > 0;

  // Generate weekdays (Mon-Fri) for current week
  const weekDays = useMemo(() => {
    const today = new Date();
    const monday = startOfWeek(today, { weekStartsOn: 1 });
    const days: { date: Date; label: string; value: string }[] = [];
    for (let i = 0; i < 5; i++) {
      const d = addDays(monday, i);
      days.push({
        date: d,
        label: format(d, "EEEE dd/MM", { locale: ptBR }),
        value: format(d, 'yyyy-MM-dd'),
      });
    }
    return days;
  }, []);

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
          {/* Delivery day picker */}
          {setReadyByDate && (
            <div>
              <Label className="text-xs font-medium flex items-center gap-1">
                <Calendar className="h-3 w-3" />
                Dia de entrega (semana atual)
              </Label>
              <div className="flex flex-wrap gap-1.5 mt-1.5">
                {weekDays.map(d => (
                  <button
                    key={d.value}
                    type="button"
                    onClick={() => setReadyByDate(readyByDate === d.value ? '' : d.value)}
                    className={cn(
                      "text-xs px-2.5 py-1.5 rounded-md border transition-colors capitalize",
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
          {hasOnlyProducts && onSubmitQuote && (
            <Button variant="outline" className="w-full gap-2" onClick={onSubmitQuote} disabled={submitting}>
              {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileText className="w-4 h-4" />}
              Salvar como Orçamento
            </Button>
          )}
        </CardContent>
      </Card>

    </>
  );
}
