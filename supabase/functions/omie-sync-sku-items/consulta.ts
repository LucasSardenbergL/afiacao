// A chamada `ConsultarRecebimento` do `omie-sync-sku-items`, com as dependências de I/O
// INJETÁVEIS (request HTTP, relógio, sono). O MESMO código roda na edge (com `DEPS_REAIS`) e nos
// testes (consulta_test.ts, Deno `--no-remote`, com um Omie falso) — a prova do adiamento passa
// pelo encanamento de produção, não por um objeto `{adiada:true}` fabricado no teste (achado do
// Codex no desenho: "um teste que fabrica a marca pode ficar verde enquanto o wrapper lança").
//
// O que cada desfecho significa para o chamador (o laço da edge):
//   · `respondida` → a Omie respondeu um objeto JSON em 2xx (com itens, sem itens ou com
//     faultstring de NEGÓCIO) → processa e MARCA tentativa;
//   · `adiada`     → limite do RUN (REDUNDANT/rate-limit que não cabe no deadline, limite que
//     persistiu nas retentativas, deadline vencido) → NÃO marca, NÃO é falha (adiamento.ts);
//   · `falhou`     → HTTP não-2xx sem faultstring de limite, socket/abort, corpo que não é objeto
//     JSON → MARCA tentativa com `consulta_falhou: …` e conta para a falha sistêmica.
//
// ⚠️ Corpo 2xx que NÃO é objeto JSON era, antes desta fatia, tratado como resposta sem itens
// (`{ raw: text }` → `consultas_detalhadas++` → `ok_0_itens`): um HTML de manutenção da Omie
// fechava o run `complete` e empurrava a NFe para o backoff como se ela não tivesse itens. Agora é
// FALHA — ausente ≠ zero. [Codex, desenho]

import { mensagemDeErro } from "../_shared/erro-mensagem.ts";
import { timeoutRequestMs } from "../_shared/omie-deadline.ts";
import {
  adiarConsulta,
  type ConsultaAdiada,
  decidirLimite,
  ehConsultaAdiada,
  ehRespostaDeLimite,
  esperaPedidaMs,
} from "./adiamento.ts";

export interface OmieItemCabec {
  nIdProduto?: number | string;
  cCodigoProduto?: string;
  cDescricaoProduto?: string;
  cUnidadeNfe?: string;
  cNCM?: string;
  nQtdeNFe?: number | string;
  nPrecoUnit?: number | string;
  vTotalItem?: number | string;
}

export interface OmieItemInfoAdic {
  nNumPedCompra?: number | string;
}

export interface OmieItemAjustes {
  nQtdeRecebida?: number | string;
}

export interface OmieRecebimentoItem {
  itensCabec?: OmieItemCabec;
  itensInfoAdic?: OmieItemInfoAdic;
  itensAjustes?: OmieItemAjustes;
}

export interface OmieConsultarRecebimentoResponse {
  itensRecebimento?: OmieRecebimentoItem[];
  faultstring?: string;
}

export const OMIE_ENDPOINT_RECEBIMENTO = "https://app.omie.com.br/api/v1/produtos/recebimentonfe/";

export interface DepsConsulta {
  /** Faz UM request com teto de relógio `timeoutMs` (o abort é responsabilidade de quem implementa). */
  requisitar: (url: string, init: RequestInit, timeoutMs: number) => Promise<Response>;
  agora: () => number;
  dormir: (ms: number) => Promise<void>;
}

/** As dependências de produção. O abort por `AbortSignal.timeout` mora AQUI, e não no laço, para
 *  que o teste não precise de timer real (o fake recebe o `timeoutMs` e pode conferi-lo). */
export const DEPS_REAIS: DepsConsulta = {
  requisitar: (url, init, timeoutMs) => fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) }),
  agora: () => Date.now(),
  dormir: (ms) => new Promise((r) => setTimeout(r, ms)),
};

export interface Credenciais {
  app_key: string;
  app_secret: string;
}

/** Requests FÍSICOS ao Omie, retentativas incluídas — o summary o expõe como `requisicoes_omie`.
 *  Mutável de propósito: ele tem de sobreviver a um `throw` no meio das tentativas. */
export interface ContadorRequisicoes {
  requisicoes: number;
}

export interface OpcoesConsulta {
  /** Teto de RELÓGIO por request (#2017). O guard é do RUN; sem teto por request um socket
   *  pendurado consome os 50s sozinho e o isolate morre sem passar por catch nenhum — a NFe nem
   *  chega a ser marcada como tentada. Abaixo do guard de propósito: request normal não leva 20s. */
  tetoPorRequestMs: number;
  /** Espera quando a Omie sinaliza limite sem dizer "Aguarde N segundos". */
  esperaPadraoMs: number;
  maxTentativas: number;
}

export const OPCOES_PADRAO: OpcoesConsulta = {
  tetoPorRequestMs: 20_000,
  esperaPadraoMs: 5_000,
  maxTentativas: 3,
};

function parseObjetoJson(texto: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(texto);
    return v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/**
 * `ConsultarRecebimento({nIdReceb})` sob o deadline do run. Devolve a resposta (objeto JSON em
 * 2xx, sem sinal de limite) ou a marca de ADIAMENTO; LANÇA em falha real.
 *
 * O teto de cada request ENCOLHE conforme o run se aproxima do deadline; sem tempo viável, ADIA
 * em vez de lançar — deadline do run não é defeito da NFe (lançar era o que a punia com backoff).
 */
export async function consultarRecebimento(
  deps: DepsConsulta,
  cred: Credenciais,
  nIdReceb: number,
  deadline: number,
  contador: ContadorRequisicoes,
  opcoes: OpcoesConsulta = OPCOES_PADRAO,
): Promise<OmieConsultarRecebimentoResponse | ConsultaAdiada> {
  const corpo = JSON.stringify({
    call: "ConsultarRecebimento",
    app_key: cred.app_key,
    app_secret: cred.app_secret,
    param: [{ nIdReceb }],
  });
  for (let tentativa = 1; tentativa <= opcoes.maxTentativas; tentativa++) {
    const timeoutMs = timeoutRequestMs(deps.agora(), deadline, opcoes.tetoPorRequestMs);
    if (timeoutMs === 0) {
      return adiarConsulta(
        "deadline_antes_da_chamada",
        0,
        `ConsultarRecebimento: deadline do run atingido antes da tentativa ${tentativa}/${opcoes.maxTentativas}`,
      );
    }
    contador.requisicoes++;
    const res = await deps.requisitar(
      OMIE_ENDPOINT_RECEBIMENTO,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: corpo },
      timeoutMs,
    );
    const texto = await res.text();
    const json = parseObjetoJson(texto);
    const faultstring = typeof json?.faultstring === "string" ? json.faultstring : "";
    if (ehRespostaDeLimite(res.status, faultstring)) {
      // O Omie pede "Aguarde N segundos" — REDUNDANT quando a MESMA chamada saiu há <~60s. Dormir
      // além do deadline é sono que nunca acorda (o isolate morre no sleep); espera que não cabe,
      // ou que persiste na última tentativa, vira ADIAMENTO (decisão pura em adiamento.ts).
      const veredicto = decidirLimite({
        agora: deps.agora(),
        deadline,
        esperaMs: esperaPedidaMs(faultstring, opcoes.esperaPadraoMs),
        tentativa,
        maxTentativas: opcoes.maxTentativas,
      });
      if (veredicto.tipo === "adiar") return veredicto.consulta;
      console.warn(
        `[sync-sku-items] ConsultarRecebimento aguardando ${Math.round(veredicto.esperaMs / 1000)}s por limite Omie (try ${tentativa}/${opcoes.maxTentativas})`,
      );
      await deps.dormir(veredicto.esperaMs);
      continue;
    }
    if (!res.ok) {
      throw new Error(`Omie ConsultarRecebimento HTTP ${res.status}: ${texto.slice(0, 400)}`);
    }
    if (!json) {
      throw new Error(
        `Omie ConsultarRecebimento: corpo HTTP ${res.status} não é um objeto JSON — ${texto.slice(0, 200)}`,
      );
    }
    return json as OmieConsultarRecebimentoResponse;
  }
  // Inalcançável: a última tentativa com limite ADIA; sem limite, o laço retorna ou lança.
  throw new Error("Omie ConsultarRecebimento: laço de tentativas encerrou sem veredito");
}

export type ResultadoConsulta =
  | { tipo: "respondida"; detalhe: OmieConsultarRecebimentoResponse }
  | { tipo: "adiada"; adiamento: ConsultaAdiada }
  | { tipo: "falhou"; mensagem: string };

/**
 * O desfecho da consulta de UMA NFe, já classificado — o laço da edge só decide o que fazer com
 * cada tipo. A exceção vira `falhou` AQUI, e a marca de adiamento é conferida pelo guard
 * ESTRUTURAL: um `Error` cujo texto diga "limite pede 54s…" continua `falhou`.
 */
export async function consultarNfe(
  deps: DepsConsulta,
  cred: Credenciais,
  nIdReceb: number,
  deadline: number,
  contador: ContadorRequisicoes,
  opcoes: OpcoesConsulta = OPCOES_PADRAO,
): Promise<ResultadoConsulta> {
  try {
    const r = await consultarRecebimento(deps, cred, nIdReceb, deadline, contador, opcoes);
    if (ehConsultaAdiada(r)) return { tipo: "adiada", adiamento: r };
    return { tipo: "respondida", detalhe: r };
  } catch (e) {
    return { tipo: "falhou", mensagem: mensagemDeErro(e) ?? "erro sem mensagem" };
  }
}
