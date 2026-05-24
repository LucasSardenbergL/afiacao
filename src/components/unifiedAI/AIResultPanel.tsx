// Painel de resultado da análise da IA (cliente, produtos, serviços, sugestões, avisos).
// Extraído verbatim de src/components/UnifiedAIAssistant.tsx (god-component split).
import { Sparkles, X, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  type AIProduct,
  type AIService,
  type AISuggestion,
  type AICustomerMatch,
  type Product,
  type UserTool,
} from './types';
import { IdentifiedCustomerCard } from './IdentifiedCustomerCard';
import { IdentifiedProductsList, IdentifiedServicesList } from './IdentifiedItemsLists';
import { SuggestionsList } from './SuggestionsList';

interface AIResultPanelProps {
  aiMessage: string;
  aiFallbackActive: boolean;
  onClear: () => void;
  onAnalyze: () => void;
  isAnalyzing: boolean;
  identifiedCustomer: AICustomerMatch | null;
  hasCustomerSelected: boolean;
  onConfirmCustomer: () => void;
  identifiedProducts: AIProduct[];
  catalog: Product[];
  onRemoveProduct: (idx: number) => void;
  identifiedServices: AIService[];
  userTools: UserTool[];
  isLoading: boolean;
  onConfirmItems: () => void;
  suggestions: AISuggestion[];
  onAcceptSuggestion: (suggestion: AISuggestion) => void;
}

export function AIResultPanel({
  aiMessage,
  aiFallbackActive,
  onClear,
  onAnalyze,
  isAnalyzing,
  identifiedCustomer,
  hasCustomerSelected,
  onConfirmCustomer,
  identifiedProducts,
  catalog,
  onRemoveProduct,
  identifiedServices,
  userTools,
  isLoading,
  onConfirmItems,
  suggestions,
  onAcceptSuggestion,
}: AIResultPanelProps) {
  return (
    <div className="bg-primary/5 border border-primary/20 rounded-lg p-4 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 text-primary">
          <Sparkles className="w-4 h-4" />
          <span className="text-sm font-medium">Resultado da IA</span>
        </div>
        <button onClick={onClear} className="p-1 text-muted-foreground hover:text-foreground">
          <X className="w-4 h-4" />
        </button>
      </div>

      <p className="text-sm text-foreground">{aiMessage}</p>

      {/* Retry button when AI fallback is active */}
      {aiFallbackActive && (
        <Button variant="outline" size="sm" onClick={onAnalyze} disabled={isAnalyzing} className="gap-2">
          <Sparkles className="w-3.5 h-3.5" />
          Tentar novamente
        </Button>
      )}

      {/* Customer identified */}
      {identifiedCustomer && !hasCustomerSelected && (
        <IdentifiedCustomerCard customer={identifiedCustomer} onConfirm={onConfirmCustomer} />
      )}

      {/* Products */}
      {identifiedProducts.length > 0 && (
        <IdentifiedProductsList items={identifiedProducts} catalog={catalog} onRemove={onRemoveProduct} />
      )}

      {/* Services */}
      {identifiedServices.length > 0 && (
        <IdentifiedServicesList items={identifiedServices} userTools={userTools} />
      )}

      {(identifiedProducts.length > 0 || identifiedServices.length > 0) && hasCustomerSelected && (
        <Button onClick={onConfirmItems} className="w-full" disabled={isLoading}>
          <Check className="w-4 h-4 mr-2" />
          Adicionar {identifiedProducts.length + identifiedServices.length} item(ns) ao Pedido
        </Button>
      )}

      {(identifiedProducts.length > 0 || identifiedServices.length > 0) && !hasCustomerSelected && !identifiedCustomer && (
        <p className="text-xs text-status-warning bg-status-warning-bg p-2 rounded">
          ⚠️ Selecione o cliente primeiro para adicionar os itens ao pedido.
        </p>
      )}

      {(identifiedProducts.length > 0 || identifiedServices.length > 0) && !hasCustomerSelected && identifiedCustomer && (
        <p className="text-xs text-status-warning bg-status-warning-bg p-2 rounded">
          ⚠️ Clique em "Selecionar" no cliente acima para depois adicionar os itens.
        </p>
      )}

      {/* Suggestions */}
      {suggestions.length > 0 && (
        <SuggestionsList
          suggestions={suggestions}
          catalog={catalog}
          userTools={userTools}
          hasCustomerSelected={hasCustomerSelected}
          onAccept={onAcceptSuggestion}
        />
      )}
    </div>
  );
}
