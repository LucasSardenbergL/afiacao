// Linha de pedido em andamento do CustomerDashboard.
// Extraído verbatim de src/components/CustomerDashboard.tsx (god-component split).
import { useNavigate } from 'react-router-dom';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { motion } from 'framer-motion';
import { Package, ChevronRight } from 'lucide-react';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { cn } from '@/lib/utils';
import { statusConfig } from './config';
import type { Order } from './types';

export function OrderRow({ order, index, navigate, needsAction }: {
  order: Order; index: number; navigate: ReturnType<typeof useNavigate>; needsAction?: boolean;
}) {
  const config = statusConfig[order.status] || statusConfig['pedido_recebido'];
  return (
    <motion.div
      initial={{ opacity: 0, x: -10 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: index * 0.05 }}
    >
      <Card
        className={cn(
          'overflow-hidden hover:shadow-medium transition-all cursor-pointer group border-border/60',
          needsAction && 'ring-1 ring-status-warning/40'
        )}
        onClick={() => navigate(`/orders/${order.id}`)}
      >
        <CardContent className="p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className={cn('w-10 h-10 rounded-xl flex items-center justify-center',
                needsAction ? 'bg-status-warning-bg' : 'bg-muted'
              )}>
                <Package className={cn('w-5 h-5', needsAction ? 'text-status-warning' : 'text-muted-foreground')} />
              </div>
              <div>
                <p className="font-semibold text-sm text-foreground">
                  {format(new Date(order.created_at), "dd 'de' MMM", { locale: ptBR })}
                </p>
                <p className="text-xs text-muted-foreground capitalize">{order.service_type}</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {needsAction && (
                <Badge variant="outline" className="text-[10px] border-status-warning text-status-warning bg-status-warning-bg font-semibold">
                  Ação necessária
                </Badge>
              )}
              <span className={cn('text-[11px] px-2.5 py-1 rounded-full font-semibold border', config.statusClass)}>
                {config.label}
              </span>
              <ChevronRight className="w-4 h-4 text-muted-foreground group-hover:translate-x-1 transition-transform" />
            </div>
          </div>
        </CardContent>
      </Card>
    </motion.div>
  );
}
