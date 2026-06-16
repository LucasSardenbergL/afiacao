// Listas de produtos e serviços identificados pela IA.
// Extraídas verbatim de src/components/UnifiedAIAssistant.tsx (god-component split).
import { X, Package, Wrench } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { type AIProduct, type AIService, type Product, type UserTool } from './types';
import { fmt, getToolName } from './helpers';

interface IdentifiedProductsListProps {
  items: AIProduct[];
  catalog: Product[];
  onRemove: (idx: number) => void;
}

export function IdentifiedProductsList({ items, catalog, onRemove }: IdentifiedProductsListProps) {
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
        <Package className="w-3.5 h-3.5" /> Produtos ({items.length})
      </p>
      {items.map((item, idx) => {
        const prod = catalog.find(p => p.id === item.product_id);
        return (
          <div key={idx} className="bg-background rounded-lg p-3 border border-border">
            <div className="flex justify-between items-start">
              <div className="flex-1 min-w-0">
                <p className="font-medium text-sm truncate">{prod?.descricao || item.descricao || item.codigo}</p>
                <div className="flex items-center gap-2 mt-0.5">
                  <Badge variant="outline" className="text-[10px]">{item.account === 'colacor' ? 'Colacor' : 'Oben'}</Badge>
                  {item.unit_price ? (
                    <span className="text-[10px] text-muted-foreground">
                      {fmt(item.unit_price)}/un <Badge variant="secondary" className="text-[9px] ml-1">Preço cliente</Badge>
                    </span>
                  ) : prod && <span className="text-[10px] text-muted-foreground">{fmt(prod.valor_unitario)}/un</span>}
                </div>
                {item.notes && <p className="text-xs text-muted-foreground mt-1 italic">Obs: {item.notes}</p>}
              </div>
              <div className="flex items-center gap-1.5">
                <span className="bg-primary/10 text-primary text-xs font-medium px-2 py-1 rounded">
                  Qtd: {item.quantity}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 w-6 p-0 text-muted-foreground hover:text-destructive"
                  onClick={() => onRemove(idx)}
                >
                  <X className="w-3.5 h-3.5" />
                </Button>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

interface IdentifiedServicesListProps {
  items: AIService[];
  userTools: UserTool[];
}

export function IdentifiedServicesList({ items, userTools }: IdentifiedServicesListProps) {
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
        <Wrench className="w-3.5 h-3.5" /> Serviços de Afiação ({items.length})
      </p>
      {items.map((item, idx) => {
        const tool = userTools.find(t => t.id === item.userToolId);
        return (
          <div key={idx} className="bg-background rounded-lg p-3 border border-border">
            <div className="flex justify-between items-start">
              <div className="flex-1 min-w-0">
                <p className="font-medium text-sm">{tool ? getToolName(tool) : 'Ferramenta'}</p>
                <p className="text-xs text-muted-foreground">Serviço: {item.servico_descricao}</p>
                {item.notes && <p className="text-xs text-muted-foreground mt-1 italic">Obs: {item.notes}</p>}
              </div>
              <span className="bg-primary/10 text-primary text-xs font-medium px-2 py-1 rounded">
                Qtd: {item.quantity}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
