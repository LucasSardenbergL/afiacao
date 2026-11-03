// Laço de tentativas do `callOmie` da omie-financeiro, com o I/O injetado (envio, relógio, sono) para
// ser testável em Deno `--no-remote` (omie-chamada_test.ts). O `fetch` cru e as credenciais continuam
// no index.ts — o gate `omie-cliente-gate` conta `fetch` ao Omie por arquivo.
//
// ── Incidente 2026-11-03 14:20 UTC (lote 15, 1º run incremental de CR) ──────────────────────────
// Logo depois de uma resposta VAZIA, o Omie recusa a chamada seguinte ao MESMO método, por alguns
// segundos, com HTTP 500 + "Já existe uma requisição desse método sendo executada" (Client-1880).
// Repetir o corpo idêntico depois disso vira "Consumo redundante" (Client-6, a recusa também conta
// como consumo) e, insistindo, `MISUSE_API_PROCESS` (425). O full nunca via isso — termina NA página
// vazia —; o incremental encadeia A (aberto, termina vazia) → B (alterados), e B morria nas 4
// tentativas do backoff de 5xx (1+2+4 s) com "HTTP 500", nas 3 empresas (api_calls 14/9/7 = páginas
// de A + a vazia + 4 tentativas). Medido na oben: trava de ~3 a ~6 s depois da vazia; com corpo
// diferente, a chamada passou a 5,8 s.
//
// Duas camadas:
//  1. resfriamento: depois de uma resposta vazia, a próxima chamada da mesma empresa ao mesmo método
//     espera `RESFRIAMENTO_POS_VAZIA_MS` (a causa — não pedir enquanto a trava existe);
//  2. 5xx lê o corpo: concorrência espera como rate-limit; REDUNDANT/bloqueio LANÇAM na hora (repetir
//     renova a trava — `_shared/omie-cota.ts`); a mensagem de erro carrega o fault real (o "HTTP 500"
//     seco escondeu a causa no incidente). 5xx sem fault de cota segue o backoff transitório de antes.
import { classificarFaultCota } from "../_shared/omie-cota.ts";
import { mensagemDeErro } from "../_shared/erro-mensagem.ts";

export type OmieGenericResponse = Record<string, unknown> & { faultstring?: string };
export type ClasseFaultOmie = "rate_limit" | "transient" | "fatal";

/** Espera, depois de uma resposta vazia, antes da próxima chamada ao mesmo método da mesma empresa. */
export const RESFRIAMENTO_POS_VAZIA_MS = 10_000;

export interface DepsChamadaOmie {
  enviar(corpo: string): Promise<Response>;
  /** `classifyOmieFault` do index.ts (espelho de src/lib/omie/omie-fault.ts) — política da resposta 2xx. */
  classificar(faultstring: string): ClasseFaultOmie;
  dormir(ms: number): Promise<void>;
  agora(): number;
  orcamentoEsgotado(): boolean;
  log(msg: string): void;
  aoChamar(): void;
  aoRateLimit(): void;
  /** chave (empresa:endpoint:call) → instante da última resposta vazia. Vive no módulo do index.ts. */
  ultimaVazia: Map<string, number>;
}

/** Resposta de listagem SEM registros. Ausente não é vazio: só zero explícito conta. */
export function respostaVazia(r: Record<string, unknown>): boolean {
  const zero = (v: unknown) => v === 0 || v === "0";
  return zero(r.total_de_registros) || zero(r.registros);
}

function faultDoCorpo(texto: string): string | null {
  try {
    const v: unknown = JSON.parse(texto);
    if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
    const f = (v as Record<string, unknown>).faultstring;
    return typeof f === "string" && f.trim() ? f.trim() : null;
  } catch {
    return null;
  }
}

// Backoff curto com jitter pra faults transitórios (1s, 2s, 4s + jitter, cap 4s).
// Curto de propósito: o budget de invocação é 100s; o cursor de continuação */10
// retoma o que faltar. Jitter evita sincronizar as 3 empresas e piorar rate-limit.
async function backoffTransitorio(attempt: number, company: string, reason: string, deps: DepsChamadaOmie): Promise<void> {
  const base = Math.min(1000 * 2 ** attempt, 4000);
  const delay = base + Math.floor(Math.random() * 500);
  deps.log(`[Fin][${company}] Omie transitório, retry em ${(delay / 1000).toFixed(1)}s: ${reason}`);
  await deps.dormir(delay);
}

export async function chamarOmieComPolitica(
  company: string,
  chave: string,
  corpo: string,
  deps: DepsChamadaOmie,
): Promise<OmieGenericResponse | null> {
  const maxRetries = 3;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    // 0) resfriamento pós-vazia. Sem budget para esperar = pausa resumível (null), como o estouro.
    const vaziaEm = deps.ultimaVazia.get(chave);
    if (vaziaEm !== undefined) {
      const falta = vaziaEm + RESFRIAMENTO_POS_VAZIA_MS - deps.agora();
      if (falta > 0) {
        if (deps.orcamentoEsgotado()) return null;
        deps.log(`[Fin][${company}] Omie: resfriamento de ${(falta / 1000).toFixed(1)}s após resposta vazia`);
        await deps.dormir(falta);
      }
    }

    // 1) envio — erro de REDE (DNS/conexão/timeout do AbortSignal) é transitório.
    let res: Response;
    try {
      res = await deps.enviar(corpo);
    } catch (netErr) {
      if (attempt < maxRetries && !deps.orcamentoEsgotado()) {
        await backoffTransitorio(attempt, company, `rede: ${(mensagemDeErro(netErr) ?? "sem mensagem").slice(0, 50)}`, deps);
        continue;
      }
      throw netErr instanceof Error ? netErr : new Error(`Omie (${company}): ${mensagemDeErro(netErr) ?? "falha de rede"}`);
    }
    deps.aoChamar();

    // 2) não-2xx: o Omie manda o fault no corpo também com 500 — lê ANTES de decidir.
    if (!res.ok) {
      const fault = faultDoCorpo(await res.text().catch(() => ""));
      const cota = fault ? classificarFaultCota(fault) : null;
      if (cota?.tipo === "concorrente" && attempt < maxRetries && !deps.orcamentoEsgotado()) {
        deps.aoRateLimit();
        const delay = Math.min((attempt + 1) * 5 + 2, 15) * 1000;
        deps.log(`[Fin][${company}] Omie concorrente (HTTP ${res.status}), waiting ${delay / 1000}s`);
        await deps.dormir(delay);
        continue;
      }
      if (!cota) {
        if (res.status === 429 && attempt < maxRetries && !deps.orcamentoEsgotado()) {
          deps.aoRateLimit();
          deps.log(`[Fin][${company}] HTTP 429, waiting 5s`);
          await deps.dormir(5000);
          continue;
        }
        if (res.status >= 500 && attempt < maxRetries && !deps.orcamentoEsgotado()) {
          await backoffTransitorio(attempt, company, fault ? fault.slice(0, 70) : `HTTP ${res.status}`, deps);
          continue;
        }
      }
      throw new Error(`Omie (${company}): HTTP ${res.status}${fault ? ` — ${fault}` : ""}`);
    }

    // 3) parse — corpo 200 não-JSON / quebrado é transitório.
    let result: OmieGenericResponse;
    try {
      result = (await res.json()) as OmieGenericResponse;
    } catch (parseErr) {
      if (attempt < maxRetries && !deps.orcamentoEsgotado()) {
        await backoffTransitorio(attempt, company, `corpo não-JSON`, deps);
        continue;
      }
      throw new Error(`Omie (${company}): resposta não-JSON (${(mensagemDeErro(parseErr) ?? "sem mensagem").slice(0, 50)})`);
    }

    // 4) faultstring em 2xx — classifica e aplica política por classe.
    if (result.faultstring) {
      const fs = String(result.faultstring);
      const klass = deps.classificar(fs);
      if (klass === "rate_limit" && attempt < maxRetries) {
        deps.aoRateLimit();
        const waitMatch = fs.match(/Aguarde (\d+) segundos/);
        const requestedDelay = waitMatch ? parseInt(waitMatch[1]) : (attempt + 1) * 5;
        const delay = Math.min(requestedDelay + 2, 15) * 1000;
        deps.log(`[Fin][${company}] Rate limit, waiting ${delay / 1000}s`);
        await deps.dormir(delay);
        continue;
      }
      if (klass === "transient" && attempt < maxRetries && !deps.orcamentoEsgotado()) {
        await backoffTransitorio(attempt, company, fs.slice(0, 70), deps);
        continue;
      }
      throw new Error(`Omie (${company}): ${fs}`);
    }
    if (respostaVazia(result)) deps.ultimaVazia.set(chave, deps.agora());
    return result;
  }
  return null;
}
