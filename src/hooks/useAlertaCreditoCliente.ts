import { useQuery } from '@tanstack/react-query';
import { format, subDays } from 'date-fns';
import { supabase } from '@/integrations/supabase/client';
import { OPEN_TITLE_STATUSES } from '@/lib/financeiro/titulo-status';

/**
 * Alerta de crédito no wizard de venda — FASE 1 do programa "back to basics"
 * (não bloqueia nada; a Fase 2 adiciona o enforcement na fronteira).
 *
 * Critério: cliente com saldo em aberto vencido há 60+ dias (mesma régua que a
 * Fase 2 endurece — não mudar o critério entre fases).
 *
 * ⚠️ Join por (company, omie_codigo_cliente), NUNCA por CNPJ: o ListarContasReceber
 * do Omie não retorna cnpj_cpf (verificado em prod: vazio nos 43k títulos, código
 * 100% populado) — o filtro por CNPJ da primeira versão casava 0 linhas SEMPRE.
 * O cliente do wizard carrega os códigos das 3 contas (oben/colacor/afiacao).
 *
 * Money-path (precisão > recall): só alerta com EVIDÊNCIA POSITIVA de vencido.
 * Sem códigos, sem títulos ou erro na fonte → null (silêncio) — nunca um
 * "cliente OK" fabricado, e nunca acusação sem dado. O frescor do sync é
 * exibido junto (dados do Omie podem atrasar) com flag explícita de defasagem.
 */

export const ALERTA_CREDITO = {
  diasVencidoMin: 60,
  defasagemMaxHoras: 24,
} as const;

export interface ParCliente {
  company: 'oben' | 'colacor' | 'colacor_sc';
  codigo: number;
}

/** Campos de código que o OmieCustomer do wizard carrega (cada conta Omie tem o seu). */
export interface ClienteComCodigos {
  codigo_cliente?: number | null;
  codigo_cliente_colacor?: number | null;
  codigo_cliente_afiacao?: number | null;
}

/**
 * Pares (company, código) do cliente para casar com `fin_contas_receber`.
 * Código 0/null é ignorado (cliente sintético do autoatendimento usa 0).
 */
export function paresDoCliente(cliente: ClienteComCodigos | null | undefined): ParCliente[] {
  if (!cliente) return [];
  const pares: ParCliente[] = [];
  if (cliente.codigo_cliente && cliente.codigo_cliente > 0) {
    pares.push({ company: 'oben', codigo: cliente.codigo_cliente });
  }
  if (cliente.codigo_cliente_colacor && cliente.codigo_cliente_colacor > 0) {
    pares.push({ company: 'colacor', codigo: cliente.codigo_cliente_colacor });
  }
  if (cliente.codigo_cliente_afiacao && cliente.codigo_cliente_afiacao > 0) {
    pares.push({ company: 'colacor_sc', codigo: cliente.codigo_cliente_afiacao });
  }
  return pares;
}

export interface TituloVencidoRow {
  saldo: number | null;
  data_vencimento: string | null;
}

export interface AlertaCredito {
  /** R$ total em aberto vencido há 60+ dias (todas as contas do grupo que o cliente tem). */
  vencido: number;
  titulos: number;
  /** Vencimento mais antigo (yyyy-MM-dd). */
  vencimentoMaisAntigo: string | null;
  /** Último sync de recebíveis concluído (fin_sync_log status 'complete'). */
  syncAt: string | null;
  /** true quando o sync está a mais de 24h (ou sem registro) — dado pode estar defasado. */
  dadoDefasado: boolean;
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

/** Pagina além da capa silenciosa de 1.000 linhas do PostgREST (nunca truncar soma money-path). */
async function fetchTitulosVencidosPar(par: ParCliente, corte: string): Promise<TituloVencidoRow[]> {
  const out: TituloVencidoRow[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('fin_contas_receber')
      .select('saldo, data_vencimento')
      .eq('company', par.company)
      .eq('omie_codigo_cliente', par.codigo)
      .in('status_titulo', [...OPEN_TITLE_STATUSES])
      .lt('data_vencimento', corte)
      .gt('saldo', 0)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    // data null SEM error = resposta malformada, não fim: o `?? []` de antes encerrava o
    // laço e o vencido 60+ saía SUBESTIMADO como soma firme (classe #1338→#1564).
    if (data == null) throw new Error('fin_contas_receber: data null sem error — malformada, não é fim');
    const rows = data as TituloVencidoRow[];
    out.push(...rows);
    if (rows.length < PAGE) break;
  }
  return out;
}

export function useAlertaCreditoCliente(cliente: ClienteComCodigos | null | undefined) {
  const pares = paresDoCliente(cliente);
  const chave = pares.map((p) => `${p.company}:${p.codigo}`).join('|');

  return useQuery({
    queryKey: ['alerta-credito', chave],
    enabled: pares.length > 0,
    staleTime: 60_000,
    queryFn: async (): Promise<AlertaCredito | null> => {
      if (pares.length === 0) return null;
      const corte = format(subDays(new Date(), ALERTA_CREDITO.diasVencidoMin), 'yyyy-MM-dd');

      const [porPar, syncRes] = await Promise.all([
        Promise.all(pares.map((p) => fetchTitulosVencidosPar(p, corte))),
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
        porPar.flat(),
        (syncRes.data?.[0]?.completed_at as string | null) ?? null,
        new Date(),
      );
    },
  });
}
