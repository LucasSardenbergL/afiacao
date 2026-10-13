// Núcleo de TRANSPORTE das chamadas ao Omie (M-48): corpo, fetch com teto de relógio, parse e
// retentativa — sem import remoto, com `fetch`/relógio/sono injetáveis. Testes em
// omie-cliente_test.ts (Deno, `--no-remote`).
//
// ── Por que existe ───────────────────────────────────────────────────────────────────────────
// Cada edge tinha o seu `omieCall`, e cada um errava de um jeito: sem teto de relógio (o socket
// pendurado do #2017), retentativa de ESCRITA em 5xx/rede (o `ConcluirRecebimento` do
// omie-nfe-recebimento podia sair duas vezes), status HTTP lido antes da faultstring (o EOF que
// chega com 500 virava erro de transporte — #1614), JSON inválido lido como "sem registros".
// #1614/#1623 foram correções wrapper a wrapper; este módulo é o lugar ÚNICO dessas regras.
//
// ── O que fica com quem chama ────────────────────────────────────────────────────────────────
// O núcleo NÃO decide o que a resposta significa para o negócio (fim de paginação de um endpoint
// específico, "produto inexistente", trava de API): devolve a `RespostaOmie` crua e classificada,
// e cada edge mantém um adaptador fino para o seu retorno legado. A credencial também é de quem
// chama — o núcleo só a põe no corpo e NUNCA a ecoa (a faultstring sai por `redigirSegredo` no
// adaptador que a exibe).
//
// ── Escrita ──────────────────────────────────────────────────────────────────────────────────
// A segurança da escrita é a do `omie-chamada-relogio.ts`, e NÃO é configurável por edge:
// - exceção no transporte de uma escrita → `OmieEscritaIndeterminada` (nunca repetida aqui);
// - resposta transitória numa escrita → `decidirFaultTransitorio`: só rate-limit e escrita de SET
//   (`Alterar*`/`Totalizar*`) repetem; `Incluir*`/`Concluir*`/... saem indeterminadas;
// - repetiu uma escrita de SET e esgotou → indeterminada (a anterior pode ter gravado).
import {
  chamarComRelogio,
  decidirFaultTransitorio,
  ehEscritaOmie,
  erroEscritaAmbigua,
  prazoDaChamadaOmie,
  TETO_CHAMADA_OMIE_MS,
} from "./omie-chamada-relogio.ts";
import { classificarFaultCota } from "./omie-cota.ts";
import { mensagemDeErro } from "./erro-mensagem.ts";
import { cabeEspera } from "./omie-deadline.ts";
import { atrasoRetentativaMs, classificarFaultstring } from "./omie-falha.ts";

export interface CredenciaisOmie {
  appKey: string;
  appSecret: string;
}

export interface PedidoOmie {
  /** URL completa do endpoint (ex.: `https://app.omie.com.br/api/v1/produtos/recebimentonfe/`). */
  url: string;
  metodo: string;
  /** Vai como `param: [param]` — o envelope do contrato Omie. */
  param: unknown;
  credenciais: CredenciaisOmie;
}

export interface RespostaOmie {
  status: number;
  /** `status` 2xx. Sozinho NÃO é sucesso: o Omie manda falha de negócio com 200 + faultstring. */
  ok: boolean;
  texto: string;
  /** O corpo, se for um OBJETO JSON; `null` = ilegível (nunca "vazio"). */
  corpo: Record<string, unknown> | null;
  faultstring: string | null;
  faultcode: string | null;
}

/**
 * - `final`: resposta para o chamador interpretar (sucesso, fault de negócio, EOF, 4xx).
 * - `transitorio`: falha de servidor/rede que vale repetir (numa LEITURA).
 * - `rate_limit`: o Omie RECUSOU a chamada (nada foi aplicado) — repetir é seguro até em escrita.
 */
export type ClasseResposta = "final" | "transitorio" | "rate_limit";

function texto(v: unknown): string | null {
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number") return String(v);
  return null;
}

/** Parse tolerante: texto que não é objeto JSON vira `corpo: null`, nunca exceção nem `{}`. */
export function lerResposta(status: number, corpoTexto: string): RespostaOmie {
  let corpo: Record<string, unknown> | null = null;
  try {
    const v: unknown = JSON.parse(corpoTexto);
    if (v !== null && typeof v === "object" && !Array.isArray(v)) corpo = v as Record<string, unknown>;
  } catch {
    corpo = null;
  }
  return {
    status,
    ok: status >= 200 && status < 300,
    texto: corpoTexto,
    corpo,
    faultstring: texto(corpo?.faultstring),
    faultcode: texto(corpo?.faultcode),
  };
}

/** EOF do contrato Omie ("Não existem registros para a página"). Vence o status: chega com 500. */
export function fimDePaginacao(r: RespostaOmie): boolean {
  return r.faultstring !== null && classificarFaultstring(r.faultstring) === "fim_de_pagina";
}

/**
 * Classificação padrão. A ordem é a canônica do #1614: a faultstring decide ANTES do status
 * (o EOF e várias falhas de negócio chegam com HTTP 500 — ler o status primeiro repetiria uma
 * resposta definitiva e a reportaria como falha de transporte).
 *
 * REDUNDANT e bloqueio por consumo indevido são `final`: repetir dentro da trégua RENOVA a trava
 * do Omie (é o que escala REDUNDANT para bloqueio de 30 min). Só a concorrência ("Já existe uma
 * requisição desse método") e o 429 são `rate_limit`.
 */
export function classificarResposta(r: RespostaOmie): ClasseResposta {
  if (r.faultstring !== null) {
    const cota = classificarFaultCota(r.faultstring);
    if (cota) return cota.tipo === "concorrente" ? "rate_limit" : "final";
    return classificarFaultstring(r.faultstring) === "transitorio" ? "transitorio" : "final";
  }
  if (r.status === 429) return "rate_limit";
  if (r.status >= 500) return "transitorio";
  // 2xx com corpo ilegível (resposta cortada): ler como "sem registros" fabricaria fim.
  if (r.ok && r.corpo === null) return "transitorio";
  return "final";
}

/** O que uma resposta transitória diz, para log e para `cause` — sem credencial, sem corpo inteiro. */
function motivoTransitorio(r: RespostaOmie): string {
  return r.faultstring ?? `HTTP ${r.status}`;
}

export interface OpcoesTentativa {
  conta: string;
  /** Fim da chamada (ou do run, se a edge tem relógio próprio). Padrão: `prazoDaChamadaOmie`. */
  deadline: number;
  /** Teto de UM request; o deadline o encurta. Padrão: `TETO_CHAMADA_OMIE_MS`. */
  tetoPorRequestMs?: number;
  /** Uma tentativa anterior desta escrita teve resposta ambígua (ver `chamarComRelogio`). */
  envioAnteriorAmbiguo?: boolean;
  sinalExtra?: AbortSignal;
  fetchImpl?: typeof fetch;
  agora?: () => number;
  /** Só para teste: piso de viabilidade do request. */
  minimoMs?: number;
}

/**
 * UMA tentativa: monta o corpo, faz o fetch sob o relógio e lê o corpo DENTRO dele (o teto cobre
 * os dois). Escrita que falha no transporte sai `OmieEscritaIndeterminada`; leitura que estoura
 * sai `OMIE_TRANSIENT … timeout`; sem tempo viável, a chamada não é feita.
 */
export function enviarOmie(p: PedidoOmie, o: OpcoesTentativa): Promise<RespostaOmie> {
  const fazerFetch = o.fetchImpl ?? fetch;
  const corpo = JSON.stringify({
    call: p.metodo,
    app_key: p.credenciais.appKey,
    app_secret: p.credenciais.appSecret,
    param: [p.param],
  });
  return chamarComRelogio(async (signal) => {
    const res = await fazerFetch(p.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: corpo,
      signal,
    });
    return lerResposta(res.status, await res.text());
  }, {
    metodo: p.metodo,
    conta: o.conta,
    deadline: o.deadline,
    sinalExtra: o.sinalExtra,
    agora: o.agora,
    envioAnteriorAmbiguo: o.envioAnteriorAmbiguo,
    tetoMs: o.tetoPorRequestMs ?? TETO_CHAMADA_OMIE_MS,
    minimoMs: o.minimoMs,
  });
}

export interface OpcoesChamada extends Omit<OpcoesTentativa, "deadline" | "envioAnteriorAmbiguo"> {
  deadline?: number;
  /** Tentativas no total (1 = sem retentativa). Padrão: 3. */
  maxTentativas?: number;
  /**
   * Classificação própria da edge (ex.: `SOAP-ENV:Client` = produto inexistente, definitivo).
   * Só vale para LEITURA: numa escrita é IGNORADA — um classificador que chamasse de `final` um 5xx
   * ambíguo apagaria a indeterminada. Escrita usa sempre `classificarResposta` + `decidirFaultTransitorio`.
   */
  classificar?: (r: RespostaOmie) => ClasseResposta;
  /** Espera antes da tentativa `tentativa + 1`. Padrão: `atrasoRetentativaMs` (honra "Aguarde N segundos"). */
  atrasoMs?: (tentativa: number, motivo: { resposta?: RespostaOmie; erro?: unknown }) => number;
  dormir?: (ms: number) => Promise<void>;
  /** Para log da edge — o núcleo não loga (não sabe o que é PII em cada endpoint). */
  aoRepetir?: (info: { tentativa: number; atrasoMs: number; motivo: string }) => void;
}

const dormirReal = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Chamada LÓGICA ao Omie: `enviarOmie` + retentativa só do que é transitório, com UM deadline
 * compartilhado entre tentativas e esperas (nenhum sono que não deixe tempo para o request seguinte).
 *
 * Devolve a última resposta quando ela é `final` ou quando a retentativa esgota numa LEITURA — o
 * chamador a interpreta (é o que os adaptadores legados fazem). Lança:
 * - `OmieEscritaIndeterminada` — escrita com desfecho desconhecido (ver o topo do arquivo);
 * - a exceção da última tentativa de LEITURA (rede, timeout, sem tempo), já esgotadas as retentativas.
 */
export async function chamarOmie(p: PedidoOmie, o: OpcoesChamada): Promise<RespostaOmie> {
  const agora = o.agora ?? Date.now;
  const deadline = o.deadline ?? prazoDaChamadaOmie(agora());
  const maxTentativas = Math.max(1, Math.floor(o.maxTentativas ?? 3));
  const classificar = o.classificar ?? classificarResposta;
  const atrasoMs = o.atrasoMs ?? ((t, m) => atrasoRetentativaMs(t, m.resposta?.faultstring));
  const dormir = o.dormir ?? dormirReal;
  const escrita = ehEscritaOmie(p.metodo);
  let envioAmbiguo = false;

  for (let tentativa = 1; ; tentativa++) {
    const ultima = tentativa >= maxTentativas;
    let resposta: RespostaOmie;
    try {
      resposta = await enviarOmie(p, { ...o, deadline, envioAnteriorAmbiguo: envioAmbiguo });
    } catch (erro) {
      // Escrita: o relógio já a marcou indeterminada (ou "não foi feita", se não houve tempo) —
      // repetir um envio que talvez tenha sido aplicado é exatamente o que este módulo proíbe.
      if (escrita || ultima) throw erro;
      const espera = atrasoMs(tentativa, { erro });
      if (!cabeEspera(agora(), deadline, espera, o.minimoMs)) throw erro;
      o.aoRepetir?.({ tentativa, atrasoMs: espera, motivo: mensagemDeErro(erro) ?? "erro sem mensagem" });
      await dormir(espera);
      continue;
    }

    const classe = escrita ? classificarResposta(resposta) : classificar(resposta);
    if (classe === "final") return resposta;

    const rateLimit = classe === "rate_limit";
    if (escrita) {
      if (decidirFaultTransitorio(p.metodo, rateLimit) === "indeterminada") {
        throw erroEscritaAmbigua(p.metodo, o.conta, motivoTransitorio(resposta));
      }
      if (!rateLimit) envioAmbiguo = true;
    }
    const espera = atrasoMs(tentativa, { resposta });
    if (!ultima && cabeEspera(agora(), deadline, espera, o.minimoMs)) {
      o.aoRepetir?.({ tentativa, atrasoMs: espera, motivo: motivoTransitorio(resposta) });
      await dormir(espera);
      continue;
    }
    if (envioAmbiguo) throw erroEscritaAmbigua(p.metodo, o.conta, motivoTransitorio(resposta));
    return resposta;
  }
}
