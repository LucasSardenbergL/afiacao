import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { OPEN_TITLE_STATUSES } from '@/lib/financeiro/titulo-status';
import {
  concentracaoEmpresa,
  classificarFonte,
  isOverdueTitleStatus,
} from '@/lib/financeiro/concentracao-helpers';
import type { Company, ConcentracaoResult, TituloAberto } from '@/lib/financeiro/concentracao-types';

const LIMIT = 5000;

/**
 * F5 — concentração de recebíveis ABERTOS por código Omie (proxy de sacado), por empresa.
 * Spec: docs/superpowers/specs/2026-07-05-concentracao-recebiveis-design.md
 *
 * Lê `fin_contas_receber` (RLS já provado — a aba "A Receber" do mesmo dashboard lê a
 * mesma tabela), atesta o FonteStatus (guarda o cap PostgREST via `count: 'exact'`) e
 * delega TODA a matemática ao helper puro. Money-path: leitura incompleta/erro NÃO vira
 * zero (fonte 'indisponivel'/'parcial'), o helper não fabrica.
 *
 * Filtro de aberto = `isOpenTitleStatus` (superset canônico espelhado no cashflow engine)
 * — evita silêncio caso o ingest grave 'VENCIDO'/'PARCIAL' em vez de só 'A VENCER'/'ATRASADO'.
 */
export function useConcentracaoRecebiveis() {
  return useQuery({
    queryKey: ['concentracao-recebiveis'],
    staleTime: 60_000,
    queryFn: async (): Promise<Record<Company, ConcentracaoResult>> => {
      const { data, error, count } = await supabase
        .from('fin_contas_receber')
        .select('omie_codigo_cliente, saldo, status_titulo, company', { count: 'exact' })
        .in('status_titulo', [...OPEN_TITLE_STATUSES])
        .order('id', { ascending: true })
        .range(0, LIMIT - 1);

      const rows = data ?? [];
      const fonte = classificarFonte({
        error: !!error,
        rowsRetornadas: rows.length,
        countTotal: count ?? null,
        limit: LIMIT,
      });

      const porEmpresa: Record<Company, TituloAberto[]> = { oben: [], colacor: [], colacor_sc: [] };
      for (const row of rows) {
        const co = row.company as Company;
        if (!(co in porEmpresa)) continue; // empresa desconhecida: ignora, não quebra
        porEmpresa[co].push({
          omie_codigo_cliente: row.omie_codigo_cliente,
          saldo: Number(row.saldo), // null/''→0/NaN → cai como INVÁLIDA no helper (não some)
          // vencido por lista POSITIVA (ATRASADO/VENCIDO), não por complemento — 'PARCIAL' é
          // aberto mas não necessariamente vencido; complemento inflaria o vencido (Codex).
          atrasado: isOverdueTitleStatus(row.status_titulo),
        });
      }

      return {
        oben: concentracaoEmpresa(porEmpresa.oben, fonte),
        colacor: concentracaoEmpresa(porEmpresa.colacor, fonte),
        colacor_sc: concentracaoEmpresa(porEmpresa.colacor_sc, fonte),
      };
    },
  });
}
