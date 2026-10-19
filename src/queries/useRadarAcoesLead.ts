import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { invokeFunction } from '@/lib/invoke-function';
import { track } from '@/lib/analytics';
import type { RadarEmpresa } from '@/queries/useRadarLista';
import {
  cadastrarEmpresaNoOmie,
  type DepsCadastro,
  type OpcoesCadastro,
  type ResultadoCadastro,
} from '@/lib/radar/cadastro-omie';

// TODO: cast até o Lovable regenerar os tipos pós-migration (lição §10 CLAUDE.md)
type RpcFn = typeof supabase.rpc;

/** Payload da edge `omie-vendas-sync` action `criar_cliente` (conta Oben). */
function montarPayloadCriarCliente(e: RadarEmpresa) {
  return {
    action: 'criar_cliente',
    account: 'oben',
    document: e.cnpj,
    razao_social: e.razao_social || e.nome_fantasia || e.cnpj,
    nome_fantasia: e.nome_fantasia || undefined,
    endereco: e.logradouro || undefined,
    endereco_numero: e.numero || undefined,
    bairro: e.bairro || undefined,
    cidade: e.municipio_nome || undefined,
    estado: e.uf || undefined,
    cep: e.cep || undefined,
    telefone: e.telefone1 || e.telefone2 || undefined,
  };
}

/**
 * I/O real do cadastro (edge + RPC + leitura do vínculo). A DECISÃO mora em
 * `@/lib/radar/cadastro-omie` (pura, testada): resposta sem código é INDETERMINADA e não
 * grava no Radar; retomada relê o vínculo antes de repetir a RPC.
 */
export const depsCadastroSupabase: DepsCadastro<RadarEmpresa> = {
  // invokeFunction (não `supabase.functions.invoke` cru): em HTTP 500 o `error.message` do
  // supabase-js é o genérico "non-2xx"; o motivo real (ex.: `OMIE_TRANSIENT … rate limit`,
  // que PARA o lote) vem no corpo, e só o helper o lê (P1 do review Codex).
  criarNoOmie: (e) => invokeFunction<unknown>('omie-vendas-sync', montarPayloadCriarCliente(e)),
  registrarNoRadar: async (cnpj, codigo, jaExistia) => {
    const { error } = await (supabase.rpc as RpcFn)(
      'radar_registrar_cadastro_omie' as never,
      { p_cnpj: cnpj, p_codigo_cliente: codigo, p_ja_existia: jaExistia } as never,
    );
    if (error) throw error;
  },
  lerVinculo: async (cnpj) => {
    const { data, error } = await supabase
      .from('radar_empresas')
      .select('omie_codigo_cliente')
      .eq('cnpj', cnpj)
      .maybeSingle();
    if (error) throw error;
    return data?.omie_codigo_cliente ?? null;
  },
};

/**
 * Cadastra UMA empresa no Omie (Oben). Anti-dup: a edge consulta pelo documento antes de
 * criar; `created:false` = já existia. Depois persiste o vínculo via RPC.
 */
export function useRadarCadastrarOmie() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { empresa: RadarEmpresa; opcoes?: OpcoesCadastro }): Promise<ResultadoCadastro> =>
      cadastrarEmpresaNoOmie(v.empresa, depsCadastroSupabase, v.opcoes),
    onSuccess: (r) => {
      track('radar.lead_cadastrado_omie', { ja_existia: r.jaExistia, recuperado: r.recuperado });
      qc.invalidateQueries({ queryKey: ['radar'] });
    },
  });
}

/** RPC `radar_atribuir_tarefa` (SECURITY DEFINER gestor/master): { id, deduped }. */
export async function atribuirTarefaRadar(v: { cnpj: string; diasRetomada?: number }) {
  const { data, error } = await (supabase.rpc as RpcFn)(
    'radar_atribuir_tarefa' as never,
    { p_cnpj: v.cnpj, p_dias_retomada: v.diasRetomada ?? 7 } as never,
  );
  if (error) throw error;
  return data as unknown as { id: string; deduped: boolean };
}

/**
 * Cria (ou reaproveita) uma tarefa de retomada para o lead do radar.
 * `deduped: true` quando já havia tarefa aberta (janela de 2 min).
 */
export function useRadarAtribuirTarefa() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: atribuirTarefaRadar,
    onSuccess: () => {
      track('radar.tarefa_criada', {});
      qc.invalidateQueries({ queryKey: ['radar'] });
    },
  });
}
