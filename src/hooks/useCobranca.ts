import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { Json } from '@/integrations/supabase/types';
import { fetchAllPages } from '@/lib/postgrest';
import { normalizarFila, normalizarRegua, ordenarFila, ordenarRegua, type FilaItem, type ReguaItem } from '@/lib/cobranca/cobranca-helpers';

/**
 * Leituras e o writer da fila de cobrança (Frente B, PR2). As RPCs são SECURITY DEFINER com gate staff e
 * visibilidade por dona/gestão — a tela não filtra autorização, só exibe. Erro de leitura LANÇA (react-query
 * expõe `error`); nunca vira fila vazia. `cobranca_fila` lê v_ciclo_cliente_resumo (agrega a empresa; ~3 s).
 */

export type Empresa = 'oben' | 'colacor' | 'colacor_sc';

export function useCobrancaFila(company: Empresa) {
  return useQuery({
    queryKey: ['cobranca', 'fila', company],
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
    // RPC set-returning pagina pelo canônico (capa silenciosa de 1.000 do PostgREST vale para .rpc()).
    queryFn: async (): Promise<FilaItem[]> => {
      const linhas = await fetchAllPages(
        (de, ate) => supabase.rpc('cobranca_fila', { p_company: company }).select('*').order('omie_codigo_cliente', { ascending: true }).range(de, ate),
        'cobranca_fila',
      );
      return ordenarFila(linhas.map((r) => normalizarFila(r as Record<string, unknown>)).filter((x): x is FilaItem => x !== null));
    },
  });
}

export function useCobrancaRegua(company: Empresa) {
  return useQuery({
    queryKey: ['cobranca', 'regua', company],
    // A régua manda mensagem: não pode viver de cache velho (pagamento/telefone/dona mudam com o sync).
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
    refetchOnMount: 'always',
    queryFn: async (): Promise<ReguaItem[]> => {
      const linhas = await fetchAllPages(
        (de, ate) => supabase.rpc('cobranca_regua_hoje', { p_company: company }).select('*').order('omie_codigo_lancamento', { ascending: true }).range(de, ate),
        'cobranca_regua_hoje',
      );
      return ordenarRegua(linhas.map((r) => normalizarRegua(r as Record<string, unknown>)).filter((x): x is ReguaItem => x !== null));
    },
  });
}

export type AcaoCobranca = {
  company: Empresa;
  omieCodigoCliente: number;
  nomeCliente?: string | null;
  acao: 'estado' | 'contato' | 'whatsapp_aberto' | 'promessa' | 'nota' | 'fechar';
  paraEstado?: string;
  canal?: string;
  nota?: string;
  promessaData?: string;
  promessaValor?: number;
  proximoContatoEm?: string;
  fechadoMotivo?: 'quitado' | 'cancelado_gestao';
};

/** Writer único: tudo passa por `cobranca_caso_registrar` (cria o caso, valida a máquina de estados, grava o evento e o sensor). */
export function useCobrancaRegistrar() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (a: AcaoCobranca): Promise<Json> => {
      const p: Record<string, Json> = {
        company: a.company, omie_codigo_cliente: a.omieCodigoCliente, acao: a.acao,
        nome_cliente: a.nomeCliente ?? null, para_estado: a.paraEstado ?? null, canal: a.canal ?? null, nota: a.nota ?? null,
        promessa_data: a.promessaData ?? null, promessa_valor: a.promessaValor ?? null,
        proximo_contato_em: a.proximoContatoEm ?? null, fechado_motivo: a.fechadoMotivo ?? null,
      };
      const { data, error } = await supabase.rpc('cobranca_caso_registrar', { p });
      if (error) throw new Error(error.message);
      return data;
    },
    // Aguarda a releitura: a ação só "termina" quando a fila já reflete o estado novo (uma releitura, não duas).
    onSuccess: async (_d, a) => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['cobranca', 'fila', a.company] }),
        qc.invalidateQueries({ queryKey: ['cobranca', 'regua', a.company] }),
      ]);
    },
  });
}
