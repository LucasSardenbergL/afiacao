import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { MoreVertical } from 'lucide-react';
import { Card, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import { useMyMixGap } from '@/hooks/useMyMixGap';
import { useMarkMixGapFeedback } from '@/hooks/useMarkMixGapFeedback';
import { useImpersonation } from '@/contexts/ImpersonationContext';
import { buildPorQue } from '@/lib/mixgap/format';
import { track } from '@/lib/analytics';

export function MixGapCard() {
  const { data } = useMyMixGap();
  const { mutate: markFeedback } = useMarkMixGapFeedback();
  const { isImpersonating } = useImpersonation();
  const totalComGap = data?.totalComGap ?? 0;
  const tracked = useRef(false);
  useEffect(() => {
    if (totalComGap > 0 && !tracked.current) {
      tracked.current = true;
      track('carteira.mixgap_visto', { total_com_gap: totalComGap });
    }
  }, [totalComGap]);
  if (!data || data.totalComGap === 0) return null;
  return (
    <Card>
      <CardHeader className="pb-2">
        <h2 className="text-base font-medium">Oportunidades de cross-sell</h2>
        <p className="text-2xs text-muted-foreground">
          {data.totalComGap} clientes da sua carteira sem uma família que clientes parecidos compram
        </p>
      </CardHeader>
      <div className="divide-y divide-border">
        {data.lista.slice(0, 20).map((g) => (
          <div key={g.customer_user_id} className="p-3 flex items-center justify-between gap-3 hover:bg-muted/30">
            <Link
              to={`/admin/customers/${g.customer_user_id}/360`}
              onClick={() => track('carteira.mixgap_cliente_aberto', { familia: g.familia_faltante })}
              className="min-w-0 flex-1"
            >
              <div className="text-sm font-medium truncate">{g.nome ?? 'Cliente sem nome'}</div>
              <div className="text-2xs text-muted-foreground">{buildPorQue(g)}</div>
            </Link>
            <div className="flex items-center gap-2 shrink-0">
              {g.feedback_status === 'ofertado' && (
                <Badge variant="outline" className="text-status-warning text-2xs">ofertado</Badge>
              )}
              <Badge variant="outline" className="text-status-info text-2xs">{g.familia_faltante}</Badge>
              <DropdownMenu>
                <DropdownMenuTrigger
                  disabled={isImpersonating}
                  title={isImpersonating ? 'Indisponível em modo Ver como' : 'Marcar oportunidade'}
                  className="p-1 rounded hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <MoreVertical className="w-4 h-4 text-muted-foreground" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => markFeedback({ customerUserId: g.customer_user_id, familia: g.familia_faltante, status: 'ofertado' })}>
                    Ofertado
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => markFeedback({ customerUserId: g.customer_user_id, familia: g.familia_faltante, status: 'convertido' })}>
                    Convertido
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => markFeedback({ customerUserId: g.customer_user_id, familia: g.familia_faltante, status: 'recusado' })}>
                    Recusado
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
