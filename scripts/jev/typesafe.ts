/**
 * typesafe.ts — cliente MÍNIMO do Jev (TypeSafe AI) por `fetch` puro, sem SDK npm.
 *
 * Contrato lido na doc OFICIAL em 2026-09-27 (docs.typesafe.ai/api, /models, /confidence) — nunca
 * de domínio parasita. Chave SÓ do console.typesafe.ai, lida de `TYPESAFE_API_KEY` pelo chamador;
 * este módulo nunca a imprime nem a devolve em mensagem de erro.
 *
 * Portável de propósito (só `fetch`/`AbortController`/`Headers`): o PR1 o espelha em
 * `supabase/functions/_shared/typesafe.ts` (Deno).
 */

export const ENDPOINT_TYPESAFE = 'https://api.typesafe.ai/v1/systemone';

/** Pinado: o alias `jev-latest` pode andar e mudar as respostas sob o limiar calibrado. */
export const MODELO_PINADO = 'jev-1.13.0';

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

export interface PerguntaChoice {
  instructions: Json;
  /** Opções em ORDEM: [chave, descrição]. A ordem importa (o backtest mede sensibilidade a ela). */
  criteria: ReadonlyArray<readonly [string, Json]>;
}

/**
 * Serializa o corpo À MÃO para preservar a ordem das opções: um objeto JS reordenaria chaves
 * "inteiras" ("2" antes de "10") e o teste de ordem mediria a ordem do motor JS, não a nossa.
 */
export function montarCorpo(state: unknown, pergunta: PerguntaChoice, modelo: string): string {
  const vistas = new Set<string>();
  const pares = pergunta.criteria.map(([chave, desc]) => {
    if (vistas.has(chave)) throw new Error(`opção duplicada: ${JSON.stringify(chave)}`);
    vistas.add(chave);
    return `${JSON.stringify(chave)}:${JSON.stringify(desc)}`;
  });
  const q = `{"type":"choice","instructions":${JSON.stringify(pergunta.instructions)},"criteria":{${pares.join(',')}}}`;
  return `{"state":${JSON.stringify(state)},"model":${JSON.stringify(modelo)},"questions":{"q":${q}}}`;
}

export type ResultadoChoice =
  | {
      ok: true;
      escolha: string;
      /** probabilities[escolha] — a probabilidade calibrada da própria escolha. */
      prob: number;
      probabilidades: Record<string, number>;
      /** Estatística de formato da distribuição (NÃO é probabilidade de acerto). */
      confidence: number;
      tokensEntrada: number;
      modelo: string;
      tentativas: number;
      /** Da última tentativa (a que respondeu). */
      latenciaMs: number;
      /** Relógio de parede de todas as tentativas + esperas de backoff. */
      latenciaTotalMs: number;
    }
  | { ok: false; erro: string; status: number | null; tentativas: number; latenciaTotalMs: number };

export interface OpcoesChamada {
  chave: string;
  state: unknown;
  pergunta: PerguntaChoice;
  modelo?: string;
  fetchImpl?: typeof fetch;
  dormir?: (ms: number) => Promise<void>;
  agora?: () => number;
  timeoutMs?: number;
  maxTentativas?: number;
}

const TRANSITORIOS = new Set([429, 529, 500, 502, 503, 504]);
const TOLERANCIA_SOMA = 0.01;

function validar(corpo: unknown, opcoes: readonly string[]):
  | { ok: true; escolha: string; probabilidades: Record<string, number>; confidence: number; tokensEntrada: number; modelo: string }
  | { ok: false; motivo: string } {
  const c = corpo as {
    model?: unknown;
    answers?: { q?: { type?: unknown; choice?: unknown; probabilities?: unknown; confidence?: unknown } };
    usage?: { input_tokens?: unknown };
  };
  const a = c?.answers?.q;
  if (!a || a.type !== 'choice') return { ok: false, motivo: 'sem answers.q do tipo choice' };
  if (typeof a.choice !== 'string' || !opcoes.includes(a.choice)) return { ok: false, motivo: 'choice fora das opções pedidas' };
  if (!a.probabilities || typeof a.probabilities !== 'object') return { ok: false, motivo: 'sem probabilities' };
  const probs = a.probabilities as Record<string, unknown>;
  const probabilidades: Record<string, number> = {};
  let soma = 0;
  for (const o of opcoes) {
    const v = probs[o];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) {
      return { ok: false, motivo: `probabilidade ausente/ inválida para ${JSON.stringify(o)}` };
    }
    probabilidades[o] = v;
    soma += v;
  }
  if (Object.keys(probs).length !== opcoes.length) return { ok: false, motivo: 'probabilities com opções a mais' };
  if (Math.abs(soma - 1) > TOLERANCIA_SOMA) return { ok: false, motivo: `probabilities somam ${soma.toFixed(4)}` };
  if (typeof a.confidence !== 'number' || !Number.isFinite(a.confidence) || a.confidence < 0 || a.confidence > 1) {
    return { ok: false, motivo: 'confidence ausente/inválida' };
  }
  const tokens = c.usage?.input_tokens;
  if (typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens < 0) return { ok: false, motivo: 'usage.input_tokens ausente' };
  if (typeof c.model !== 'string') return { ok: false, motivo: 'model ausente' };
  return { ok: true, escolha: a.choice, probabilidades, confidence: a.confidence, tokensEntrada: tokens, modelo: c.model };
}

function esperaBackoff(tentativa: number, retryAfter: string | null): number {
  const s = retryAfter !== null ? Number(retryAfter) : NaN;
  if (Number.isFinite(s) && s >= 0) return Math.min(60_000, s * 1000);
  return Math.min(30_000, 1000 * 2 ** (tentativa - 1));
}

/** Uma pergunta Choice. Retry só no transitório (429/529/5xx/rede); 401/422 falham na hora. */
export async function perguntarChoice(o: OpcoesChamada): Promise<ResultadoChoice> {
  const fetchImpl = o.fetchImpl ?? fetch;
  const dormir = o.dormir ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const agora = o.agora ?? (() => performance.now());
  const maxTentativas = o.maxTentativas ?? 5;
  const timeoutMs = o.timeoutMs ?? 20_000;
  const corpo = montarCorpo(o.state, o.pergunta, o.modelo ?? MODELO_PINADO);
  const opcoes = o.pergunta.criteria.map(([k]) => k);

  const inicio = agora();
  let ultimoErro = 'nenhuma tentativa';
  let ultimoStatus: number | null = null;
  let feitas = 0;
  for (let tentativa = 1; tentativa <= maxTentativas; tentativa++) {
    feitas = tentativa;
    const t0 = agora();
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    let resp: Response;
    try {
      resp = await fetchImpl(ENDPOINT_TYPESAFE, {
        method: 'POST',
        headers: { Authorization: `Bearer ${o.chave}`, 'Content-Type': 'application/json' },
        body: corpo,
        signal: ctl.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      ultimoErro = `rede: ${e instanceof Error ? e.name : 'erro'}`;
      ultimoStatus = null;
      if (tentativa < maxTentativas) await dormir(esperaBackoff(tentativa, null));
      continue;
    }
    let texto: string;
    try {
      texto = await resp.text();
    } catch (e) {
      clearTimeout(timer);
      ultimoErro = `rede ao ler corpo: ${e instanceof Error ? e.name : 'erro'}`;
      ultimoStatus = resp.status;
      if (tentativa < maxTentativas) await dormir(esperaBackoff(tentativa, null));
      continue;
    }
    clearTimeout(timer);
    const latenciaMs = agora() - t0;

    if (!resp.ok) {
      // O corpo de erro da API não ecoa o Authorization; ainda assim, corta e nunca inclui a chave.
      ultimoErro = `HTTP ${resp.status}: ${texto.slice(0, 300).split(o.chave).join('<chave>')}`;
      ultimoStatus = resp.status;
      if (!TRANSITORIOS.has(resp.status)) break;
      if (tentativa < maxTentativas) await dormir(esperaBackoff(tentativa, resp.headers.get('retry-after')));
      continue;
    }

    let json: unknown;
    try {
      json = JSON.parse(texto);
    } catch {
      return { ok: false, erro: 'resposta inválida: corpo não é JSON', status: resp.status, tentativas: tentativa, latenciaTotalMs: agora() - inicio };
    }
    const v = validar(json, opcoes);
    if (!v.ok) {
      return { ok: false, erro: `resposta inválida: ${v.motivo}`, status: resp.status, tentativas: tentativa, latenciaTotalMs: agora() - inicio };
    }
    return {
      ok: true,
      escolha: v.escolha,
      prob: v.probabilidades[v.escolha],
      probabilidades: v.probabilidades,
      confidence: v.confidence,
      tokensEntrada: v.tokensEntrada,
      modelo: v.modelo,
      tentativas: tentativa,
      latenciaMs,
      latenciaTotalMs: agora() - inicio,
    };
  }
  return { ok: false, erro: ultimoErro, status: ultimoStatus, tentativas: feitas, latenciaTotalMs: agora() - inicio };
}
