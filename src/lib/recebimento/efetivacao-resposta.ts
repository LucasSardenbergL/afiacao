/**
 * Veredito da chamada à edge `omie-nfe-recebimento` (efetivação da NF-e de entrada no Omie).
 *
 * Money-path: a edge EFETIVA a NF-e no ERP (entrada de estoque + lançamento fiscal; desfazer é
 * trabalho manual do escritório contábil). O front comemorava "efetivada" quando a edge respondia
 * HTTP 200 com `success:false` — decidia pelo TRANSPORTE (`res.error`) e nunca lia o corpo (M-01).
 *
 * Regra: só `success === true` com `modo` da allowlist é sucesso; qualquer ausência de sinal é
 * FALHA (precisão > recall — melhor mandar o operador conferir no Omie do que afirmar uma entrada
 * de estoque que não aconteceu). Desde o M-01 a edge também responde ≠2xx na falha; aí o
 * supabase-js devolve `FunctionsHttpError` com o corpo AINDA POR LER em `error.context`
 * (Response) — lemos para não trocar o `erro` da edge pela frase genérica do transporte.
 */
import { mensagemDeErro } from '@/lib/erro-mensagem';

export type VereditoEfetivacao =
  | { tipo: 'sucesso'; modo: 'efetivado' | 'reconciliado' }
  | { tipo: 'parcial'; modo: 'efetivacao_parcial'; mensagem: string }
  | { tipo: 'falha'; modo: string | null; mensagem: string };

/** O par `{ data, error }` que `supabase.functions.invoke` resolve. */
export interface RespostaInvoke {
  data: unknown;
  error: unknown;
}

/** Modos em que a edge afirma, com `success:true`, que a NF-e está recebida no Omie. */
const MODOS_SUCESSO: ReadonlySet<string> = new Set(['efetivado', 'reconciliado']);
const MODO_PARCIAL = 'efetivacao_parcial';
const MSG_PARCIAL_FALLBACK = 'verifique a NF-e no Omie e use Reprocessar';
const MSG_TRANSPORTE_FALLBACK = 'a edge não respondeu — tente de novo ou avise a equipe';

function comoRegistro(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function texto(v: unknown): string | null {
  return typeof v === 'string' && v.trim().length > 0 ? v : null;
}

/** Teto para ler o corpo do ≠2xx: um stream que nunca fecha não pode segurar o toast (Codex P2). */
const TIMEOUT_LEITURA_MS = 5_000;

/**
 * Corpo JSON que o supabase-js guarda em `error.context` (uma `Response` ainda não lida).
 * `null` quando não há context, o corpo não é JSON/objeto ou a leitura passa do teto — nunca lança.
 */
async function corpoDoErro(error: unknown): Promise<Record<string, unknown> | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const ctx = comoRegistro(error)?.context as { json?: unknown; clone?: unknown } | undefined;
    if (!ctx || typeof ctx.json !== 'function') return null;
    const r = ctx as Response;
    const alvo = typeof r.clone === 'function' ? r.clone() : r;
    const teto = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), TIMEOUT_LEITURA_MS);
    });
    return comoRegistro(await Promise.race([alvo.json(), teto]));
  } catch {
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** `divergencias: string[]` do retorno final da edge (parcial/falha pós-reconsulta) vira texto. */
function textoDeLista(v: unknown): string | null {
  if (!Array.isArray(v)) return null;
  const partes = v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0);
  return partes.length > 0 ? partes.join(' | ') : null;
}

function vereditoDoCorpo(corpo: Record<string, unknown>, transporteFalhou: boolean): VereditoEfetivacao {
  const modo = texto(corpo.modo);
  // `erro` é o campo do fluxo real; `error` é o dos 4xx/5xx genéricos (lock, auth, interno);
  // `divergencias` é o diagnóstico do retorno FINAL (reconsulta), que não traz `erro` (Codex P2).
  const erro = texto(corpo.erro) ?? texto(corpo.error) ?? textoDeLista(corpo.divergencias);
  if (modo === MODO_PARCIAL) {
    return { tipo: 'parcial', modo: MODO_PARCIAL, mensagem: erro ?? MSG_PARCIAL_FALLBACK };
  }
  // O sucesso exige as três coisas: transporte 2xx, `success` boolean true E modo conhecido.
  // Um corpo `success:true` dentro de um ≠2xx é contradição — fica do lado seguro (falha).
  if (!transporteFalhou && corpo.success === true && modo !== null && MODOS_SUCESSO.has(modo)) {
    return { tipo: 'sucesso', modo: modo as 'efetivado' | 'reconciliado' };
  }
  return { tipo: 'falha', modo, mensagem: erro ?? `não efetivada (modo: ${modo ?? 'desconhecido'})` };
}

/** Interpreta `{ data, error }` do `invoke('omie-nfe-recebimento')`. Nunca lança. */
export async function interpretarRespostaEfetivacao(res: RespostaInvoke): Promise<VereditoEfetivacao> {
  if (res.error) {
    const corpo = await corpoDoErro(res.error);
    if (corpo) return vereditoDoCorpo(corpo, true);
    return { tipo: 'falha', modo: null, mensagem: mensagemDeErro(res.error) ?? MSG_TRANSPORTE_FALLBACK };
  }
  const corpo = comoRegistro(res.data);
  if (!corpo) return { tipo: 'falha', modo: null, mensagem: 'resposta inesperada da edge (sem corpo JSON)' };
  return vereditoDoCorpo(corpo, false);
}
