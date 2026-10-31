// "Segurar compra" (Oben): leituras e escritas pelas RPCs reposicao_compra_suspensa_* (SECURITY DEFINER, gate
// cap_compras_ler / cap_compras_escrever — master). Erro de leitura LANÇA (react-query expõe `error`), nunca vira
// lista vazia. Escrita: só pelas RPCs (1 writer); o efeito no motor vale no PRÓXIMO run (≤2h ou "Recalcular").
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { fetchAllPages } from '@/lib/postgrest';
import { track } from '@/lib/analytics';
import { mensagemDeErro } from '@/lib/erro-mensagem';
import type { Company } from '@/contexts/CompanyContext';
import { filaCiclo, retryDelayCiclo } from '@/lib/financeiro/ciclo-fila';
import {
  normalizarCandidato, normalizarRun, normalizarSuspensa, type Candidato, type OrigemSuspensao, type RunMotor, type SuspensaAtiva,
} from '@/lib/financeiro/compra-suspensa-helpers';

/** sku_parametros/venda_items_history falam MAIÚSCULO; a aba Ciclo fala Company. colacor_sc não tem SKU → null. */
function empresaDaCompra(company: Company): string | null {
  if (company === 'oben') return 'OBEN';
  if (company === 'colacor') return 'COLACOR';
  return null;
}

const chave = (company: Company) => ['financeiro', 'ciclo', 'compra-suspensa', company] as const;
const MSG_SEM_PERMISSAO = 'Sem permissão para segurar/reativar compra (exige papel master com acesso a compras).';

function avisarErro(e: unknown, fallback: string) {
  const code = (e as { code?: unknown } | null)?.code;
  if (code === '42501') toast.error(MSG_SEM_PERMISSAO);
  else toast.error(mensagemDeErro(e) ?? fallback);
}

export function useCompraSuspensaListar(company: Company, enabled = true) {
  const empresa = empresaDaCompra(company);
  return useQuery({
    queryKey: [...chave(company), 'ativas'],
    enabled: enabled && empresa !== null,
    retryDelay: retryDelayCiclo,
    // Na fila do ciclo: a aba limita leituras concorrentes (ciclo-fila.ts) — sem isto o painel fura o teto.
    queryFn: (): Promise<SuspensaAtiva[]> => filaCiclo(async () => {
      const linhas = await fetchAllPages(
        (de, ate) => supabase.rpc('reposicao_compra_suspensa_listar', { p_empresa: empresa as string }).select('*')
          .order('foto_valor_vendido_90d', { ascending: false, nullsFirst: false })
          .order('sku_codigo_omie', { ascending: true })
          .range(de, ate),
        'reposicao_compra_suspensa_listar',
      );
      return linhas.map(normalizarSuspensa).filter((l): l is SuspensaAtiva => l !== null);
    }),
  });
}

export function useCompraSuspensaRuns(company: Company, dias = 30, enabled = true) {
  const empresa = empresaDaCompra(company);
  return useQuery({
    queryKey: [...chave(company), 'runs', dias],
    enabled: enabled && empresa !== null,
    retryDelay: retryDelayCiclo,
    queryFn: (): Promise<RunMotor[]> => filaCiclo(async () => {
      // 30 dias × 12 runs/dia = 360 linhas: cabe numa página, mas paginar custa nada e não depende do cron.
      const linhas = await fetchAllPages(
        (de, ate) => supabase.rpc('reposicao_compra_suspensa_runs', { p_empresa: empresa as string, p_dias: dias }).select('*')
          .order('criado_em', { ascending: false }).range(de, ate),
        'reposicao_compra_suspensa_runs',
      );
      return linhas.map(normalizarRun).filter((l): l is RunMotor => l !== null);
    }),
  });
}

/** Coorte "cobertura ≥ N dias" recalculada agora pelo banco (dupla janela, sem corante, sem substituído, sem já suspensos). */
export function useCompraSuspensaCandidatos(company: Company, minDias = 180, enabled = true) {
  const empresa = empresaDaCompra(company);
  return useQuery({
    queryKey: [...chave(company), 'candidatos', minDias],
    enabled: enabled && empresa !== null,
    retryDelay: retryDelayCiclo,
    queryFn: (): Promise<Candidato[]> => filaCiclo(async () => {
      const linhas = await fetchAllPages(
        (de, ate) => supabase.rpc('reposicao_compra_suspensa_candidatos', { p_empresa: empresa as string, p_min_dias: minDias }).select('*')
          .order('valor', { ascending: false, nullsFirst: false }).order('sku_codigo_omie', { ascending: true }).range(de, ate),
        'reposicao_compra_suspensa_candidatos',
      );
      return linhas.map(normalizarCandidato).filter((l): l is Candidato => l !== null);
    }),
  });
}

export type SuspenderArgs = { skus: number[]; motivo: string; revisarEm: string; origem: OrigemSuspensao };
export type ResultadoSuspender = { sku: number; inserido: boolean; recusa: string | null; pendentesN: number };
export type ResultadoReativar = { sku: number; reativado: boolean; impedimento: string | null };

export function useCompraSuspensaMutacoes(company: Company) {
  const qc = useQueryClient();
  const empresa = empresaDaCompra(company);
  // Invalida as leituras da suspensão desta empresa (ativas, runs, candidatos); a coluna "Compra" lê a lista de ativas.
  const invalidar = () => qc.invalidateQueries({ queryKey: chave(company) });

  const suspender = useMutation({
    mutationFn: async (a: SuspenderArgs): Promise<ResultadoSuspender[]> => {
      if (!empresa) throw new Error('Empresa sem SKU de estoque');
      const { data, error } = await supabase.rpc('reposicao_compra_suspender', {
        p_empresa: empresa, p_skus: a.skus, p_motivo: a.motivo, p_revisar_em: a.revisarEm, p_origem: a.origem,
      });
      if (error) throw error;
      return (data ?? []).map((r) => ({ sku: r.sku_codigo_omie, inserido: r.inserido, recusa: r.recusa, pendentesN: r.pendentes_n }));
    },
    onSuccess: (res, a) => {
      const inseridos = res.filter((r) => r.inserido).length;
      const recusados = res.filter((r) => !r.inserido);
      const pendentes = res.reduce((s, r) => s + r.pendentesN, 0);
      track('reposicao.compra_suspensa', { empresa: company, skus: a.skus.length, inseridos, origem: a.origem });
      if (inseridos > 0) {
        toast.success(`${inseridos} SKU(s) com compra suspensa — vale no próximo recálculo do motor (até 2h).`
          + (pendentes > 0 ? ` ${pendentes} item(ns) ainda em pedido pendente de hoje: recalcule para tirar.` : ''));
      }
      if (recusados.length > 0) toast.message(`${recusados.length} SKU(s) não entraram: ${recusados.map((r) => `${r.sku} (${r.recusa ?? 'já suspenso'})`).join(', ')}`);
      void invalidar();
    },
    onError: (e) => avisarErro(e, 'Não foi possível suspender a compra.'),
  });

  const reativar = useMutation({
    mutationFn: async (a: { skus: number[]; motivo: string | null }): Promise<ResultadoReativar[]> => {
      if (!empresa) throw new Error('Empresa sem SKU de estoque');
      const { data, error } = await supabase.rpc('reposicao_compra_reativar', {
        p_empresa: empresa, p_skus: a.skus, ...(a.motivo ? { p_motivo: a.motivo } : {}),
      });
      if (error) throw error;
      return (data ?? []).map((r) => ({ sku: r.sku_codigo_omie, reativado: r.reativado, impedimento: r.impedimento }));
    },
    onSuccess: (res, a) => {
      const reativados = res.filter((r) => r.reativado).length;
      const impedidos = res.filter((r) => r.impedimento);
      track('reposicao.compra_reativada', { empresa: company, skus: a.skus.length, reativados });
      if (reativados > 0) toast.success(`${reativados} SKU(s) reativado(s) para compra — o motor volta a sugerir no próximo recálculo.`);
      if (impedidos.length > 0) toast.message(`Atenção: ${impedidos.map((r) => `${r.sku} ${r.impedimento}`).join('; ')}`);
      void invalidar();
    },
    onError: (e) => avisarErro(e, 'Não foi possível reativar a compra.'),
  });

  return { suspender, reativar };
}
