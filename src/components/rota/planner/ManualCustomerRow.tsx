// Linha de cliente no seletor do modo manual (planejador de rotas).
// Extraído de src/pages/AdminRoutePlanner.tsx (god-component split).
// Presentational: recebe o cliente + estado de seleção/check-in + callbacks.
import { MapPin, CheckCircle2, XCircle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import type { ManualCustomer } from './types';
import { getVisitBadge, getOrderBadge } from './renderHelpers';

export function ManualCustomerRow({
  customer,
  isSelected,
  isCheckedIn,
  timerLabel,
  onToggle,
  onCheckIn,
  onCheckout,
}: {
  customer: ManualCustomer;
  isSelected: boolean;
  isCheckedIn: boolean;
  timerLabel: string;
  onToggle: () => void;
  onCheckIn: () => void;
  onCheckout: () => void;
}) {
  return (
    <div
      className={`p-3 border rounded-lg hover:bg-muted/50 transition-colors ${isSelected ? 'bg-primary/5 border-primary' : ''}`}
    >
      <div className="flex items-start gap-3">
        <Checkbox
          checked={isSelected}
          onCheckedChange={onToggle}
          className="mt-0.5"
        />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <p className="font-medium text-sm">{customer.name}</p>
            {!customer.hasAddress && (
              <Badge variant="outline" className="text-xs text-muted-foreground">
                <MapPin className="w-3 h-3 mr-1" />
                Sem endereço
              </Badge>
            )}
            {getVisitBadge(customer)}
            {getOrderBadge(customer)}
            {isCheckedIn && (
              <Badge variant="success" className="text-xs gap-1">
                <CheckCircle2 className="w-3 h-3" />
                Em visita · {timerLabel}
              </Badge>
            )}
          </div>
          {customer.hasAddress ? (
            <>
              <p className="text-xs text-muted-foreground">
                {customer.neighborhood}, {customer.city}
              </p>
              <p className="text-xs text-muted-foreground">
                {customer.address.street}, {customer.address.number}
              </p>
            </>
          ) : (
            <p className="text-xs text-muted-foreground italic">
              Endereço não cadastrado — sincronize via Painel de Sync
            </p>
          )}

          {/* Check-in/Check-out buttons */}
          {isSelected && (
            <div className="mt-2 flex gap-2">
              {!isCheckedIn ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={onCheckIn}
                  className="text-xs h-7"
                >
                  <CheckCircle2 className="w-3 h-3 mr-1" />
                  Check-in
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={onCheckout}
                  className="text-xs h-7"
                >
                  <XCircle className="w-3 h-3 mr-1" />
                  Check-out
                </Button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
