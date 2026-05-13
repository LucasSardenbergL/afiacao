import { X, type LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface BulkAction {
  id: string;
  label: string;
  icon?: LucideIcon;
  onClick: () => void;
  disabled?: boolean;
  variant?: 'default' | 'outline' | 'ghost' | 'destructive';
}

interface BulkActionsBarProps {
  count: number;
  onClear: () => void;
  actions: BulkAction[];
  /** Texto pluralizável ("pedido"/"pedidos", default "item"/"itens"). */
  itemSingular?: string;
  itemPlural?: string;
  className?: string;
}

/**
 * Barra flutuante que aparece quando há seleção. Padrão: bottom-center, sticky.
 *
 *   <BulkActionsBar
 *     count={sel.size}
 *     onClear={sel.clear}
 *     itemSingular="pedido" itemPlural="pedidos"
 *     actions={[
 *       { id: 'approve', label: 'Aprovar', icon: Check, onClick: () => approveAll(sel.ids) },
 *       { id: 'reject', label: 'Rejeitar', icon: X, variant: 'destructive', onClick: () => rejectAll(sel.ids) },
 *     ]}
 *   />
 */
export function BulkActionsBar({
  count,
  onClear,
  actions,
  itemSingular = 'item',
  itemPlural = 'itens',
  className,
}: BulkActionsBarProps) {
  if (count === 0) return null;

  return (
    <div
      className={cn(
        'fixed bottom-4 left-1/2 -translate-x-1/2 z-50',
        'flex items-center gap-2 px-3 py-2 rounded-lg',
        'bg-card border border-border shadow-lg',
        'animate-slide-up',
        className,
      )}
      role="region"
      aria-label="Ações em lote"
    >
      <Button
        size="icon"
        variant="ghost"
        className="h-7 w-7 text-muted-foreground"
        onClick={onClear}
        aria-label="Limpar seleção"
      >
        <X className="w-4 h-4" />
      </Button>
      <span className="text-sm font-medium px-1">
        {count} {count === 1 ? itemSingular : itemPlural} selecionado{count === 1 ? '' : 's'}
      </span>
      <div className="h-5 w-px bg-border mx-1" />
      <div className="flex items-center gap-1">
        {actions.map((action) => {
          const Icon = action.icon;
          return (
            <Button
              key={action.id}
              size="sm"
              variant={action.variant ?? 'outline'}
              onClick={action.onClick}
              disabled={action.disabled}
              className="gap-1.5"
            >
              {Icon && <Icon className="w-3.5 h-3.5" />}
              {action.label}
            </Button>
          );
        })}
      </div>
    </div>
  );
}
