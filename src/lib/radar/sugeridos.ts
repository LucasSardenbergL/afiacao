// Qualificação em 1 clique (bloco 5 do Radar): QUEM o Radar sugere cadastrar no Omie (Oben).
// Helpers PUROS (sem I/O) — o card "Sugeridos para cadastro", o filtro "só sugeridos", o selo da
// linha e a oferta pós-sinal do menu de contato leem o MESMO predicado; o count do card
// (`useRadarSugeridos`) é a tradução dele para PostgREST e não pode divergir.
//
// Decisão de produto (brainstorm Codex, 2026-10-19): "cadastro automático" = QUALIFICAÇÃO +
// APROVAÇÃO EM 1 CLIQUE, nunca cadastrar os 500 mil no ERP. O cadastro acontece DEPOIS do sinal
// comercial (lead marcado `em_conversa`) e SÓ com clique do gestor — nada aqui dispara cadastro.
//
// Medido em prod (psql-ro, 2026-10-20, foto 2026-08 = 501.380 empresas, 498.621 ativas
// não-cliente): score ≥ 60 → 12.434 · ≥ 70 → 852 · ≥ 80 → 33. Com `em_conversa` hoje: 1 lead
// (score < 60) ⇒ 0 sugeridos em qualquer limiar — o número do card nasce honesto em zero e sobe
// à medida que o time marca conversas. 70 é o corte: 852 é um universo que cabe numa rodada
// de qualificação; 60 (12 mil) é a fila inteira de novo; 80 (33) só o topo.

/** Score mínimo para o Radar SUGERIR o cadastro. Mudar = re-medir (comentário acima) + diário. */
export const LIMIAR_SUGERIDO = 70;

/** Situação cadastral RFB "ativa". Os demais códigos (01 nula · 03 suspensa · 04 inapta · 08 baixada)
 *  bloqueiam; `null` (ainda não cruzado) NÃO bloqueia — ausente ≠ baixado. */
const RFB_ATIVA = '02';
/** O que o Omie aceita hoje: só o CNPJ numérico clássico (mesma regra de `cadastro-omie.ts`). */
const CNPJ_NUMERICO_RE = /^[0-9]{14}$/;
const STATUS_SINAL = 'em_conversa';

export interface LeadSugerivel {
  cnpj: string;
  ja_cliente: boolean;
  omie_codigo_cliente: string | null;
  prospeccao_status: string | null;
  ultimo_lote: string | null;
  rfb_situacao: string | null;
  score: number | null;
}

export type MotivoNaoCadastravel = 'ja_cliente' | 'ja_vinculado_omie' | 'rfb_nao_ativa' | 'cnpj_alfanumerico';
export type MotivoNaoSugerido = MotivoNaoCadastravel | 'sem_lote' | 'saiu_do_dump' | 'sem_sinal' | 'sem_score' | 'score_abaixo';

export type Veredito<M extends string> = { ok: true } | { ok: false; motivo: M };

/**
 * Pode ser cadastrado no Omie AGORA? (gatilho pós-sinal da ficha). Não olha score nem lote: quem
 * acabou de conversar com o gestor é lead real, independente da nota. Olha o que faria o cadastro
 * ser errado (já cliente, já vinculado) ou falhar (RFB baixada, CNPJ alfanumérico).
 */
export function cadastravelNoOmie(e: LeadSugerivel): Veredito<MotivoNaoCadastravel> {
  if (e.ja_cliente) return { ok: false, motivo: 'ja_cliente' };
  // `!= null` (não truthiness): o count em SQL usa `IS NULL` — '' precisa cair do MESMO lado nos dois.
  if (e.omie_codigo_cliente != null) return { ok: false, motivo: 'ja_vinculado_omie' };
  if (e.rfb_situacao != null && e.rfb_situacao !== RFB_ATIVA) return { ok: false, motivo: 'rfb_nao_ativa' };
  if (!CNPJ_NUMERICO_RE.test(e.cnpj)) return { ok: false, motivo: 'cnpj_alfanumerico' };
  return { ok: true };
}

export function elegivelCadastroPosSinal(e: LeadSugerivel): boolean {
  return cadastravelNoOmie(e).ok;
}

/**
 * O Radar SUGERE cadastrar? = cadastrável E na foto vigente E com sinal comercial (`em_conversa`)
 * E score ≥ `LIMIAR_SUGERIDO`. Sem lote completo ninguém é sugerido (não sei qual é a foto);
 * sem score não é "abaixo", é "sem dado".
 */
export function sugeridoParaCadastro(
  e: LeadSugerivel,
  lote: { mes_referencia: string } | null,
): Veredito<MotivoNaoSugerido> {
  const c = cadastravelNoOmie(e);
  if (!c.ok) return c;
  if (!lote) return { ok: false, motivo: 'sem_lote' };
  if (e.ultimo_lote !== lote.mes_referencia) return { ok: false, motivo: 'saiu_do_dump' };
  if (e.prospeccao_status !== STATUS_SINAL) return { ok: false, motivo: 'sem_sinal' };
  if (e.score == null || !Number.isFinite(e.score)) return { ok: false, motivo: 'sem_score' };
  if (e.score < LIMIAR_SUGERIDO) return { ok: false, motivo: 'score_abaixo' };
  return { ok: true };
}

export function ehSugerido(e: LeadSugerivel, lote: { mes_referencia: string } | null): boolean {
  return sugeridoParaCadastro(e, lote).ok;
}

export type EstadoCardSugeridos =
  | { tipo: 'sem_lote' }
  | { tipo: 'sem_score' }
  | { tipo: 'carregando' }
  | { tipo: 'pronto'; n: number };

/**
 * Estado do card "Sugeridos para cadastro". Três ausências, três telas — nenhuma vira 0:
 * sem lote completo; lote SEM nenhum score calculado (o cron das 03:30 ainda não rodou sobre
 * ele → um count de `score ≥ 70` daria 0 e fabricaria "ninguém vale a pena"); leitura ainda
 * sem resposta. Só com score calculado o zero é um zero de verdade.
 */
export function estadoCardSugeridos(v: {
  lote: { mes_referencia: string } | null;
  temScore: boolean | undefined;
  sugeridos: number | undefined;
}): EstadoCardSugeridos {
  if (!v.lote) return { tipo: 'sem_lote' };
  if (v.temScore === undefined || v.sugeridos === undefined) return { tipo: 'carregando' };
  if (!v.temScore) return { tipo: 'sem_score' };
  return { tipo: 'pronto', n: v.sugeridos };
}
