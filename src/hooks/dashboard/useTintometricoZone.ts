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
    // Leitura que falha LANÇA (react-query → isError → a zona mostra erro). Antes, 4 blocos
    // `try { … } catch { /* */ }` que nem liam o `error` do PostgREST faziam falha virar
    // "0 fórmulas · 0/0 SKUs" — um painel de saúde afirmando vazio em vez de "não li".
    queryFn: async () => {
      const [skusTotalRes, skusMappedRes, impRes, errsRes] = await Promise.all([
        supabase
          .from('tint_skus')
          .select('id', { count: 'exact', head: true })
          .eq('account', ACCOUNT),
        supabase
          .from('tint_skus')
          .select('id', { count: 'exact', head: true })
          .eq('account', ACCOUNT)
          .not('omie_product_id', 'is', null),
        supabase
          .from('tint_importacoes')
          .select('id, tipo, arquivo_nome, registros_erro, status, created_at')
          .eq('account', ACCOUNT)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
        supabase
          .from('tint_importacoes')
          .select('id, arquivo_nome, registros_erro, created_at')
          .eq('account', ACCOUNT)
          .gt('registros_erro', 0)
          .order('created_at', { ascending: false })
          .limit(3),
      ]);
      if (skusTotalRes.error) throw skusTotalRes.error;
      if (skusMappedRes.error) throw skusMappedRes.error;
      if (impRes.error) throw impRes.error;
      if (errsRes.error) throw errsRes.error;
      if (skusTotalRes.count == null || skusMappedRes.count == null) {
        throw new Error('tintometrico: contagem exata não veio do PostgREST');
      }
      const skusTotal = skusTotalRes.count;
      const skusMapped = skusMappedRes.count;
      const lastImport = (impRes.data as TintImportRow | null) ?? null;
      const rows = (errsRes.data ?? []) as Array<{
        id: string;
        arquivo_nome?: string | null;
        registros_erro?: number | null;
        created_at?: string | null;
      }>;
      const topItems: TopListItem[] = rows.map((e) => ({
        id: e.id,
        icon: AlertTriangle,
        title: e.arquivo_nome ?? 'Importação',
        subtitle: `${e.registros_erro ?? 0} erro(s)`,
        path: '/tintometrico',
        itemType: 'tint_import_error',
        badge: { label: 'erro', intent: 'error' as const },
      }));

      return { skusMapped, skusTotal, lastImport, topItems };
    },
    staleTime: 5 * 60 * 1000,
    refetchInterval: 5 * 60 * 1000,
  });

  // Adoção do balcão (RPC tint_adocao_balcao): dos pedidos com cor em 30d, quantos saíram do
  // seletor do app. Query SEPARADA de propósito: se a RPC falhar (ou ainda não estiver aplicada),
  // o KPI mostra "—" — nunca "0" — e o resto da zona continua de pé.
  const { data: adocao } = useQuery({
    queryKey: ['dashboard', 'tintometrico', 'adocao', applies],
    enabled: applies,
    queryFn: async () => {
      const { data: linhas, error } = await supabase.rpc('tint_adocao_balcao' as never, { p_dias: 30 } as never);
      if (error) throw error;
      const linha = (linhas as unknown as Array<{ pedidos_com_cor: number; pelo_app: number }> | null)?.[0];
      if (!linha) throw new Error('tint_adocao_balcao: RPC não devolveu a linha de contagem');
      return { comCor: Number(linha.pedidos_com_cor), peloApp: Number(linha.pelo_app) };
    },
    staleTime: 5 * 60 * 1000,
    refetchInterval: 5 * 60 * 1000,
  });

  const kpis: KpiSpec[] = useMemo(() => {
    if (!data) return [];
    const lastImport = data.lastImport as { status?: string | null } | null;
    // "Cor pelo app" substituiu "Fórmulas" (491k, quase estático): é o número que decide a próxima
    // fase do tintométrico — a grade tem 3 colunas.
    return [
      {
        label: 'Cor pelo app (30d)',
        value: adocao ? `${formatCount(adocao.peloApp)}/${formatCount(adocao.comCor)}` : '—',
      },
      { label: 'SKUs mapeados', value: `${formatCount(data.skusMapped)}/${formatCount(data.skusTotal)}` },
      { label: 'Última import.', value: formatImportStatus(lastImport?.status) },
    ];
  }, [data, adocao]);

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
