// Lista de decisões de uma aba (empty state + cards). Reutilizada nas 3 abas.
// Extraída verbatim de src/pages/AIops.tsx (god-component split — as 3 abas eram idênticas exceto ícone/mensagem do empty state).
import { Card, CardContent } from '@/components/ui/card';
import type { LucideIcon } from 'lucide-react';
import { DecisionCard } from './DecisionCard';
import type { AIDecision, CustomerProfileLite } from './types';

interface DecisionListProps {
  decisions: AIDecision[];
  profileMap: Map<string, CustomerProfileLite>;
  emptyIcon: LucideIcon;
  emptyMessage: string;
  onAccept: (id: string) => void;
  onDismiss: (id: string) => void;
}

export function DecisionList({ decisions, profileMap, emptyIcon: EmptyIcon, emptyMessage, onAccept, onDismiss }: DecisionListProps) {
  return (
    <div className="space-y-3">
      {decisions.length === 0 ? (
        <Card>
          <CardContent className="p-8 text-center text-muted-foreground">
            <EmptyIcon className="w-12 h-12 mx-auto mb-3 opacity-30" />
            <p>{emptyMessage}</p>
          </CardContent>
        </Card>
      ) : (
        decisions.map((d) => (
          <DecisionCard
            key={d.id}
            decision={d}
            customerName={profileMap.get(d.customer_user_id)?.name || 'Cliente desconhecido'}
            customerPhone={profileMap.get(d.customer_user_id)?.phone}
            onAccept={() => onAccept(d.id)}
            onDismiss={() => onDismiss(d.id)}
          />
        ))
      )}
    </div>
  );
}
