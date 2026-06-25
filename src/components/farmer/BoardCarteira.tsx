import { Users } from 'lucide-react';
import { EmptyState } from '@/components/EmptyState';
import { CardCarteira } from './CardCarteira';
import type { ColunaBoard } from '@/lib/carteira/board';

export function BoardCarteira({ colunas }: { colunas: ColunaBoard[] }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
      {colunas.map((col) => (
        <section key={col.tipo} aria-label={col.label} className="space-y-2">
          <header className="flex items-center justify-between">
            <h2 className={`font-display text-base ${col.tom}`}>{col.label}</h2>
            <span className="text-sm text-muted-foreground">{col.cards.length}</span>
          </header>
          {col.cards.length === 0 ? (
            <EmptyState
              icon={Users}
              title="Nada aqui"
              description="Sem clientes nesta coluna."
              tone="operational"
            />
          ) : (
            <div className="space-y-2">
              {col.cards.map((card) => (
                <CardCarteira key={card.customer_user_id} card={card} />
              ))}
            </div>
          )}
        </section>
      ))}
    </div>
  );
}
