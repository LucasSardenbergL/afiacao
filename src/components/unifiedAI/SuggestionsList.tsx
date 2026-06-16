// Lista de sugestões da IA (sem correspondência exata).
// Extraída verbatim de src/components/UnifiedAIAssistant.tsx (god-component split).
import { Package, Wrench, Lightbulb, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { type AISuggestion, type Product, type UserTool } from './types';
import { fmt, getToolName } from './helpers';

interface SuggestionsListProps {
  suggestions: AISuggestion[];
  catalog: Product[];
  userTools: UserTool[];
  hasCustomerSelected: boolean;
  onAccept: (suggestion: AISuggestion) => void;
}

export function SuggestionsList({
  suggestions,
  catalog,
  userTools,
  hasCustomerSelected,
  onAccept,
}: SuggestionsListProps) {
  return (
    <div className="space-y-2 pt-2 border-t border-border">
      <p className="text-xs font-medium text-status-warning flex items-center gap-1.5">
        <Lightbulb className="w-3.5 h-3.5" /> Sugestões ({suggestions.length})
      </p>
      <p className="text-xs text-muted-foreground">
        Não encontrei correspondência exata, mas esses itens podem ser o que você procura:
      </p>
      {suggestions.map((sug, idx) => {
        const prod = sug.type === 'product' && sug.product_id ? catalog.find(p => p.id === sug.product_id) : null;
        const tool = sug.type === 'service' && sug.userToolId ? userTools.find(t => t.id === sug.userToolId) : null;
        return (
          <div key={idx} className="bg-status-warning-bg rounded-lg p-3 border border-status-warning/30">
            <div className="flex justify-between items-start gap-2">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5">
                  {sug.type === 'product' ? (
                    <Package className="w-3.5 h-3.5 text-status-warning flex-shrink-0" />
                  ) : (
                    <Wrench className="w-3.5 h-3.5 text-status-warning flex-shrink-0" />
                  )}
                  <p className="font-medium text-sm truncate">
                    {prod?.descricao || (tool ? getToolName(tool) : sug.descricao)}
                  </p>
                </div>
                <p className="text-xs text-status-warning mt-1 italic">
                  💡 {sug.reason}
                </p>
                {sug.type === 'product' && (prod || sug.unit_price) && (
                  <div className="flex items-center gap-2 mt-1">
                    <Badge variant="outline" className="text-[10px]">{sug.account === 'colacor' ? 'Colacor' : 'Oben'}</Badge>
                    {sug.unit_price ? (
                      <span className="text-[10px] text-muted-foreground">
                        {fmt(sug.unit_price)}/un <Badge variant="secondary" className="text-[9px] ml-1">Preço cliente</Badge>
                      </span>
                    ) : prod && <span className="text-[10px] text-muted-foreground">{fmt(prod.valor_unitario)}/un</span>}
                  </div>
                )}
                {sug.type === 'service' && sug.servico_descricao && (
                  <p className="text-xs text-muted-foreground mt-0.5">Serviço: {sug.servico_descricao}</p>
                )}
              </div>
              {hasCustomerSelected && (
                <Button
                  size="sm"
                  variant="outline"
                  className="flex-shrink-0 text-xs border-status-warning/40 hover:bg-status-warning/10"
                  onClick={() => onAccept(sug)}
                >
                  <Plus className="w-3 h-3 mr-1" />
                  Adicionar
                </Button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
