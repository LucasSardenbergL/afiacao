// Hook de dados/estado do CustomerDashboard.
// Extraído verbatim de src/components/CustomerDashboard.tsx (god-component split):
// gamification score, checagem de endereços e derivados (nome, ferramentas
// urgentes, ação prioritária, particionamento de pedidos).
import { useEffect, useState } from 'react';
import { useGamificationScore, getLevelInfo } from '@/hooks/useGamificationScore';
import { differenceInDays } from 'date-fns';
import { supabase } from '@/integrations/supabase/client';
import { computePriority } from './priority';
import type { Profile, Order, UserTool } from './types';

export function useCustomerDashboard(profile: Profile | null, pendingOrders: Order[], userTools: UserTool[]) {
  const { data: gamScore } = useGamificationScore();

  const [hasAddresses, setHasAddresses] = useState(true); // optimistic default

  // Lightweight address check
  useEffect(() => {
    (async () => {
      const { count } = await supabase
        .from('addresses')
        .select('id', { count: 'exact', head: true });
      setHasAddresses((count ?? 0) > 0);
    })();
  }, []);

  const isCNPJ = profile?.document && profile.document.replace(/\D/g, '').length === 14;
  const displayName = isCNPJ ? profile?.name || 'Cliente' : profile?.name?.split(' ')[0] || 'Cliente';

  const toolsOverdue = userTools.filter(t => {
    if (!t.next_sharpening_due) return false;
    return differenceInDays(new Date(t.next_sharpening_due), new Date()) < 0;
  });
  const toolsSoon = userTools.filter(t => {
    if (!t.next_sharpening_due) return false;
    const d = differenceInDays(new Date(t.next_sharpening_due), new Date());
    return d >= 0 && d <= 7;
  });
  const urgentTools = [...toolsOverdue, ...toolsSoon];
  const levelInfo = gamScore ? getLevelInfo(gamScore.total_score) : null;

  const priority = computePriority(pendingOrders, toolsOverdue, userTools, hasAddresses);

  const ordersNeedingAction = pendingOrders.filter(o => o.status === 'orcamento_enviado');
  const otherActiveOrders = pendingOrders.filter(o => o.status !== 'orcamento_enviado');

  return {
    gamScore,
    displayName,
    urgentTools,
    levelInfo,
    priority,
    ordersNeedingAction,
    otherActiveOrders,
  };
}
