import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useDashboardCompany } from '@/hooks/useDashboardCompany';
import { useLastVisit } from '@/hooks/useLastVisit';
import type { DeltaSpec } from '@/lib/dashboard/delta-aggregators';
import type { Persona } from '@/lib/dashboard/persona-config';

export interface BriefDelta extends DeltaSpec {
  /** Caminho clicável que filtra pela janela de tempo do delta. */
  path: string;
  /** Identificador pra telemetria. */
  type: string;
}

/** O que a leitura dos deltas devolveu: os que têm novidade e os que NÃO puderam ser contados. */
export interface LeituraDosDeltas {
  deltas: BriefDelta[];
  /** Rótulos (plural, minúsculo) dos deltas cuja contagem falhou — "nada novo" ≠ "não consegui contar". */
  falhas: string[];
}

type RespostaDeContagem = { count: number | null; error: unknown };

/**
 * Conta UM delta. A falha vai para `falhas`, não some: antes o `error` era descartado e o
 * `catch` vazio engolia o resto, e a faixa dizia "Sem mudanças desde sua última visita"
 * quando a verdade era "não consegui ver" (plano v8, C13).
 */
async function contar(
  leitura: LeituraDosDeltas,
  spec: Omit<BriefDelta, 'value'>,
  consulta: () => PromiseLike<RespostaDeContagem>,
): Promise<void> {
  try {
    const { count, error } = await consulta();
    if (error || count == null) {
      leitura.falhas.push(spec.label);
      return;
    }
    if (count > 0) leitura.deltas.push({ ...spec, value: count });
  } catch {
    leitura.falhas.push(spec.label);
  }
}

/**
 * Busca contagens de eventos relevantes desde `since`.
 *
 * - sales_orders criados desde a última visita
 * - nfe_recebimentos criados desde a última visita
 * - orders status=orcamento_enviado desde a última visita
 *
 * Não há delta de "aumentos anunciados" (plano v8, C13): ele contava `eventos_outlier` por
 * `created_at`, coluna que a tabela não tem (são `detectado_em`/`data_evento`) — toda carga da
 * home fazia um request 400 — e outlier não é aumento anunciado. A tabela certa
 * (`fornecedor_aumento_anunciado`) tinha 0 linhas: a superfície nunca foi usada. Removido.
 */
export async function lerDeltas(since: string): Promise<LeituraDosDeltas> {
  const leitura: LeituraDosDeltas = { deltas: [], falhas: [] };

  // sales_orders novos
  await contar(
    leitura,
    {
      type: 'sales_new',
      label: 'pedidos',
      singular: 'pedido',
      path: `/sales?createdAfter=${encodeURIComponent(since)}`,
    },
    () =>
      supabase
        .from('sales_orders')
        .select('id', { count: 'exact', head: true })
        .gte('created_at', since)
        // Conta o que o feed (/sales) mostra: todo status, sem o pedido apagado.
        .is('deleted_at', null),
  );

  // NF-es novas
  await contar(
    leitura,
    {
      type: 'nfe_new',
      label: 'NF chegaram',
      singular: 'NF chegou',
      path: `/recebimento?createdAfter=${encodeURIComponent(since)}`,
    },
    () =>
      supabase
        .from('nfe_recebimentos')
        .select('id', { count: 'exact', head: true })
        .gte('created_at', since),
  );

  // Orçamentos novos
  await contar(
    leitura,
    {
      type: 'orcamentos_new',
      label: 'orçamentos enviados',
      singular: 'orçamento enviado',
      path: `/admin?status=orcamento_enviado`,
    },
    () =>
      supabase
        .from('orders')
        .select('id', { count: 'exact', head: true })
        .gte('created_at', since)
        .eq('status', 'orcamento_enviado'),
  );

  return leitura;
}

export function useBriefDeltas(_persona: Persona): {
  deltas: BriefDelta[];
  /** Rótulos dos deltas que não puderam ser contados. Com falha, a faixa NÃO pode dizer "sem mudanças". */
  falhas: string[];
  isLoading: boolean;
  isEmpty: boolean;
} {
  const { companies, mode } = useDashboardCompany();
  const { lastVisitIso } = useLastVisit();

  const enabled = !!lastVisitIso;

  const queryKey = ['dashboard', 'brief-deltas', mode, companies.join(','), lastVisitIso ?? 'none'];

  const { data, isLoading } = useQuery({
    queryKey,
    enabled,
    queryFn: async (): Promise<LeituraDosDeltas> => {
      if (!lastVisitIso) return { deltas: [], falhas: [] };
      return lerDeltas(lastVisitIso);
    },
    staleTime: 60 * 1000,
  });

  const deltas = data?.deltas ?? [];
  const falhas = data?.falhas ?? [];
  // Cap em 5 bullets (cap conforme spec).
  const capped = deltas.slice(0, 5);
  return { deltas: capped, falhas, isLoading: enabled && isLoading, isEmpty: capped.length === 0 };
}
