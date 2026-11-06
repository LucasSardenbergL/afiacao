/**
 * Aviso de crédito por VÍNCULO: o cliente do pedido (ou o lead da ficha do Radar) tem selo de possível vínculo /
 * sucessor de um cliente nosso com título VENCIDO em aberto (RPC `credito_vinculo_aviso`, migration 20261106205557;
 * passo 2 do "Radar sucessor", decisão do founder em 2026-11-06).
 *
 * É SÓ AVISO — não bloqueia pedido, não cria exceção, não mexe em prazo. Pista, nunca veredito: a frase manda
 * conferir. Money-path (precisão > recall, ausente ≠ zero):
 *   · resposta fora da forma LANÇA (a tela diz "não consegui verificar", nunca "sem pendência");
 *   · 'fora_da_base' e vínculo INDETERMINADO viram nota neutra "não verificado" — nunca silêncio que pareça "em dia";
 *   · silêncio só quando a avaliação foi completa e não achou evidência positiva.
 */

type SinalVinculo = 'telefone' | 'email' | 'endereco' | 'pessoa';
export type ForcaVinculo = 'forte' | 'media';
type QualidadeSync = 'ok' | 'defasado' | 'sem_sync';
export type ContaCredora = 'oben' | 'colacor' | 'colacor_sc';
export type SuperficieAviso = 'pedido' | 'ficha_radar';
export type VereditoConferencia = 'mesmo_grupo' | 'sem_relacao' | 'nao_confirmei';

interface CredoraVencida {
  company: ContaCredora;
  vencido: number;
  nTitulos: number;
  diasVencidoMax: number | null;
  syncEm: string | null;
  qualidade: QualidadeSync;
  nAmbiguos: number;
  nInvalidos: number;
}

export interface VinculoComVencido {
  /** Referência OPACA e estável do par (sujeito, vinculado) — o que o sensor manda de volta, nunca o CNPJ. */
  ref: string;
  /** null = cliente só no cadastro, oculto para quem não lê a carteira (projeção da ficha). */
  clienteCnpj: string | null;
  clienteNome: string | null;
  clienteSituacao: string | null;
  forca: ForcaVinculo;
  sinais: SinalVinculo[];
  /** Parte das contas do vinculado não pôde ser avaliada: o vencido mostrado é piso, não total. */
  parcial: boolean;
  credoras: CredoraVencida[];
}

export type AvisoVinculo =
  | { estado: 'fora_da_base' }
  | { estado: 'avaliado'; nVinculos: number; nIndeterminados: number; vinculos: VinculoComVencido[] };

const SINAIS: readonly SinalVinculo[] = ['telefone', 'email', 'endereco', 'pessoa'];
const FORCAS: readonly ForcaVinculo[] = ['forte', 'media'];
const QUALIDADES: readonly QualidadeSync[] = ['ok', 'defasado', 'sem_sync'];
const CONTAS: readonly ContaCredora[] = ['oben', 'colacor', 'colacor_sc'];

const ERRO_FORMA = 'credito_vinculo_aviso: resposta fora da forma esperada';

function inteiroNaoNegativo(v: unknown): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  if (!Number.isInteger(n) || n < 0) throw new Error(ERRO_FORMA);
  return n;
}

function textoOuNulo(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'string') throw new Error(ERRO_FORMA);
  return v;
}

function refOpaca(v: unknown): string {
  if (typeof v !== 'string' || !/^[0-9a-f]{16}$/.test(v)) throw new Error(ERRO_FORMA);
  return v;
}

function lerCredora(c: unknown): CredoraVencida {
  const r = c as Record<string, unknown> | null;
  if (!r || !CONTAS.includes(r.company as ContaCredora) || !QUALIDADES.includes(r.qualidade as QualidadeSync)) {
    throw new Error(ERRO_FORMA);
  }
  const vencido = typeof r.vencido === 'number' ? r.vencido : Number(r.vencido);
  // Só credora com vencido POSITIVO e finito chega aqui: o servidor filtra; se não, é forma errada (nunca 0 fabricado).
  if (!Number.isFinite(vencido) || vencido <= 0) throw new Error(ERRO_FORMA);
  return {
    company: r.company as ContaCredora,
    vencido,
    nTitulos: inteiroNaoNegativo(r.n_titulos),
    diasVencidoMax: r.dias_vencido_max === null || r.dias_vencido_max === undefined ? null : inteiroNaoNegativo(r.dias_vencido_max),
    syncEm: textoOuNulo(r.sync_em),
    qualidade: r.qualidade as QualidadeSync,
    nAmbiguos: inteiroNaoNegativo(r.n_ambiguos ?? 0),
    nInvalidos: inteiroNaoNegativo(r.n_invalidos ?? 0),
  };
}

function lerVinculoComVencido(l: unknown): VinculoComVencido {
  const r = l as Record<string, unknown> | null;
  const sinais = r?.sinais;
  const credoras = r?.credoras;
  if (
    !r ||
    !FORCAS.includes(r.forca as ForcaVinculo) ||
    !Array.isArray(sinais) || sinais.length === 0 || !sinais.every((s) => SINAIS.includes(s as SinalVinculo)) ||
    !Array.isArray(credoras) || credoras.length === 0 ||
    typeof r.parcial !== 'boolean'
  ) {
    throw new Error(ERRO_FORMA);
  }
  return {
    ref: refOpaca(r.ref),
    clienteCnpj: textoOuNulo(r.cliente_cnpj),
    clienteNome: textoOuNulo(r.cliente_nome),
    clienteSituacao: textoOuNulo(r.cliente_situacao),
    forca: r.forca as ForcaVinculo,
    sinais: sinais as SinalVinculo[],
    parcial: r.parcial,
    credoras: credoras.map(lerCredora),
  };
}

/** Valida a resposta crua da RPC. Forma inesperada LANÇA: ausente ≠ "sem pendência". */
export function lerAvisoVinculo(j: unknown): AvisoVinculo {
  const r = j as Record<string, unknown> | null;
  if (!r || typeof r !== 'object') throw new Error(ERRO_FORMA);
  if (r.estado === 'fora_da_base') return { estado: 'fora_da_base' };
  if (r.estado !== 'avaliado' || !Array.isArray(r.vinculos)) throw new Error(ERRO_FORMA);
  const nVinculos = inteiroNaoNegativo(r.n_vinculos);
  const nIndeterminados = inteiroNaoNegativo(r.n_indeterminados);
  const vinculos = r.vinculos.map(lerVinculoComVencido);
  if (nIndeterminados + vinculos.length > nVinculos) throw new Error(ERRO_FORMA);
  return { estado: 'avaliado', nVinculos, nIndeterminados, vinculos };
}

/** CNPJ (14, alfanumérico RFB) do documento do cliente; CPF ou lixo → null (o aviso não avalia CPF). */
export function cnpjDoDocumento(doc: string | null | undefined): string | null {
  if (!doc) return null;
  const limpo = doc.toUpperCase().replace(/[^0-9A-Z]/g, '');
  return /^[0-9A-Z]{12}[0-9]{2}$/.test(limpo) ? limpo : null;
}

/** O que a tela mostra. Nunca há um estado "sem pendência". */
export type ExibicaoAviso =
  | { tipo: 'nada' }                                   // carregando, ou avaliação completa sem evidência positiva
  | { tipo: 'nao_consegui' }                           // a leitura falhou / sem rede
  | { tipo: 'nao_verificado'; motivo: 'fora_da_base' | 'cpf' | 'indeterminado'; n?: number }
  | { tipo: 'aviso'; vinculos: VinculoComVencido[]; nIndeterminados: number };

export function exibicaoDoAviso(args: {
  cnpj: string | null;
  carregando: boolean;
  falhou: boolean;
  aviso: AvisoVinculo | null | undefined;
}): ExibicaoAviso {
  if (!args.cnpj) return { tipo: 'nao_verificado', motivo: 'cpf' };
  if (args.falhou) return { tipo: 'nao_consegui' };
  if (args.carregando || !args.aviso) return { tipo: 'nada' };
  if (args.aviso.estado === 'fora_da_base') return { tipo: 'nao_verificado', motivo: 'fora_da_base' };
  if (args.aviso.vinculos.length > 0) {
    return { tipo: 'aviso', vinculos: args.aviso.vinculos, nIndeterminados: args.aviso.nIndeterminados };
  }
  if (args.aviso.nIndeterminados > 0) return { tipo: 'nao_verificado', motivo: 'indeterminado', n: args.aviso.nIndeterminados };
  return { tipo: 'nada' };
}

// ── Textos ───────────────────────────────────────────────────────────────────────────────────────────────────────
// Espelham os da ficha (src/lib/radar/vinculos.ts — outro módulo, gate de fronteiras): só rótulos, nenhuma regra.

const TEXTO_SINAL: Record<SinalVinculo, string> = {
  telefone: 'mesmo telefone',
  email: 'mesmo e-mail',
  endereco: 'mesmo endereço completo',
  pessoa: 'mesmo sócio ou titular, no mesmo município',
};
const FORA_DE_OPERACAO: Record<string, string> = { '01': 'nula', '03': 'suspensa', '04': 'inapta', '08': 'baixada' };
export const ROTULO_CONTA: Record<ContaCredora, string> = { oben: 'Oben', colacor: 'Colacor', colacor_sc: 'Colacor SC' };

export const FRASE_AVISO = 'Possível vínculo com cliente que possui títulos vencidos; requer conferência.';

export function evidencia(v: Pick<VinculoComVencido, 'sinais'>): string {
  return v.sinais.map((s) => TEXTO_SINAL[s]).join(' · ');
}

export function rotuloForca(f: ForcaVinculo): string {
  return f === 'forte' ? 'pista forte' : 'pista média';
}

/** "C1 LTDA (baixada na Receita)" · oculto → "um cliente da carteira — confira com a gestão". */
export function nomeVinculado(v: Pick<VinculoComVencido, 'clienteNome' | 'clienteCnpj' | 'clienteSituacao'>): string {
  if (!v.clienteNome && !v.clienteCnpj) return 'um cliente da carteira — confira com a gestão';
  const nome = v.clienteNome ?? v.clienteCnpj ?? '';
  const fora = v.clienteSituacao ? FORA_DE_OPERACAO[v.clienteSituacao] : undefined;
  return fora ? `${nome} (${fora} na Receita)` : nome;
}

export function textoNaoVerificado(motivo: 'fora_da_base' | 'cpf' | 'indeterminado', n?: number): string {
  if (motivo === 'cpf') return 'Vínculo com devedor não verificado (só CNPJ é avaliado).';
  if (motivo === 'fora_da_base') return 'Vínculo com devedor não verificado (CNPJ fora da base da Receita).';
  const k = n ?? 1;
  return `Vínculo com devedor não verificado: ${k} ${k > 1 ? 'possíveis vínculos' : 'possível vínculo'} sem código Omie com prova ou com títulos incompletos.`;
}
