import { useQuery } from '@tanstack/react-query';
import { format, subDays } from 'date-fns';
import { supabase } from '@/integrations/supabase/client';
import { fetchAllPagesComMensagem } from '@/lib/postgrest';
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

/**
 * Pagina além da capa silenciosa de 1.000 linhas do PostgREST pelo canônico (nunca truncar soma
 * money-path): página com error ou `data: null` sem error LANÇA — o vencido 60+ sairia SUBESTIMADO
 * como soma firme — e a página perdida é medida pela fonte.
 */
function fetchTitulosVencidosPar(par: ParCliente, corte: string): Promise<TituloVencidoRow[]> {
  return fetchAllPagesComMensagem<TituloVencidoRow>(
    (de, ate) =>
      supabase
        .from('fin_contas_receber')
        .select('saldo, data_vencimento')
        .eq('company', par.company)
        .eq('omie_codigo_cliente', par.codigo)
        .in('status_titulo', [...OPEN_TITLE_STATUSES])
        .lt('data_vencimento', corte)
        .gt('saldo', 0)
        .order('id', { ascending: true })
        .range(de, ate),
    'fin_contas_receber/alerta-credito',
    'fin_contas_receber',
  );
}

/** Vencido 60+ dos pares (company, código), com o frescor do sync. Lança em qualquer falha de leitura. */
async function buscarAlertaCredito(pares: ParCliente[]): Promise<AlertaCredito | null> {
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
}

export function useAlertaCreditoCliente(cliente: ClienteComCodigos | null | undefined) {
  const pares = paresDoCliente(cliente);
  const chave = pares.map((p) => `${p.company}:${p.codigo}`).join('|');

  return useQuery({
    queryKey: ['alerta-credito', chave],
    enabled: pares.length > 0,
    staleTime: 60_000,
    queryFn: () => buscarAlertaCredito(pares),
  });
}

/** Uma linha de `omie_customer_account_map_fresco` (a prova fresca usuário × conta × código). */
export interface ContaOmieMapeada {
  user_id: string;
  account: string;
  omie_codigo_cliente: number | null;
}

const CONTAS_RECEBER = new Set<ParCliente['company']>(['oben', 'colacor', 'colacor_sc']);

/**
 * Pares (company, código) a partir das contas mapeadas do cliente e dos aliases do grupo. Conta fora das
 * 3 empresas do contas a receber, código 0/null e duplicatas saem. A ordem é estável (company, código).
 */
export function paresDasContas(contas: ContaOmieMapeada[]): ParCliente[] {
  const vistos = new Map<string, ParCliente>();
  for (const c of contas) {
    if (!CONTAS_RECEBER.has(c.account as ParCliente['company'])) continue;
    if (c.omie_codigo_cliente == null || !(c.omie_codigo_cliente > 0)) continue;
    const par: ParCliente = { company: c.account as ParCliente['company'], codigo: c.omie_codigo_cliente };
    vistos.set(`${par.company}:${par.codigo}`, par);
  }
  return [...vistos.values()].sort((x, y) => x.company.localeCompare(y.company) || x.codigo - y.codigo);
}

/**
 * Crédito na FICHA (por `customer_user_id`, onde não há os códigos do wizard em mãos).
 * - `semConta`: nenhuma conta Omie mapeada para o cliente nem para os aliases → não há o que somar.
 * - `alerta`: null = nenhum título em aberto vencido há 60+ dias nas contas lidas (leitura POSITIVA:
 *   quem abre a ficha é staff, e staff passa em `fin_user_can_access`).
 * - `aliasesConferidos`: a RLS de `customer_canonical_alias` só abre para gestor/master. Para os demais,
 *   o 2º cadastro do grupo (outra empresa) NÃO entra, e a tela tem de dizer que a soma pode ser parcial.
 * - `conflito`: alias em `conflict` = identidade ambígua → não se afirma soma nenhuma.
 * Falha de qualquer leitura LANÇA (a ficha mostra "indisponível", nunca "nada vencido").
 */
export interface CreditoDaFicha {
  semConta: boolean;
  conflito: boolean;
  aliasesConferidos: boolean;
  alerta: AlertaCredito | null;
}

export function useCreditoDoCliente(customerId: string | undefined, { lerAliases }: { lerAliases: boolean }) {
  return useQuery({
    queryKey: ['credito-ficha', customerId, lerAliases],
    enabled: !!customerId,
    staleTime: 60_000,
    queryFn: async (): Promise<CreditoDaFicha> => {
      const id = customerId as string;
      let usuarios = [id];
      let conflito = false;
      if (lerAliases) {
        const { data, error } = await supabase
          .from('customer_canonical_alias')
          .select('alias_user_id, status')
          .eq('canonical_user_id', id);
        if (error) throw new Error(error.message);
        conflito = (data ?? []).some((a) => a.status === 'conflict');
        usuarios = [id, ...(data ?? []).filter((a) => a.status === 'active').map((a) => a.alias_user_id)];
      }
      if (conflito) return { semConta: false, conflito: true, aliasesConferidos: lerAliases, alerta: null };

      const { data: contas, error } = await supabase
        .from('omie_customer_account_map_fresco')
        .select('user_id, account, omie_codigo_cliente')
        .in('user_id', usuarios);
      if (error) throw new Error(error.message);
      const pares = paresDasContas((contas ?? []) as ContaOmieMapeada[]);
      if (pares.length === 0) return { semConta: true, conflito: false, aliasesConferidos: lerAliases, alerta: null };

      return { semConta: false, conflito: false, aliasesConferidos: lerAliases, alerta: await buscarAlertaCredito(pares) };
    },
  });
}
