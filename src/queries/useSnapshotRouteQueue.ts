// src/queries/useSnapshotRouteQueue.ts
import { useEffect, useRef } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import type { RouteContactItem } from '@/queries/useRouteContactList';

/** Grava (idempotente, best-effort) a fila de ligação que o farmer ABRIU — denominador do painel. */
export function useSnapshotRouteQueue(routeDate: string | null, callQueue: RouteContactItem[] | undefined) {
  const { user } = useAuth();
  const feito = useRef<string | null>(null);
  useEffect(() => {
    if (!user || !routeDate || !callQueue || callQueue.length === 0) return;
    const marca = `${routeDate}:${user.id}`;
    if (feito.current === marca) return;       // 1x por (dia, usuário) por montagem
    feito.current = marca;
    const rows = callQueue.map((it, i) => ({
      data_rota: routeDate,
      farmer_id: user.id,
      customer_user_id: it.customerUserId,
      cidade: it.cityKey?.city ?? null,
      bucket: it.bucket,
      valor_da_ligacao: it.valorDaLigacao,
      rank: i + 1,
    }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    void (supabase.from('route_queue_snapshot' as never) as any)
      .upsert(rows as never, { onConflict: 'data_rota,farmer_id,customer_user_id', ignoreDuplicates: true })
      .then(() => { /* best-effort */ }, () => { feito.current = null; /* permite retry numa próxima montagem */ });
  }, [user, routeDate, callQueue]);
}
