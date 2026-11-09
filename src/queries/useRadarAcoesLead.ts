import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { invokeFunction } from '@/lib/invoke-function';
import { track } from '@/lib/analytics';
import { invalidarRadar } from '@/lib/radar/invalidar-cache';
import type { RadarEmpresa } from '@/queries/useRadarLista';
import {
  cadastrarEmpresaNoOmie,
  escolherRazaoFiscal,
  type DepsCadastro,
  type OpcoesCadastro,
  type ResultadoCadastro,
} from '@/lib/radar/cadastro-omie';
import { parsearConflito, parsearEstadoCadastro, parsearRegistroV2 } from '@/lib/radar/conflito-cadastro';


/** Payload da edge `omie-vendas-sync` action `criar_cliente` (conta Oben). `razaoFiscal` = a da Receita (MEI com CPF). */
function montarPayloadCriarCliente(e: RadarEmpresa, razaoFiscal: string | null) {
  return {
    action: 'criar_cliente',
    account: 'oben',
    document: e.cnpj,
    razao_social: razaoFiscal || e.nome_fantasia || e.cnpj,
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
 * I/O real do cadastro (edge + RPCs do Radar). A DECISÃO mora em `@/lib/radar/cadastro-omie`
 * (pura, testada): resposta sem código é INDETERMINADA e não grava no Radar; vínculo e conflitos
 * abertos são lidos JUNTOS no servidor antes de qualquer chamada (migration 20261027160000).
 * Toda resposta jsonb tem a forma CONFERIDA (`conflito-cadastro.ts`) — desvio lança.
 */
export const depsCadastroSupabase: DepsCadastro<RadarEmpresa> = {
  // invokeFunction (não `supabase.functions.invoke` cru): em HTTP 500 o `error.message` do
  // supabase-js é o genérico "non-2xx"; o motivo real (ex.: `OMIE_TRANSIENT … rate limit`,
  // que PARA o lote) vem no corpo, e só o helper o lê (P1 do review Codex).
  criarNoOmie: async (e) => {
    // A razão que a ficha mostra é a mascarada (LGPD, pacote J): a fiscal vem só desta RPC, logo antes do envio.
    const { data, error } = await supabase.rpc('radar_razao_social_para_cadastro', { p_cnpj: e.cnpj });
    const razao = escolherRazaoFiscal(e.razao_social, { data, erroCodigo: error ? (error.code ?? 'desconhecido') : null, erro: error });
    return invokeFunction<unknown>('omie-vendas-sync', montarPayloadCriarCliente(e, razao));
  },
  registrarNoRadar: async (cnpj, codigo, jaExistia) => {
    const { data, error } = await supabase.rpc('radar_registrar_cadastro_omie_v2', {
      p_cnpj: cnpj,
      p_codigo_cliente: codigo,
      p_ja_existia: jaExistia,
    });
    if (error) throw error;
    return parsearRegistroV2(data);
  },
  lerEstado: async (cnpj) => {
    const { data, error } = await supabase.rpc('radar_estado_cadastro_omie', { p_cnpj: cnpj });
    if (error) throw error;
    return parsearEstadoCadastro(data);
  },
  registrarConflito: async (cnpj, motivo, codigoRecebido, detalhe) => {
    // '' = sem código (o servidor faz NULLIF): o gerador tipa o parâmetro text como string.
    const { data, error } = await supabase.rpc('radar_registrar_conflito_cadastro', {
      p_cnpj: cnpj,
      p_motivo: motivo,
      p_codigo_recebido: codigoRecebido ?? '',
      p_detalhe: detalhe,
    });
    if (error) throw error;
    return parsearConflito(data, 'radar_registrar_conflito_cadastro');
  },
};

/** O que a oferta pós-sinal relê ANTES de cadastrar: a elegibilidade é do AGORA, não do snapshot. */
export type LeadParaCadastro = Pick<RadarEmpresa, 'cnpj' | 'ja_cliente' | 'omie_codigo_cliente' | 'prospeccao_status' | 'rfb_situacao' | 'ultimo_lote' | 'score'>;

/** Estado ATUAL do lead (null = não existe mais). Parecer Codex 2026-10-20: snapshot identifica o
 *  alvo, não prova elegibilidade — entre o sinal e o clique o lead pode ter virado cliente (lote em
 *  outra aba), sido descartado ou ganho vínculo. */
export async function lerLeadParaCadastro(cnpj: string): Promise<LeadParaCadastro | null> {
  const { data, error } = await supabase
    .from('radar_empresas')
    .select('cnpj,ja_cliente,omie_codigo_cliente,prospeccao_status,rfb_situacao,ultimo_lote,score')
    .eq('cnpj', cnpj)
    .maybeSingle();
  if (error) throw error;
  return data ?? null;
}

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
      void invalidarRadar(qc);
    },
    // A v2 grava o conflito e a lib LANÇA DivergenciaCadastro: sem isto a ficha e o indicador seguiriam em zero
    // com 1 conflito no servidor (Codex, código P2-2).
    onError: () => qc.invalidateQueries({ queryKey: ['radar', 'conflitos-cadastro'] }),
  });
}
