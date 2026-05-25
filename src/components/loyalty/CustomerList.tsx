// Busca + lista de clientes com pontos.
// Extraído verbatim de src/pages/AdminLoyalty.tsx (god-component split).
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Search, Users, Plus, Gift } from 'lucide-react';
import { getTier } from './config';
import type { CustomerPoints } from './types';

interface CustomerListProps {
  search: string;
  onSearchChange: (v: string) => void;
  filtered: CustomerPoints[];
  onView: (customer: CustomerPoints) => void;
  onQuickEarn: (userId: string) => void;
  onQuickRedeem: (userId: string) => void;
}

export function CustomerList({ search, onSearchChange, filtered, onView, onQuickEarn, onQuickRedeem }: CustomerListProps) {
  return (
    <>
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
        <Input
          placeholder="Buscar cliente..."
          value={search}
          onChange={e => onSearchChange(e.target.value)}
          className="pl-10"
        />
      </div>

      {/* Customer list */}
      <div className="space-y-2">
        {filtered.length === 0 && (
          <Card>
            <CardContent className="p-6 text-center">
              <Users className="w-8 h-8 text-muted-foreground mx-auto mb-2" />
              <p className="text-sm text-muted-foreground">
                {search ? 'Nenhum cliente encontrado' : 'Nenhum cliente com pontos ainda'}
              </p>
            </CardContent>
          </Card>
        )}
        {filtered.map(customer => {
          const tier = getTier(customer.balance);
          return (
            <Card
              key={customer.user_id}
              className="cursor-pointer hover:shadow-medium transition-shadow"
              onClick={() => onView(customer)}
            >
              <CardContent className="p-4 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <span className="text-2xl">{tier.icon}</span>
                  <div>
                    <p className="font-semibold text-foreground">{customer.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {tier.name} · {customer.balance} pontos
                    </p>
                  </div>
                </div>
                <div className="flex gap-1">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={e => {
                      e.stopPropagation();
                      onQuickEarn(customer.user_id);
                    }}
                  >
                    <Plus className="w-4 h-4" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={e => {
                      e.stopPropagation();
                      onQuickRedeem(customer.user_id);
                    }}
                  >
                    <Gift className="w-4 h-4" />
                  </Button>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </>
  );
}
