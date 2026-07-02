import { useQuery } from '@tanstack/react-query';
import { format, subDays } from 'date-fns';
import { supabase } from '@/integrations/supabase/client';
import { OPEN_TITLE_STATUSES } from '@/lib/financeiro/titulo-status';

/**
 * Alerta de crédito no wizard de venda — FASE 1 do programa "back to basics"
 * (não bloqueia nada; Fase 2 é que adiciona aprovação de exceção).
 *
 * Critério: cliente com saldo em aberto vencido há 60+ dias (mesma régua que a
 * Fase 2 vai endurecer — não mudar o critério entre fases).
 *
 * Money-path (precisão > recall): só alerta com EVIDÊNCIA POSITIVA de vencido.
 * Sem documento, sem títulos ou erro na fonte → null (silêncio) — nunca um
 * "cliente OK" fabricado, e nunca acusação sem dado. O frescor do sync é
 * exibido junto (dados do Omie podem atrasar) com flag explícita de defasagem.
 */

export const ALERTA_CREDITO = {
  diasVencidoMin: 60,
  defasagemMaxHoras: 24,
} as const;

export interface TituloVencidoRow {
  saldo: number | null;
  data_vencimento: string | null;
}

export interface AlertaCredito {
  /** R$ total em aberto vencido há 60+ dias. */
  vencido: number;
  titulos: number;
  /** Vencimento mais antigo (yyyy-MM-dd). */
  vencimentoMaisAntigo: string | null;
  /** Último sync de recebíveis concluído (fin_sync_log status 'complete'). */
  syncAt: string | null;
  /** true quando o sync está a mais de 24h (ou sem registro) — dado pode estar defasado. */
  dadoDefasado: boolean;
}

/**
 * Variantes do documento para casar com `fin_contas_receber.cnpj_cpf` sem `.or()`
 * cru (armadilha PostgREST): só-dígitos + formatado CNPJ/CPF. Retorna null se o
 * documento não tem 11 (CPF) ou 14 (CNPJ) dígitos — sem documento válido, sem query.
 */
export function variantesDocumento(documento: string | null | undefined): string[] | null {
  const digits = (documento ?? '').replace(/\D/g, '');
  if (digits.length === 14) {
    return [digits, digits.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5')];
  }
  if (digits.length === 11) {
    return [digits, digits.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4')];
  }
  return null;
}

/** Cômputo puro (testável sem Supabase). `titulos` já vem filtrado pelo query (aberto + 60d + saldo > 0). */
export function computeAlertaCredito(
  titulos: TituloVencidoRow[],
  syncAt: string | null,
  agora: Date,
): AlertaCredito | null {
  if (titulos.length === 0) return null;

  let vencido = 0;
  let vencimentoMaisAntigo: string | null = null;
  for (const t of titulos) {
    vencido += Number(t.saldo ?? 0);
    if (t.data_vencimento && (!vencimentoMaisAntigo || t.data_vencimento < vencimentoMaisAntigo)) {
      vencimentoMaisAntigo = t.data_vencimento;
    }
  }
  if (vencido <= 0) return null;

  const dadoDefasado =
    !syncAt || agora.getTime() - new Date(syncAt).getTime() > ALERTA_CREDITO.defasagemMaxHoras * 3_600_000;

  return { vencido, titulos: titulos.length, vencimentoMaisAntigo, syncAt, dadoDefasado };
}

const PAGE = 1000;

/** Pagina além da capa silenciosa de 1.000 linhas do PostgREST (achado Codex — nunca truncar soma money-path). */
async function fetchTitulosVencidos(variantes: string[], corte: string): Promise<TituloVencidoRow[]> {
  const out: TituloVencidoRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('fin_contas_receber')
      .select('saldo, data_vencimento')
      .in('cnpj_cpf', variantes)
      .in('status_titulo', [...OPEN_TITLE_STATUSES])
      .lt('data_vencimento', corte)
      .gt('saldo', 0)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as TituloVencidoRow[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

export function useAlertaCreditoCliente(documento: string | null | undefined) {
  const variantes = variantesDocumento(documento);

  return useQuery({
    queryKey: ['alerta-credito', variantes?.[0] ?? null],
    enabled: variantes !== null,
    staleTime: 60_000,
    queryFn: async (): Promise<AlertaCredito | null> => {
      if (!variantes) return null;
      const corte = format(subDays(new Date(), ALERTA_CREDITO.diasVencidoMin), 'yyyy-MM-dd');

      const [titulos, syncRes] = await Promise.all([
        fetchTitulosVencidos(variantes, corte),
        supabase
          .from('fin_sync_log')
          .select('completed_at')
          .in('action', ['sync_contas_receber', 'sync_all'])
          .eq('status', 'complete')
          .order('completed_at', { ascending: false })
          .limit(1),
      ]);
      if (syncRes.error) throw new Error(syncRes.error.message);

      return computeAlertaCredito(
        titulos,
        (syncRes.data?.[0]?.completed_at as string | null) ?? null,
        new Date(),
      );
    },
  });
}
