/**
 * Leituras e escritas da tela "Calendário de operação" (/admin/reposicao/calendario).
 *
 * LEITURA: toda leitura que pode crescer passa por `fetchAllPages` com `.order` TOTAL + `.range` — o
 * PostgREST corta em 1.000 linhas sem avisar, inclusive em `.rpc()`. Toda `queryFn` LANÇA no erro: a tela
 * mostra "não foi possível carregar", nunca grade/lista vazia (ausente ≠ zero).
 *
 * ESCRITA: só `master` (RLS). A tela esconde as ações para os demais; a garantia é a RLS. DELETE negado
 * pela RLS não dá erro — devolve 0 linhas —, então a remoção pede `.select()` e falha alto com 0.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { fetchAllPages } from '@/lib/postgrest';
import { addDias } from '@/lib/time/sp-day';
import { track } from '@/lib/analytics';
import { mensagemDeErro } from '@/lib/erro-mensagem';
import { useAuth } from '@/contexts/AuthContext';
import { datasDoPeriodo, pesoDoStatus, type LinhaDiaEmpresa, type StatusDia } from '@/lib/reposicao/calendario/grade';

export type EmpresaCalendario = 'OBEN' | 'COLACOR';
export const EMPRESAS_CALENDARIO: readonly EmpresaCalendario[] = ['OBEN', 'COLACOR'];

const RAIZ = 'calendario-operacao';

export type LinhaFornecedor = { data: string; fornecedor_nome: string; motivo: string | null; origem: string };
export type ItemAntecipar = {
  sku_codigo_omie: number;
  sku_descricao: string;
  fornecedor_nome: string;
  cobertura_dias: number;
  dias_ate_chegada_pos_recesso: number;
};

/** Todas as linhas da empresa (~470 hoje): servem a grade, as pendências, o último dia e o recesso. */
export function useDiasEmpresa(empresa: EmpresaCalendario) {
  return useQuery({
    queryKey: [RAIZ, 'empresa', empresa],
    queryFn: () =>
      fetchAllPages<LinhaDiaEmpresa>(
        (de, ate) =>
          supabase
            .from('calendario_operacao_empresa')
            .select('data, status, peso, motivo, origem')
            .eq('empresa', empresa)
            .order('data', { ascending: true })
            .range(de, ate),
        'calendario_operacao_empresa',
      ),
  });
}

export function useFeriados() {
  return useQuery({
    queryKey: [RAIZ, 'feriados'],
    queryFn: () =>
      fetchAllPages<{ data: string; nome: string }>(
        (de, ate) =>
          supabase
            .from('calendario_feriados')
            .select('data, nome')
            .order('data', { ascending: true })
            .order('nome', { ascending: true })
            .range(de, ate),
        'calendario_feriados',
      ),
    staleTime: 10 * 60_000,
  });
}

/** Teto da janela da detecção (dias, inclusive hoje) — é o que mantém a RPC numa página só. */
const JANELA_DIAS_SEM_NF = 366;

/** Detecção de dia útil sem NF — a RPC só devolve algo para a OBEN (COLACOR: `enabled:false`). */
export function useDiasSemNf(empresa: EmpresaCalendario, hoje: string) {
  return useQuery({
    queryKey: [RAIZ, 'dias-sem-nf', empresa, hoje],
    enabled: empresa === 'OBEN',
    queryFn: async () => {
      // Chamada ÚNICA, sem paginação: a janela é travada em 366 dias (hoje−365..hoje) e a RPC devolve no
      // máximo 1 linha por dia ⇒ ≤ 366 linhas, abaixo da capa de 1.000 do PostgREST por construção.
      // SEM `.order` de propósito: ordenar SETOF date pelo nome da função é contrato do PostgREST nunca
      // provado aqui. A ordem é feita no cliente.
      const { data, error } = await supabase.rpc('calendario_dias_sem_nf', {
        p_empresa: empresa,
        p_de: addDias(hoje, -JANELA_DIAS_SEM_NF + 1),
        p_ate: hoje,
      });
      if (error) throw error;
      const linhas = (data ?? []) as unknown as string[];
      return [...new Set(linhas.map((d) => String(d).slice(0, 10)))].sort();
    },
  });
}

export function useFornecedoresHabilitados(empresa: EmpresaCalendario) {
  return useQuery({
    queryKey: [RAIZ, 'fornecedores-habilitados', empresa],
    queryFn: async () => {
      const linhas = await fetchAllPages<{ fornecedor_nome: string }>(
        (de, ate) =>
          supabase
            .from('fornecedor_habilitado_reposicao')
            .select('fornecedor_nome')
            .eq('empresa', empresa)
            .eq('habilitado', true)
            .order('fornecedor_nome', { ascending: true })
            .range(de, ate),
        'fornecedor_habilitado_reposicao',
      );
      return [...new Set(linhas.map((l) => l.fornecedor_nome))];
    },
  });
}

/** ~616 linhas hoje — a capa de 1.000 está perto: paginado com ordem total (PK). */
export function useFechamentosFornecedor(empresa: EmpresaCalendario) {
  return useQuery({
    queryKey: [RAIZ, 'fornecedor', empresa],
    queryFn: () =>
      fetchAllPages<LinhaFornecedor>(
        (de, ate) =>
          supabase
            .from('calendario_operacao_fornecedor')
            .select('data, fornecedor_nome, motivo, origem')
            .eq('empresa', empresa)
            .order('fornecedor_nome', { ascending: true })
            .order('data', { ascending: true })
            .range(de, ate),
        'calendario_operacao_fornecedor',
      ),
  });
}

/** Informativa: o motor NÃO muda por causa desta lista. `fimRecesso` null ⇒ a pergunta não é feita. */
export function useItensAntecipar(empresa: EmpresaCalendario, fimRecesso: string | null) {
  return useQuery({
    queryKey: [RAIZ, 'antecipar', empresa, fimRecesso],
    enabled: fimRecesso !== null,
    queryFn: () =>
      fetchAllPages<ItemAntecipar>(
        (de, ate) =>
          supabase
            .rpc('calendario_itens_antecipar', { p_empresa: empresa, p_fim_recesso: fimRecesso as string })
            .order('sku_codigo_omie', { ascending: true })
            .order('fornecedor_nome', { ascending: true })
            .range(de, ate),
        'calendario_itens_antecipar',
      ),
  });
}

/* ─── escritas ─── */

export type SalvarDia = {
  empresa: EmpresaCalendario;
  data: string;
  status: StatusDia;
  motivo: string | null;
  origem: 'manual' | 'emenda';
  /** só para o evento: 'grade' | 'emenda' | 'pendencia' */
  contexto: string;
};

function useInvalidar() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: [RAIZ] });
}

export function useSalvarDiaEmpresa() {
  const { user } = useAuth();
  const invalidar = useInvalidar();
  return useMutation({
    mutationFn: async (v: SalvarDia) => {
      const { error } = await supabase.from('calendario_operacao_empresa').upsert(
        {
          data: v.data,
          empresa: v.empresa,
          status: v.status,
          peso: pesoDoStatus(v.status),
          motivo: v.motivo?.trim() ? v.motivo.trim() : null,
          origem: v.origem,
          decidido_por: user?.id ?? null,
          atualizado_em: new Date().toISOString(),
        },
        { onConflict: 'data,empresa' },
      );
      if (error) throw error;
    },
    onSuccess: (_r, v) => {
      track('reposicao.calendario_dia_salvo', { empresa: v.empresa, status: v.status, origem: v.origem, contexto: v.contexto });
      toast.success('Dia salvo no calendário');
      void invalidar();
    },
    onError: (e) => toast.error('Não foi possível salvar o dia', { description: mensagemDeErro(e) ?? 'Erro sem mensagem — tente de novo.' }),
  });
}

export function useRemoverDiaEmpresa() {
  const invalidar = useInvalidar();
  return useMutation({
    mutationFn: async (v: { empresa: EmpresaCalendario; data: string }) => {
      const { data, error } = await supabase
        .from('calendario_operacao_empresa')
        .delete()
        .eq('empresa', v.empresa)
        .eq('data', v.data)
        .select('data');
      if (error) throw error;
      if (!data || data.length === 0) throw new Error('Nenhuma linha removida — sem permissão ou o dia já estava na regra base.');
    },
    onSuccess: (_r, v) => {
      track('reposicao.calendario_dia_removido', { empresa: v.empresa });
      toast.success('Dia voltou para a regra base');
      void invalidar();
    },
    onError: (e) => toast.error('Não foi possível remover o dia', { description: mensagemDeErro(e) ?? 'Erro sem mensagem — tente de novo.' }),
  });
}

export function useIncluirPeriodoFornecedor() {
  const { user } = useAuth();
  const invalidar = useInvalidar();
  return useMutation({
    mutationFn: async (v: { empresa: EmpresaCalendario; fornecedor_nome: string; de: string; ate: string; motivo: string | null }) => {
      const datas = datasDoPeriodo(v.de, v.ate);
      const agora = new Date().toISOString();
      const { error } = await supabase.from('calendario_operacao_fornecedor').upsert(
        datas.map((data) => ({
          data,
          empresa: v.empresa,
          fornecedor_nome: v.fornecedor_nome,
          motivo: v.motivo?.trim() ? v.motivo.trim() : null,
          origem: 'manual',
          decidido_por: user?.id ?? null,
          atualizado_em: agora,
        })),
        { onConflict: 'data,empresa,fornecedor_nome' },
      );
      if (error) throw error;
      return datas.length;
    },
    onSuccess: (n, v) => {
      track('reposicao.calendario_periodo_fornecedor_incluido', { empresa: v.empresa, dias: n });
      toast.success(`Período incluído (${n} dia(s))`);
      void invalidar();
    },
    onError: (e) => toast.error('Não foi possível incluir o período', { description: mensagemDeErro(e) ?? 'Erro sem mensagem — tente de novo.' }),
  });
}

export function useRemoverPeriodoFornecedor() {
  const invalidar = useInvalidar();
  return useMutation({
    mutationFn: async (v: { empresa: EmpresaCalendario; fornecedor_nome: string; de: string; ate: string }) => {
      const { data, error } = await supabase
        .from('calendario_operacao_fornecedor')
        .delete()
        .eq('empresa', v.empresa)
        .eq('fornecedor_nome', v.fornecedor_nome)
        .gte('data', v.de)
        .lte('data', v.ate)
        .select('data');
      if (error) throw error;
      if (!data || data.length === 0) throw new Error('Nenhuma linha removida — sem permissão ou o período já não existia.');
      return data.length;
    },
    onSuccess: (n, v) => {
      track('reposicao.calendario_periodo_fornecedor_removido', { empresa: v.empresa, dias: n });
      toast.success(`Período removido (${n} dia(s))`);
      void invalidar();
    },
    onError: (e) => toast.error('Não foi possível remover o período', { description: mensagemDeErro(e) ?? 'Erro sem mensagem — tente de novo.' }),
  });
}
