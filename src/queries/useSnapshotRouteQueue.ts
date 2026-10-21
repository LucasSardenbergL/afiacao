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
      cliente_nome: it.name,
      cidade: it.cityKey?.city ?? null,
      bucket: it.bucket,
      valor_da_ligacao: it.valorDaLigacao,
      rank: i + 1,
    }));
    // Best-effort, mas a falha não pode passar por sucesso: o supabase-js RESOLVE com `error` em erro de
    // banco (RLS, timeout) — só rejeita em falha de transporte. Os dois caminhos liberam o retry; antes
    // o `.then(() => {})` descartava o `error`, marcava o dia como gravado e o denominador do painel
    // ficava sem a fila até a próxima montagem do dia seguinte.
    const liberarRetry = () => { feito.current = null; };
    const gravar = async () => {
      const { error } = await supabase
        .from('route_queue_snapshot')
        .upsert(rows, { onConflict: 'data_rota,farmer_id,customer_user_id', ignoreDuplicates: true });
      if (error) liberarRetry();
    };
    gravar().catch(liberarRetry);
  }, [user, routeDate, callQueue]);
}
