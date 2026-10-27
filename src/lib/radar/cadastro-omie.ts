// Cadastro de UM lead do Radar no Omie (Oben): decisão pura, I/O injetado (testável sem
// React/supabase). Usado pelo botão individual e pelo lote.
//
// Contrato com a edge `omie-vendas-sync` action `criar_cliente`:
//   { success: true, created: boolean, codigo_cliente: number|string|null, ... }
//   { success: false, error: string }
// ⚠️ P0 do consult Codex (2026-10-18): após rate-limit esgotado `callOmieVendasApi` pode
// devolver null e a edge responde `success:true, created:true, codigo_cliente:null`. Isso
// NÃO é cadastro — é resultado INDETERMINADO. Só gravamos no Radar (que marca
// `ja_cliente=true` e tira o lead da fila) com `success===true`, `created` booleano e
// código não-vazio. Precisão > recall: um lead que sobra na fila custa um clique; um
// lead que sai da fila sem cliente no Omie é venda perdida sem rastro.

import { mensagemDeErro } from '@/lib/erro-mensagem';
import { ehCnpjAlfanumerico } from '@/lib/omie/cnpj-alfanumerico';
import { sqlstateDe, type ConflitoCadastro, type EstadoCadastro, type MotivoDivergencia, type ResultadoRegistroRadar } from '@/lib/radar/conflito-cadastro';

export type { MotivoDivergencia } from '@/lib/radar/conflito-cadastro';

export type EtapaCadastro = 'omie' | 'radar';

export class FalhaCadastro extends Error {
  etapa: EtapaCadastro;
  /** Código Omie já confirmado quando a falha foi na etapa 'radar' (permite retry só dela). */
  codigo: string | null;
  /**
   * Código que o Omie DEVOLVEU nesta tentativa, guardado como EVIDÊNCIA (não autoriza o atalho do `codigo`):
   * a retomada o compara com o vínculo relido — vínculo diferente é conflito, nunca "recuperado" (Codex 2026-10-21).
   */
  codigoVisto: string | null;
  constructor(etapa: EtapaCadastro, mensagem: string, codigo: string | null = null, codigoVisto: string | null = codigo) {
    super(mensagem);
    this.name = 'FalhaCadastro';
    this.etapa = etapa;
    this.codigo = codigo;
    this.codigoVisto = codigoVisto;
  }
}

/**
 * Conflito de IDENTIDADE entre o Radar e o Omie — terminal: repetir não resolve, só um humano conferindo o
 * Omie. Nunca vira sucesso (nem na retomada, que releria o vínculo antigo e o devolveria como "recuperado").
 * Motivos em `conflito-cadastro.ts`. Migrations 20261021120500 (RD001/RD002) e 20261027160000 (registro no
 * SERVIDOR: o aviso não depende mais do localStorage de uma aba).
 */
export class DivergenciaCadastro extends FalhaCadastro {
  motivo: MotivoDivergencia;
  /** Código que o Omie devolveu nesta tentativa (null quando a divergência veio antes dele). */
  codigoRecebido: string | null;
  /** Registro no servidor (null = NÃO sincronizado: o aviso só existe nesta aba — `erroRegistro` diz por quê). */
  conflito: ConflitoCadastro | null;
  /** true = barrado por um conflito JÁ registrado (não é observação nova; nada foi tentado). */
  bloqueio: boolean;
  erroRegistro: string | null;
  constructor(
    etapa: EtapaCadastro,
    motivo: MotivoDivergencia,
    mensagem: string,
    codigoRecebido: string | null,
    servidor: { conflito: ConflitoCadastro | null; bloqueio?: boolean; erroRegistro?: string | null } = { conflito: null },
  ) {
    // `codigo` (do pai) fica null de propósito: ele habilita o "Gravar de novo", que aqui recusaria em laço.
    super(etapa, mensagem, null, codigoRecebido);
    this.name = 'DivergenciaCadastro';
    this.motivo = motivo;
    this.codigoRecebido = codigoRecebido;
    this.conflito = servidor.conflito;
    this.bloqueio = servidor.bloqueio ?? false;
    this.erroRegistro = servidor.erroRegistro ?? null;
  }
}

/** Classifica a recusa da RPC pela SQLSTATE (nunca pela mensagem): RD001/RD002 são terminais. */
export function divergenciaDaRpc(e: unknown): MotivoDivergencia | null {
  const c = sqlstateDe(e);
  if (c === 'RD001') return 'vinculo_divergente';
  if (c === 'RD002') return 'codigo_de_outro_cnpj';
  return null;
}

/** Conflito de identidade que a edge acusou no lookup do Omie (marca no texto do erro), ou null. */
function divergenciaDoLookup(e: unknown): MotivoDivergencia | null {
  const m = mensagemDeErro(e) ?? '';
  if (m.includes('OMIE_LOOKUP_DIVERGENTE')) return 'lookup_divergente';
  if (m.includes('OMIE_LOOKUP_AMBIGUO')) return 'lookup_ambiguo';
  return null;
}

export interface RespostaValidada {
  codigo: string;
  jaExistia: boolean;
}

/** Valida a resposta da edge. Lança com marca `OMIE_RESPOSTA_INDETERMINADA` ou `FALHA_OMIE`. */
export function validarRespostaCriarCliente(data: unknown): RespostaValidada {
  if (!data || typeof data !== 'object') {
    throw new Error('OMIE_RESPOSTA_INDETERMINADA: a edge não devolveu um objeto');
  }
  const d = data as { success?: unknown; created?: unknown; codigo_cliente?: unknown; error?: unknown };
  if (d.success === false) {
    throw new Error(`FALHA_OMIE: ${typeof d.error === 'string' && d.error ? d.error : 'falha no cadastro Omie'}`);
  }
  if (d.success !== true || typeof d.created !== 'boolean') {
    throw new Error('OMIE_RESPOSTA_INDETERMINADA: resposta sem success/created');
  }
  const codigo =
    typeof d.codigo_cliente === 'number' && Number.isFinite(d.codigo_cliente)
      ? String(d.codigo_cliente)
      : typeof d.codigo_cliente === 'string' && d.codigo_cliente.trim() !== ''
        ? d.codigo_cliente.trim()
        : null;
  if (codigo === null) {
    throw new Error('OMIE_RESPOSTA_INDETERMINADA: o Omie não devolveu o código do cliente — não é possível confirmar o cadastro');
  }
  return { codigo, jaExistia: d.created === false };
}

export interface EmpresaCadastravel {
  cnpj: string;
  razao_social?: string | null;
}

export interface DepsCadastro<E extends EmpresaCadastravel = EmpresaCadastravel> {
  /** Chama a edge (action criar_cliente). Devolve o `data` cru da resposta. */
  criarNoOmie: (e: E) => Promise<unknown>;
  /** RPC `radar_registrar_cadastro_omie_v2` (forma conferida): RD001/RD002 voltam como `{ok:false}` JÁ registrados. */
  registrarNoRadar: (cnpj: string, codigo: string, jaExistia: boolean) => Promise<ResultadoRegistroRadar>;
  /** RPC `radar_estado_cadastro_omie`: vínculo + conflitos ABERTOS lidos juntos, sob a trava da linha. */
  lerEstado: (cnpj: string) => Promise<EstadoCadastro>;
  /** RPC `radar_registrar_conflito_cadastro`: divergência vista FORA da v2 (o servidor re-confere). */
  registrarConflito: (cnpj: string, motivo: MotivoDivergencia, codigoRecebido: string | null, detalhe: string) => Promise<ConflitoCadastro>;
}

export interface OpcoesCadastro {
  /** Retry SÓ da gravação no Radar: o Omie já confirmou este código numa tentativa anterior. */
  codigoConhecido?: string;
  /** Retry de uma falha anterior na etapa omie (resposta perdida): relê o vínculo antes de gravar. */
  retentativa?: boolean;
  /** Código que o Omie devolveu numa tentativa anterior (evidência): vínculo relido ≠ dele é conflito. */
  codigoVisto?: string;
}

export interface ResultadoCadastro {
  codigo: string;
  jaExistia: boolean;
  /** true quando a confirmação veio de uma retomada (vínculo relido ou código conhecido). */
  recuperado: boolean;
}

const mensagem = (e: unknown): string => mensagemDeErro(e) ?? 'erro desconhecido';
/** O numérico clássico passa como sempre passou (sem conferir DV aqui — o Omie confere). */
const CNPJ_NUMERICO_RE = /^[0-9]{14}$/;
/**
 * O que pode ir para o `criar_cliente`: numérico de 14 dígitos OU CNPJ alfanumérico VÁLIDO (formato RFB
 * jul/2026 + DV mod-11 sobre ASCII−48). A edge omie-vendas-sync (v1.20+, `documentoParaCadastro`) preserva as
 * letras exatamente nesse caso, e a API Omie aceita o formato no IncluirCliente desde 10/04/2026
 * (cronograma oficial, ajuda.omie.com.br/articles/13941990 — diário radar-cnpj-alfanumerico.md). Minúscula,
 * 13 posições ou DV errado: falha ALTA aqui, antes de tocar o ERP (precisão > recall).
 */
export function documentoCadastravelNoOmie(cnpj: string): boolean {
  return CNPJ_NUMERICO_RE.test(cnpj) || ehCnpjAlfanumerico(cnpj);
}

/**
 * Omie primeiro, Radar depois. A RPC é idempotente pelo vínculo (igual = no-op; diferente = conflito) e é a
 * trava partilhada por lote e ficha (FOR UPDATE na linha do CNPJ — migration 20261021120500).
 * ANTES de tudo, em TODO caminho, lê vínculo + conflitos abertos JUNTOS no servidor (migration 20261027160000):
 * conflito aberto barra o CNPJ até um humano conferir (sem tocar o Omie e sem contar ocorrência nova), e leitura
 * que falha BLOQUEIA — nunca significa "zero conflitos". A retomada decide "recuperado" por essa mesma leitura;
 * com código conhecido, um vínculo DIFERENTE é conflito, registrado no servidor.
 */
export async function cadastrarEmpresaNoOmie<E extends EmpresaCadastravel>(
  e: E,
  deps: DepsCadastro<E>,
  opcoes: OpcoesCadastro = {},
): Promise<ResultadoCadastro> {
  // Só o que a edge sabe preservar e o Omie sabe receber chega ao ERP (ver documentoCadastravelNoOmie):
  // um documento com letra que NÃO é CNPJ alfanumérico válido viraria, depois do `\D`, o CPF de OUTRA
  // pessoa — bloqueio explícito e barulhento aqui, antes de tocar o Omie (parecer Codex 2026-10-19).
  if (!documentoCadastravelNoOmie(e.cnpj)) {
    throw new FalhaCadastro('omie', 'CNPJ inválido para cadastro no Omie: só numérico de 14 dígitos ou alfanumérico RFB (maiúsculo, DV conferido)');
  }
  const retomada = Boolean(opcoes.codigoConhecido || opcoes.retentativa);

  let estado: EstadoCadastro;
  try {
    estado = await deps.lerEstado(e.cnpj);
  } catch (err) {
    throw new FalhaCadastro(
      opcoes.codigoConhecido ? 'radar' : 'omie',
      `não consegui ler o vínculo e os conflitos no Radar — nada foi feito: ${mensagem(err)}`,
      opcoes.codigoConhecido ?? null,
      opcoes.codigoConhecido ?? opcoes.codigoVisto ?? null,
    );
  }
  const aberto = estado.conflitos[0];
  if (aberto) throw bloqueioPorConflito(e.cnpj, aberto);

  if (retomada && estado.vinculo) {
    const conhecido = (opcoes.codigoConhecido ?? opcoes.codigoVisto)?.trim();
    if (conhecido && estado.vinculo !== conhecido) {
      throw await divergenciaObservada(
        deps, e.cnpj, 'radar', 'vinculo_divergente',
        `RADAR_VINCULO_DIVERGENTE: CNPJ ${e.cnpj} já vinculado ao cliente Omie ${estado.vinculo}, o Omie confirmou ${conhecido}`,
        conhecido,
      );
    }
    return { codigo: estado.vinculo, jaExistia: true, recuperado: true };
  }

  let codigo: string;
  let jaExistia: boolean;
  if (opcoes.codigoConhecido) {
    codigo = opcoes.codigoConhecido;
    jaExistia = true;
  } else {
    let data: unknown;
    try {
      data = await deps.criarNoOmie(e);
    } catch (err) {
      throw await falhaNoOmie(deps, e.cnpj, err);
    }
    let validada: RespostaValidada;
    try {
      validada = validarRespostaCriarCliente(data);
    } catch (err) {
      throw await falhaNoOmie(deps, e.cnpj, err);
    }
    codigo = validada.codigo;
    jaExistia = validada.jaExistia;
  }

  let registro: ResultadoRegistroRadar;
  try {
    registro = await deps.registrarNoRadar(e.cnpj, codigo, jaExistia);
  } catch (err) {
    // A RPC exige a confirmação que a EDGE gravou (ledger `omie_cliente_confirmacoes`) — sem ela, repetir só a
    // gravação (`codigoConhecido`) recusaria de novo, em laço. Vira falha na etapa omie SEM código: o "Tentar de
    // novo" volta pela edge, cujo lookup confere o documento e grava a confirmação (migration 20261021120000).
    if (ehSemConfirmacaoDoServidor(err)) throw new FalhaCadastro('omie', mensagem(err), null, codigo);
    // A v2 devolve RD001/RD002 como resultado; um RD cru aqui (ex.: v1 respondendo) ainda é conflito — registrado à parte.
    const motivo = divergenciaDaRpc(err);
    if (motivo) throw await divergenciaObservada(deps, e.cnpj, 'radar', motivo, mensagem(err), codigo);
    throw new FalhaCadastro('radar', mensagem(err), codigo);
  }
  if (!registro.ok) {
    const c = registro.conflito;
    if (registro.bloqueado) throw bloqueioPorConflito(e.cnpj, c);
    throw new DivergenciaCadastro('radar', c.motivo, c.detalhe, codigo, { conflito: c });
  }
  return { codigo, jaExistia, recuperado: retomada };
}

/** Conflito JÁ registrado barra o CNPJ: não é observação nova (nada é registrado de novo). */
function bloqueioPorConflito(cnpj: string, c: ConflitoCadastro): DivergenciaCadastro {
  return new DivergenciaCadastro(
    'radar',
    c.motivo,
    `RADAR_CONFLITO_ABERTO: CNPJ ${cnpj} tem conflito com o Omie aberto desde ${c.ultimaEm} — confira no Omie e marque como conferido na ficha`,
    c.codigoRecebido,
    { conflito: c, bloqueio: true },
  );
}

/**
 * Divergência vista FORA da v2 (retomada, lookup da edge, RD cru): registra no servidor e devolve o conflito para
 * lançar. Se o registro falhar, o aviso continua — local, marcado como NÃO sincronizado (nunca vira sucesso).
 */
async function divergenciaObservada(
  deps: Pick<DepsCadastro, 'registrarConflito'>,
  cnpj: string,
  etapa: EtapaCadastro,
  motivo: MotivoDivergencia,
  msg: string,
  codigoRecebido: string | null,
): Promise<DivergenciaCadastro> {
  try {
    const conflito = await deps.registrarConflito(cnpj, motivo, codigoRecebido, msg);
    return new DivergenciaCadastro(etapa, motivo, msg, codigoRecebido, { conflito });
  } catch (err) {
    return new DivergenciaCadastro(etapa, motivo, msg, codigoRecebido, { conflito: null, erroRegistro: mensagem(err) });
  }
}

/** Falha na etapa omie; o lookup com OUTRO documento ou com 2+ códigos é conflito terminal (registrado), não falha retentável. */
async function falhaNoOmie(deps: Pick<DepsCadastro, 'registrarConflito'>, cnpj: string, err: unknown): Promise<FalhaCadastro> {
  const motivo = divergenciaDoLookup(err);
  return motivo ? divergenciaObservada(deps, cnpj, 'omie', motivo, mensagem(err), null) : new FalhaCadastro('omie', mensagem(err));
}

/** Marca da RPC `radar_registrar_cadastro_omie` quando o servidor não confirmou o par CNPJ↔código no Omie/Oben. */
export function ehSemConfirmacaoDoServidor(e: unknown): boolean {
  return (mensagemDeErro(e) ?? '').startsWith('RADAR_SEM_CONFIRMACAO_OMIE:');
}

/** Rate-limit persistente do Omie (a edge já fez retry com backoff): insistir só alonga o bloqueio. */
export function ehThrottlingOmie(e: unknown): boolean {
  const m = mensagemDeErro(e) ?? '';
  return /OMIE_TRANSIENT|rate.?limit/i.test(m);
}
