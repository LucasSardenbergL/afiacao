import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { DollarSign, ImageIcon, Sparkles, Calculator } from 'lucide-react';
import type { OrderItem } from './types';

interface Props {
  items: OrderItem[];
  itemPrices: Record<number, string>;
  onPriceChange: (index: number, value: string) => void;
  onApplySuggested: (index: number, item: OrderItem) => void;
  hasAnySuggestedPrice: (item: OrderItem) => boolean;
  getSuggestedPriceSource: (item: OrderItem) => 'history' | 'table' | null;
}

export const OrderItemsPricing = ({
  items,
  itemPrices,
  onPriceChange,
  onApplySuggested,
  hasAnySuggestedPrice,
  getSuggestedPriceSource,
}: Props) => (
  <Card className="mb-4">
    <CardHeader className="pb-2">
      <CardTitle className="text-base flex items-center gap-2">
        <DollarSign className="w-4 h-4" />
        Definir Preços dos Itens
      </CardTitle>
    </CardHeader>
    <CardContent className="space-y-4">
      {items.map((item, index) => (
        <div key={index} className="p-3 bg-muted/50 rounded-lg space-y-3">
          <div className="flex justify-between items-start">
            <div>
              <p className="font-medium">{item.category}</p>
              {item.brandModel && (
                <p className="text-sm text-muted-foreground">{item.brandModel}</p>
              )}
              <p className="text-sm text-muted-foreground">Qtd: {item.quantity || 1}</p>
            </div>
            {item.photos && item.photos.length > 0 && (
              <div className="flex gap-1">
                <ImageIcon className="w-4 h-4 text-muted-foreground" />
                <span className="text-xs text-muted-foreground">{item.photos.length}</span>
              </div>
            )}
          </div>

          {item.notes && (
            <p className="text-sm text-muted-foreground italic border-l-2 border-primary/50 pl-2">
              "{item.notes}"
            </p>
          )}

          {item.photos && item.photos.length > 0 && (
            <div className="flex gap-2 overflow-x-auto pb-2">
              {item.photos.map((photo, photoIdx) => (
                <img
                  key={photoIdx}
                  src={photo}
                  alt={`Foto ${photoIdx + 1}`}
                  className="w-16 h-16 object-cover rounded-lg border"
                />
              ))}
            </div>
          )}

          <div className="flex gap-2">
            <div className="flex-1">
              <Label htmlFor={`price-${index}`} className="text-xs mb-1 block">
                Preço unitário (R$)
              </Label>
              <Input
                id={`price-${index}`}
                type="number"
                step="0.01"
                min="0"
                placeholder="0,00"
                value={itemPrices[index] || ''}
                onChange={(e) => onPriceChange(index, e.target.value)}
                className="h-9"
              />
            </div>

            {hasAnySuggestedPrice(item) && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="mt-5 gap-1"
                onClick={() => onApplySuggested(index, item)}
              >
                {getSuggestedPriceSource(item) === 'history' ? (
                  <Sparkles className="w-3 h-3" />
                ) : (
                  <Calculator className="w-3 h-3" />
                )}
                {getSuggestedPriceSource(item) === 'history' ? 'Último' : 'Tabela'}
              </Button>
            )}
          </div>

          {parseFloat(itemPrices[index] || '0') > 0 && (
            <p className="text-sm text-right font-medium">
              Subtotal: R$ {((parseFloat(itemPrices[index] || '0') || 0) * (item.quantity || 1)).toFixed(2)}
            </p>
          )}
        </div>
      ))}
    </CardContent>
  </Card>
);
