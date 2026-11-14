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
import { lerContatoContabil, type LeituraContatoContabil } from '@/lib/radar/contato-contabil';
import { emailSemConfirmacao, telefoneSemConfirmacao } from '@/lib/radar/telefone-cadastro';


/**
 * O alvo do cadastro pode levar o telefone ESCOLHIDO na confirmação (pacote L, item 4): `telefoneCadastro` presente
 * vale como está (`null` = não enviar telefone); ausente (lote, retentativa antiga) = `criarNoOmie` decide antes do
 * envio pela mesma regra da confirmação (`telefoneSemConfirmacao`), e o `telefone1 || telefone2` daqui só sobra para
 * quem monta o payload sem passar por ele.
 */
export type EmpresaParaCadastro = RadarEmpresa & {
  telefoneCadastro?: string | null;
  /** E-mail que vai ao ERP (revisão 2026-11-11, item 7): decidido pelo `criarNoOmie` com a leitura da contabilidade
   *  (`emailSemConfirmacao`); `null` = não enviar. Ausente no payload = não enviar. */
  emailCadastro?: string | null;
  /** A ficha do vendedor só cadastra quem está EM CONVERSA — o SERVIDOR confere (item 5); o lote não exige. */
  exigirEmConversa?: boolean;
};

/**
 * Payload da edge `omie-vendas-sync` action `criar_cliente` (conta Oben). `razaoFiscal` = a da Receita (a de MEI tem o
 * CPF, que o Radar guarda mascarado — pacote J); ausente = a razão da linha.
 */
export function montarPayloadCriarCliente(e: EmpresaParaCadastro, razaoFiscal?: string | null) {
  return {
    action: 'criar_cliente',
    account: 'oben',
    document: e.cnpj,
    razao_social: (razaoFiscal === undefined ? e.razao_social : razaoFiscal) || e.nome_fantasia || e.cnpj,
    nome_fantasia: e.nome_fantasia || undefined,
    endereco: e.logradouro || undefined,
    endereco_numero: e.numero || undefined,
    bairro: e.bairro || undefined,
    cidade: e.municipio_nome || undefined,
    estado: e.uf || undefined,
    cep: e.cep || undefined,
    telefone: e.telefoneCadastro !== undefined ? e.telefoneCadastro || undefined : e.telefone1 || e.telefone2 || undefined,
    // Item 7: a edge normaliza (≤ 60 / sintaxe e ≤ 500) e OMITE o que não serve — nunca trunca.
    complemento: e.complemento || undefined,
    email: e.emailCadastro || undefined,
    // Item 5: liga a releitura do lead NA EDGE, entre o lookup estrito e o IncluirCliente.
    radar: { exigir_em_conversa: e.exigirEmConversa === true },
  };
}

/**
 * I/O real do cadastro (edge + RPCs do Radar). A DECISÃO mora em `@/lib/radar/cadastro-omie`
 * (pura, testada): resposta sem código é INDETERMINADA e não grava no Radar; vínculo e conflitos
 * abertos são lidos JUNTOS no servidor antes de qualquer chamada (migration 20261027160000).
 * Toda resposta jsonb tem a forma CONFERIDA (`conflito-cadastro.ts`) — desvio lança.
 */
/** Contato da contabilidade para o cadastro sem confirmação. Falha de leitura = `null` (o 1º número, como antes): um
 *  campo secundário não segura o cadastro, e a tela de cadastro individual já mostra a escolha. */
async function lerContabilParaCadastro(cnpj: string): Promise<LeituraContatoContabil | null> {
  try {
    const { data, error } = await supabase.rpc('radar_contato_contabil_da_empresa', { p_cnpj: cnpj }).range(0, 2);
    if (error) throw error;
    return lerContatoContabil(data);
  } catch (err) {
    console.warn('[radar] cadastro sem confirmação: não li o contato da contabilidade; vai o 1º número', err);
    return null;
  }
}

export const depsCadastroSupabase: DepsCadastro<EmpresaParaCadastro> = {
  // invokeFunction (não `supabase.functions.invoke` cru): em HTTP 500 o `error.message` do
  // supabase-js é o genérico "non-2xx"; o motivo real (ex.: `OMIE_TRANSIENT … rate limit`,
  // que PARA o lote) vem no corpo, e só o helper o lê (P1 do review Codex).
  criarNoOmie: async (e) => {
    // A razão que a ficha mostra é a mascarada (LGPD, pacote J): a fiscal vem só desta RPC, logo antes do envio.
    const { data, error } = await supabase.rpc('radar_razao_social_para_cadastro', { p_cnpj: e.cnpj });
    const razao = escolherRazaoFiscal(e.razao_social, { data, erroCodigo: error ? (error.code ?? 'desconhecido') : null, erro: error });
    // Sem escolha na tela (lote do gestor, retentativa): não manda às cegas o telefone da contabilidade.
    const precisaTelefone = e.telefoneCadastro === undefined && Boolean(e.telefone1 || e.telefone2);
    const precisaEmail = e.emailCadastro === undefined && Boolean(e.email);
    const contabil = precisaTelefone || precisaEmail ? await lerContabilParaCadastro(e.cnpj) : null;
    const alvo: EmpresaParaCadastro = {
      ...e,
      ...(precisaTelefone ? { telefoneCadastro: telefoneSemConfirmacao(e, contabil) } : {}),
      // E-mail só com a leitura da contabilidade FEITA e negativa (parecer Codex 2026-11-12, P1): leitura que falhou
      // não vira "não é da contabilidade".
      ...(precisaEmail ? { emailCadastro: emailSemConfirmacao(e, contabil) } : {}),
    };
    return invokeFunction<unknown>('omie-vendas-sync', montarPayloadCriarCliente(alvo, razao));
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
    onSuccess: (r, v) => {
      track('radar.lead_cadastrado_omie', { ja_existia: r.jaExistia, recuperado: r.recuperado });
      // Cirúrgica (pacote N): o lead virou cliente — sai da fila no lugar (ou fica, com já-clientes), sem reler tudo.
      void invalidarRadar(qc, { cnpj: v.empresa.cnpj });
    },
    // A v2 grava o conflito e a lib LANÇA DivergenciaCadastro: sem isto a ficha e o indicador seguiriam em zero
    // com 1 conflito no servidor (Codex, código P2-2).
    onError: () => qc.invalidateQueries({ queryKey: ['radar', 'conflitos-cadastro'] }),
  });
}
