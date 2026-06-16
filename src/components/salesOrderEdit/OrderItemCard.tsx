// Card de um item do pedido (qtd/valor editáveis + remover).
// Extraído verbatim de src/pages/SalesOrderEdit.tsx (god-component split).
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { type OrderItem } from './types';

interface OrderItemCardProps {
  item: OrderItem;
  index: number;
  isBlocked: boolean;
  /** Marca o preço como inválido (≤ 0): destaca o input e mostra aviso. Calculado pelo hook. */
  isPriceInvalid?: boolean;
  onUpdate: (index: number, field: 'quantidade' | 'valor_unitario', value: number) => void;
  onRemove: (index: number) => void;
}

export function OrderItemCard({ item, index, isBlocked, isPriceInvalid = false, onUpdate, onRemove }: OrderItemCardProps) {
  return (
    <div className="border rounded-lg p-3 space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium truncate">{item.descricao}</p>
          {item.codigo && <p className="text-xs text-muted-foreground">Cód: {item.codigo}</p>}
          {item.tint_nome_cor && (
            <p className="text-xs text-muted-foreground">
              🎨 {item.tint_cor_id} - {item.tint_nome_cor}
            </p>
          )}
        </div>
        {!isBlocked && (
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-destructive"
            onClick={() => onRemove(index)}
          >
            <Trash2 className="w-3.5 h-3.5" />
          </Button>
        )}
      </div>

      <div className="grid grid-cols-3 gap-2">
        <div>
          <label className="text-xs text-muted-foreground">Qtd</label>
          <Input
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            min={1}
            value={item.quantidade}
            onFocus={(e) => e.target.select()}
            onChange={(e) => onUpdate(index, 'quantidade', Number(e.target.value) || 1)}
            disabled={isBlocked}
            className="h-8 text-sm"
          />
        </div>
        <div>
          <label className="text-xs text-muted-foreground">Valor Unit.</label>
          <Input
            type="text"
            inputMode="decimal"
            pattern="[0-9]*\.?[0-9]*"
            step="0.01"
            min={0}
            value={item.valor_unitario}
            onFocus={(e) => e.target.select()}
            onChange={(e) => onUpdate(index, 'valor_unitario', Number(e.target.value) || 0)}
            disabled={isBlocked}
            aria-invalid={isPriceInvalid || undefined}
            className={cn('h-8 text-sm', isPriceInvalid && 'border-status-error focus-visible:ring-status-error')}
          />
          {isPriceInvalid && (
            <p className="text-xs text-status-error mt-1">Defina um valor maior que zero.</p>
          )}
        </div>
        <div>
          <label className="text-xs text-muted-foreground">Total</label>
          <p className="h-8 flex items-center text-sm font-medium">
            R$ {item.valor_total.toFixed(2)}
          </p>
        </div>
      </div>
    </div>
  );
}
