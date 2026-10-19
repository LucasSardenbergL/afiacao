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

export type EtapaCadastro = 'omie' | 'radar';

export class FalhaCadastro extends Error {
  etapa: EtapaCadastro;
  /** Código Omie já confirmado quando a falha foi na etapa 'radar' (permite retry só dela). */
  codigo: string | null;
  constructor(etapa: EtapaCadastro, mensagem: string, codigo: string | null = null) {
    super(mensagem);
    this.name = 'FalhaCadastro';
    this.etapa = etapa;
    this.codigo = codigo;
  }
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
  /** RPC `radar_registrar_cadastro_omie`. */
  registrarNoRadar: (cnpj: string, codigo: string, jaExistia: boolean) => Promise<void>;
  /** `radar_empresas.omie_codigo_cliente` do CNPJ (null se ainda não vinculado). */
  lerVinculo: (cnpj: string) => Promise<string | null>;
}

export interface OpcoesCadastro {
  /** Retry SÓ da gravação no Radar: o Omie já confirmou este código numa tentativa anterior. */
  codigoConhecido?: string;
  /** Retry de uma falha anterior na etapa omie (resposta perdida): relê o vínculo antes de gravar. */
  retentativa?: boolean;
}

export interface ResultadoCadastro {
  codigo: string;
  jaExistia: boolean;
  /** true quando a confirmação veio de uma retomada (vínculo relido ou código conhecido). */
  recuperado: boolean;
}

function mensagem(e: unknown): string {
  return e instanceof Error ? e.message : typeof e === 'string' ? e : 'erro desconhecido';
}

/**
 * Omie primeiro, Radar depois. A RPC não é idempotente de verdade (atualiza a data e
 * insere OUTRO contato a cada chamada), então toda retomada relê o vínculo antes de
 * gravar — e pula a RPC se já estiver lá.
 */
export async function cadastrarEmpresaNoOmie<E extends EmpresaCadastravel>(
  e: E,
  deps: DepsCadastro<E>,
  opcoes: OpcoesCadastro = {},
): Promise<ResultadoCadastro> {
  let codigo: string;
  let jaExistia: boolean;
  let recuperado = false;

  if (opcoes.codigoConhecido) {
    codigo = opcoes.codigoConhecido;
    jaExistia = true;
    recuperado = true;
  } else {
    let data: unknown;
    try {
      data = await deps.criarNoOmie(e);
    } catch (err) {
      throw new FalhaCadastro('omie', mensagem(err));
    }
    let validada: RespostaValidada;
    try {
      validada = validarRespostaCriarCliente(data);
    } catch (err) {
      throw new FalhaCadastro('omie', mensagem(err));
    }
    codigo = validada.codigo;
    jaExistia = validada.jaExistia;
  }

  if (opcoes.codigoConhecido || opcoes.retentativa) {
    let vinculo: string | null;
    try {
      vinculo = await deps.lerVinculo(e.cnpj);
    } catch (err) {
      throw new FalhaCadastro('radar', `não consegui reler o vínculo: ${mensagem(err)}`, codigo);
    }
    if (vinculo) return { codigo: vinculo, jaExistia: true, recuperado: true };
    recuperado = true;
  }

  try {
    await deps.registrarNoRadar(e.cnpj, codigo, jaExistia);
  } catch (err) {
    throw new FalhaCadastro('radar', mensagem(err), codigo);
  }
  return { codigo, jaExistia, recuperado };
}

/** Rate-limit persistente do Omie (a edge já fez retry com backoff): insistir só alonga o bloqueio. */
export function ehThrottlingOmie(e: unknown): boolean {
  const m = e instanceof Error ? e.message : '';
  return /OMIE_TRANSIENT|rate.?limit/i.test(m);
}
