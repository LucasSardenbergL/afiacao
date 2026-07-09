// Card de seleção de clientes do modo manual (planejador de rotas).
// Extraído de src/pages/AdminRoutePlanner.tsx (god-component split).
// Recebe a lista filtrada + predicados por id (isSelected/isCheckedIn/timerLabel)
// e callbacks; o estado (Set/Map) e os filtros vivem na página.
import { Search, Loader2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ManualCustomerRow } from './ManualCustomerRow';
import type { ManualCustomer, ManualFilter } from './types';

export function ManualModeCard({
  selectedCount,
  estimatedHours,
  filter,
  onFilterChange,
  search,
  onSearchChange,
  loading,
  customers,
  isSelected,
  isCheckedIn,
  timerLabel,
  onToggle,
  onCheckIn,
  onCheckout,
}: {
  selectedCount: number;
  estimatedHours: string;
  filter: ManualFilter;
  onFilterChange: (filter: ManualFilter) => void;
  search: string;
  onSearchChange: (search: string) => void;
  loading: boolean;
  customers: ManualCustomer[];
  isSelected: (userId: string) => boolean;
  isCheckedIn: (userId: string) => boolean;
  timerLabel: (userId: string) => string;
  onToggle: (userId: string) => void;
  onCheckIn: (customer: ManualCustomer) => void;
  onCheckout: (userId: string, name: string) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center justify-between">
          <span>Selecionar Clientes</span>
          <Badge variant="outline">
            {selectedCount} selecionados · ~{estimatedHours}h estimadas
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Filters */}
        <div className="flex items-center gap-2 flex-wrap">
          {(['todos', 'nunca_visitados', 'sem_compra_30d'] as ManualFilter[]).map(f => (
            <Button
              key={f}
              variant={filter === f ? 'secondary' : 'ghost'}
              size="sm"
              onClick={() => onFilterChange(f)}
            >
              {f === 'todos' ? 'Todos' : f === 'nunca_visitados' ? 'Nunca visitados' : 'Sem compra há 30+ dias'}
            </Button>
          ))}
        </div>

        {/* Search */}
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <Input
            placeholder="Buscar por nome, cidade, bairro..."
            value={search}
            onChange={(e) => onSearchChange(e.target.value)}
            className="pl-9"
          />
        </div>

        {/* Customer list */}
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="w-6 h-6 animate-spin text-primary" />
          </div>
        ) : (
          <div className="space-y-2 max-h-96 overflow-y-auto">
            {customers.map(customer => (
              <ManualCustomerRow
                key={customer.user_id}
                customer={customer}
                isSelected={isSelected(customer.user_id)}
                isCheckedIn={isCheckedIn(customer.user_id)}
                timerLabel={timerLabel(customer.user_id)}
                onToggle={() => onToggle(customer.user_id)}
                onCheckIn={() => onCheckIn(customer)}
                onCheckout={() => onCheckout(customer.user_id, customer.name)}
              />
            ))}

            {customers.length === 0 && (
              <div className="text-center py-8 text-muted-foreground text-sm">
                Nenhum cliente encontrado
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
