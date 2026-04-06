import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Card, CardContent } from '@/components/ui/card';
import {
  ShoppingCart, Send, Loader2, Building2, Scissors, AlertCircle,
} from 'lucide-react';
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
  // Volumes
  volumesOben: number;
  setVolumesOben: (v: number) => void;
  volumesColacor: number;
  setVolumesColacor: (v: number) => void;
  // Actions
  onSubmit: () => void;
}

export function CartSummaryBar({
  cart, obenProductItems, colacorProductItems, serviceItems, totalEstimated,
  submitting, vendedorDivergencias,
  sortedFormasPagamentoOben, sortedFormasPagamentoColacor,
  selectedParcelaOben, setSelectedParcelaOben,
  selectedParcelaColacor, setSelectedParcelaColacor,
  loadingFormas, customerParcelaRankingOben, customerParcelaRankingColacor,
  notes, setNotes,
  volumesOben, setVolumesOben, volumesColacor, setVolumesColacor,
  onSubmit,
}: CartSummaryBarProps) {
  const disableSubmit = submitting || serviceItems.some(s => !s.servico) || vendedorDivergencias.length > 0;

  return (
    <>
      {/* Payment + Submit sidebar card */}
      <Card>
        <CardContent className="pt-4 space-y-3">
          {obenProductItems.length > 0 && (
            <div>
              <Label className="text-xs font-medium">Pagamento Oben</Label>
              {loadingFormas ? (
                <Loader2 className="w-4 h-4 animate-spin mt-1" />
              ) : (
                <Select value={selectedParcelaOben} onValueChange={setSelectedParcelaOben}>
                  <SelectTrigger className="text-sm h-9 mt-1"><SelectValue placeholder="Selecione..." /></SelectTrigger>
                  <SelectContent>
                    {sortedFormasPagamentoOben.map(f => (
                      <SelectItem key={f.codigo} value={f.codigo}>
                        {customerParcelaRankingOben.includes(f.codigo) ? '⭐ ' : ''}{f.descricao}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
          )}
          {colacorProductItems.length > 0 && (
            <div>
              <Label className="text-xs font-medium">Pagamento Colacor</Label>
              {loadingFormas ? (
                <Loader2 className="w-4 h-4 animate-spin mt-1" />
              ) : (
                <Select value={selectedParcelaColacor} onValueChange={setSelectedParcelaColacor}>
                  <SelectTrigger className="text-sm h-9 mt-1"><SelectValue placeholder="Selecione..." /></SelectTrigger>
                  <SelectContent>
                    {sortedFormasPagamentoColacor.map(f => (
                      <SelectItem key={f.codigo} value={f.codigo}>
                        {customerParcelaRankingColacor.includes(f.codigo) ? '⭐ ' : ''}{f.descricao}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
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

      {/* Fixed bottom bar */}
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
