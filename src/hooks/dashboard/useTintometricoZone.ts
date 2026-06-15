import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { AlertTriangle } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useDashboardCompany } from '@/hooks/useDashboardCompany';
import { useCockpitChannel } from '@/hooks/dashboard/useCockpitChannel';
import { variantFromScore, type PriorityCandidate } from '@/lib/dashboard/priority-rules';
import { formatCount, formatImportStatus } from '@/lib/dashboard/format';
import type { KpiSpec } from '@/components/dashboard/cockpit/CockpitKpiRow';
import type { TopListItem } from '@/components/dashboard/cockpit/CockpitTopList';

const ACCOUNT = 'oben';

type TintImportRow = {
  id: string;
  tipo?: string | null;
  arquivo_nome?: string | null;
  registros_erro?: number | null;
  status?: string | null;
  created_at?: string | null;
};

export function useTintometricoZone() {
  const { mode, companies } = useDashboardCompany();
  /** Tintométrico é exclusivo da Oben. Mostra dados quando mode=all ou single=oben. */
  const applies = mode === 'all' || companies.includes('oben');

  const queryKey = ['dashboard', 'tintometrico', applies];

  const { isLive } = useCockpitChannel({
    zone: 'tintometrico',
    table: 'tint_importacoes',
    queryKeys: [queryKey],
  });

  const { data, isLoading, isError, refetch } = useQuery({
    queryKey,
    enabled: applies,
    queryFn: async () => {
      let totalFormulas = 0;
      let skusMapped = 0;
      let skusTotal = 0;
      let lastImport: TintImportRow | null = null;
      let topItems: TopListItem[] = [];

      try {
        const { count } = await supabase
          .from('tint_formulas')
          .select('id', { count: 'exact', head: true })
          .eq('account', ACCOUNT)
          .is('desativada_em', null);
        totalFormulas = count ?? 0;
      } catch { /* */ }

      try {
        const { count: total } = await supabase
          .from('tint_skus')
          .select('id', { count: 'exact', head: true })
          .eq('account', ACCOUNT);
        const { count: mapped } = await supabase
          .from('tint_skus')
          .select('id', { count: 'exact', head: true })
          .eq('account', ACCOUNT)
          .not('omie_product_id', 'is', null);
        skusTotal = total ?? 0;
        skusMapped = mapped ?? 0;
      } catch { /* */ }

      try {
        const { data: imp } = await supabase
          .from('tint_importacoes')
          .select('id, tipo, arquivo_nome, registros_erro, status, created_at')
          .eq('account', ACCOUNT)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        lastImport = (imp as TintImportRow | null) ?? null;
      } catch { /* */ }

      try {
        const { data: errs } = await supabase
          .from('tint_importacoes')
          .select('id, arquivo_nome, registros_erro, created_at')
          .eq('account', ACCOUNT)
          .gt('registros_erro', 0)
          .order('created_at', { ascending: false })
          .limit(3);
        if (errs) {
          const rows = errs as Array<{
            id: string;
            arquivo_nome?: string | null;
            registros_erro?: number | null;
            created_at?: string | null;
          }>;
          topItems = rows.map((e) => ({
            id: e.id,
            icon: AlertTriangle,
            title: e.arquivo_nome ?? 'Importação',
            subtitle: `${e.registros_erro ?? 0} erro(s)`,
            path: '/tintometrico',
            itemType: 'tint_import_error',
            badge: { label: 'erro', intent: 'error' as const },
          }));
        }
      } catch { /* */ }

      return { totalFormulas, skusMapped, skusTotal, lastImport, topItems };
    },
    staleTime: 5 * 60 * 1000,
    refetchInterval: 5 * 60 * 1000,
  });

  const kpis: KpiSpec[] = useMemo(() => {
    if (!data) return [];
    const lastImport = data.lastImport as { status?: string | null } | null;
    return [
      { label: 'Fórmulas', value: formatCount(data.totalFormulas) },
      { label: 'SKUs mapeados', value: `${formatCount(data.skusMapped)}/${formatCount(data.skusTotal)}` },
      { label: 'Última import.', value: formatImportStatus(lastImport?.status) },
    ];
  }, [data]);

  const priority: PriorityCandidate | null = useMemo(() => {
    if (!data) return null;
    const errCount = Number(data.lastImport?.registros_erro ?? 0);
    if (errCount > 0) {
      const score = 95;
      return {
        zone: 'tintometrico',
        score,
        item: {
          id: 'tint_import_error',
          variant: variantFromScore(score),
          icon: AlertTriangle,
          title: `Última importação com ${errCount} erro(s)`,
          description: `${data.lastImport?.arquivo_nome ?? 'Importação'} requer revisão.`,
          cta: { label: 'Abrir tintométrico', path: '/tintometrico' },
          metadata: { source: 'tintometrico.import_error' },
        },
      };
    }
    return null;
  }, [data]);

  return { kpis, topItems: data?.topItems ?? [], priority, isLoading: applies && isLoading, isError, refetch, isLive, applies };
}
