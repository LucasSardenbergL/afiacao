/**
 * Situação cadastral da Receita (RFB) de um cliente — fora do Radar (Frente 5).
 *
 * Fonte: RPC `cliente_situacao_receita(p_customer_user_id)` (20261029200343), SECURITY DEFINER no
 * escopo de carteira (cap_carteira_ler OR carteira_visivel_para). A tabela `radar_situacao_cadastral`
 * segue com RLS de gestor; o vendedor só chega ao dado por aqui.
 *
 * Money-path (precisão > recall; ausente ≠ ativa):
 *  - só `irregular` (03 suspensa · 04 inapta · 08 baixada) vira selo — nunca existe selo "ok";
 *  - irregular de lote velho é "último registro", não "situação atual" (`confirmado_no_vigente`);
 *  - recusa de escopo só é reconhecida pelo discriminador `42501` + HINT `fora_da_carteira`;
 *    qualquer outro erro (inclusive 42501 sem o HINT) é ERRO, e a superfície diz "indisponível";
 *  - resposta fora do contrato (0 ou 2+ linhas, estado desconhecido) é erro, nunca "sem dado".
 * Módulo de PLATAFORMA: a ficha (farmer-inteligencia) e o pedido (vendas) consomem o mesmo contrato.
 */

const ESTADOS_SITUACAO_RECEITA = [
  'irregular',
  'ativa',
  'outra',
  'sem_dado',
  'sem_cnpj',
  'sem_documento',
] as const;
type EstadoSituacaoReceita = (typeof ESTADOS_SITUACAO_RECEITA)[number];

export interface SituacaoReceita {
  estado: EstadoSituacaoReceita;
  cnpj: string | null;
  situacao: string | null;
  dataSituacao: string | null;
  motivoDescricao: string | null;
  lote: string | null;
  loteVigente: string | null;
  confirmadoNoVigente: boolean;
}

export type LeituraSituacaoReceita =
  | { tipo: 'ok'; dado: SituacaoReceita }
  | { tipo: 'sem_acesso' };

/** Erro de leitura que a superfície mostra como "indisponível" (não é recusa de escopo). */
export class ErroSituacaoReceita extends Error {
  constructor(public readonly motivo: 'fonte' | 'contrato', mensagem: string) {
    super(mensagem);
    this.name = 'ErroSituacaoReceita';
  }
}

interface ErroPostgrest {
  code?: string | null;
  hint?: string | null;
  message?: string | null;
}

function textoOuNulo(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

/**
 * Interpreta a resposta crua do `supabase.rpc`. Devolve `ok`/`sem_acesso`; LANÇA
 * `ErroSituacaoReceita` para erro de fonte ou de contrato (o react-query faz o retry e a
 * superfície mostra "indisponível").
 */
export function interpretarRespostaSituacao(data: unknown, error: ErroPostgrest | null): LeituraSituacaoReceita {
  if (error) {
    if (error.code === '42501' && error.hint === 'fora_da_carteira') return { tipo: 'sem_acesso' };
    throw new ErroSituacaoReceita('fonte', `${error.code ?? 'sem-codigo'}: ${error.message ?? 'erro'}`);
  }
  if (!Array.isArray(data) || data.length !== 1) {
    const n = Array.isArray(data) ? data.length : 'não-lista';
    throw new ErroSituacaoReceita('contrato', `esperava 1 linha, veio ${n}`);
  }
  const r = data[0] as Record<string, unknown>;
  const estado = r.estado;
  if (typeof estado !== 'string' || !(ESTADOS_SITUACAO_RECEITA as readonly string[]).includes(estado)) {
    throw new ErroSituacaoReceita('contrato', `estado desconhecido: ${String(estado)}`);
  }
  if (estado === 'irregular' && (textoOuNulo(r.situacao) === null || textoOuNulo(r.lote) === null)) {
    throw new ErroSituacaoReceita('contrato', 'irregular sem situação ou lote');
  }
  return {
    tipo: 'ok',
    dado: {
      estado: estado as EstadoSituacaoReceita,
      cnpj: textoOuNulo(r.cnpj),
      situacao: textoOuNulo(r.situacao),
      dataSituacao: textoOuNulo(r.data_situacao),
      motivoDescricao: textoOuNulo(r.motivo_descricao),
      lote: textoOuNulo(r.lote),
      loteVigente: textoOuNulo(r.lote_vigente),
      confirmadoNoVigente: r.confirmado_no_vigente === true,
    },
  };
}

const ROTULO_IRREGULAR: Record<string, string> = { '03': 'suspenso', '04': 'inapto', '08': 'baixado' };

/** 'YYYY-MM-DD' → 'dd/mm/aaaa' sem `Date` (fuso não entra). Fora do formato → null. */
export function formatarDataIsoBr(iso: string | null): string | null {
  const m = iso ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso) : null;
  return m ? `${m[3]}/${m[2]}/${m[1]}` : null;
}

export interface SeloReceita {
  titulo: string;
  detalhe: string;
  confirmado: boolean;
}

/** Texto do selo — só para `irregular`; qualquer outro estado não tem selo (nunca selo verde). */
export function seloReceita(d: SituacaoReceita): SeloReceita | null {
  if (d.estado !== 'irregular' || !d.situacao) return null;
  const rotulo = ROTULO_IRREGULAR[d.situacao];
  if (!rotulo) return null;
  const desde = formatarDataIsoBr(d.dataSituacao);
  if (d.confirmadoNoVigente) {
    return {
      titulo: `CNPJ ${rotulo} na Receita`,
      detalhe: `${desde ? `desde ${desde} · ` : ''}base RFB ${d.lote}`,
      confirmado: true,
    };
  }
  return {
    titulo: `Último registro na Receita: CNPJ ${rotulo}`,
    detalhe: `${desde ? `desde ${desde} · ` : ''}base RFB ${d.lote} — sem confirmação no lote ${d.loteVigente ?? 'mais recente'}`,
    confirmado: false,
  };
}
