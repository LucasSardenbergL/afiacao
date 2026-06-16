// Card de cliente identificado pela IA.
// Extraído verbatim de src/components/UnifiedAIAssistant.tsx (god-component split).
import { Check, User, MapPin } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { decodeHtmlEntities } from '@/lib/utils';
import { type AICustomerMatch } from './types';

interface IdentifiedCustomerCardProps {
  customer: AICustomerMatch;
  onConfirm: () => void;
}

export function IdentifiedCustomerCard({ customer, onConfirm }: IdentifiedCustomerCardProps) {
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-muted-foreground flex items-center gap-1.5">
        <User className="w-3.5 h-3.5" /> Cliente Identificado
      </p>
      <div className="bg-background rounded-lg p-3 border border-border">
        <div className="flex justify-between items-start">
          <div className="flex-1 min-w-0">
            <p className="font-medium text-sm">{decodeHtmlEntities(customer.nome_fantasia || customer.razao_social)}</p>
            {customer.nome_fantasia && customer.razao_social && customer.nome_fantasia !== customer.razao_social && (
              <p className="text-xs text-muted-foreground">{decodeHtmlEntities(customer.razao_social)}</p>
            )}
            <div className="flex items-center gap-2 mt-0.5">
              <span className="text-xs text-muted-foreground">{customer.cnpj_cpf}</span>
              {customer.cidade && (
                <span className="text-xs text-muted-foreground flex items-center gap-0.5">
                  <MapPin className="w-3 h-3" />{customer.cidade}
                </span>
              )}
            </div>
            <Badge
              variant={customer.confidence === 'high' ? 'default' : 'outline'}
              className="text-[10px] mt-1"
            >
              {customer.confidence === 'high' ? 'Alta confiança' : customer.confidence === 'medium' ? 'Confiança média' : 'Baixa confiança'}
            </Badge>
          </div>
          <Button size="sm" onClick={onConfirm} className="flex-shrink-0">
            <Check className="w-3 h-3 mr-1" />
            Selecionar
          </Button>
        </div>
      </div>
    </div>
  );
}
