import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { Card, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useMyMixGap } from '@/hooks/useMyMixGap';
import { buildPorQue } from '@/lib/mixgap/format';
import { track } from '@/lib/analytics';

export function MixGapCard() {
  const { data } = useMyMixGap();
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
          <Link
            key={g.customer_user_id}
            to={`/admin/customers/${g.customer_user_id}/360`}
            onClick={() => track('carteira.mixgap_cliente_aberto', { familia: g.familia_faltante })}
            className="p-3 flex items-center justify-between gap-3 hover:bg-muted/30"
          >
            <div className="min-w-0">
              <div className="text-sm font-medium truncate">{g.nome ?? 'Cliente sem nome'}</div>
              <div className="text-2xs text-muted-foreground">{buildPorQue(g)}</div>
            </div>
            <Badge variant="outline" className="text-status-info text-2xs shrink-0">{g.familia_faltante}</Badge>
          </Link>
        ))}
      </div>
    </Card>
  );
}
