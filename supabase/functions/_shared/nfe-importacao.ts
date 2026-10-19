// O ÚNICO caminho de escrita de recebimento de NF-e (cabeçalho + itens): a RPC transacional
// `importar_nfe_recebimento` (db/2026-10-18-importar-nfe-recebimento-rpc.sql). Compartilhado pelo
// `omie-nfe-webhook` e pela `omie-nfe-recebimento-sync` (cron e botão) — 1 writer de itens.
//
// Por que existe: até aqui cada edge inseria `nfe_recebimentos` e DEPOIS `nfe_recebimento_itens` em
// duas requisições PostgREST (sem transação), e webhook×sync na mesma chave podiam produzir 2N itens;
// o `omie-nfe-reconcile` podia promover `pendente→efetivado` entre a leitura e o insert. A RPC faz
// as duas escritas na MESMA transação, com lock por chave e FOR UPDATE no cabeçalho (2 pareceres
// Codex 2026-10-18; prova executada em db/test-importar-nfe-recebimento.sh).
//
// Sem dependência do supabase-js de propósito: o cliente entra por contrato ESTRUTURAL (`ClienteRpc`),
// que o fake dos testes (`deno test --no-remote`) satisfaz e o cliente real atende por cast.

import { mensagemDeErro } from "./erro-mensagem.ts";

type OrigemImportacao = "webhook" | "sync" | "importacao_chave";

/** Erro como o PostgREST o devolve: `message` e `code` (SQLSTATE, ou `PGRST…`). */
type ErroPostgrest = { message?: unknown; code?: unknown; details?: unknown; hint?: unknown };
export type RespostaRpc = { data?: unknown; error: ErroPostgrest | null };

/** O que este módulo usa do supabase-js — e NADA mais. */
export interface ClienteRpc {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<RespostaRpc>;
}

type ResultadoRpc =
  | { tipo: "importada" | "reparada" | "ja_importada"; id: string; itens: number }
  /** Cabeçalho sem itens que NÃO pode ser completado (não-pendente ou em uso). */
  | { tipo: "bloqueada"; id: string; itens: number; motivo: string }
  /** Itens gravados ≠ payload (cardinalidade OU conteúdo), ou cabeçalho de outro armazém/recebimento. */
  | { tipo: "divergente"; id: string; itens: number; esperados: number; motivo: string };

export type ClasseErro =
  /** Determinístico — reenviar o MESMO payload não conserta: NFE0x, tipo que não cabe, NOT NULL, CHECK. */
  | "dado"
  /** A função não está no banco/cache do PostgREST: a migration não foi aplicada (ou o cache não recarregou). */
  | "rpc_ausente"
  /** Qualquer outra coisa (rede, timeout, lock, 23505 inesperado): vale repetir. */
  | "infra";

export type ErroRpc = { tipo: "erro"; classe: ClasseErro; code: string | null; mensagem: string };

export type DesfechoImportacao = ResultadoRpc | ErroRpc;

const RPC_IMPORTAR = "importar_nfe_recebimento";
const RPC_REGISTRAR_FALHA = "nfe_importacao_falha_registrar";

/** A partir de quantas falhas registradas a triagem do cron PULA a chave (a fila anda; o botão ignora). */
export const TENTATIVAS_PARA_ESTACIONAR = 3;

/** Teto da escrita no ledger de falhas: ela não pode segurar a resposta ao Omie (promessa pendurada = sem deadline). */
const LEDGER_DEADLINE_MS = 5_000;

const SQLSTATES_DE_DADO = new Set([
  "22001", // string_data_right_truncation (ncm > 8…)
  "22003", // numeric_value_out_of_range
  "22007", // invalid_datetime_format
  "22008", // datetime_field_overflow
  "22P02", // invalid_text_representation (uuid/número inválido)
  "22P05", // untranslatable_character (\u0000 em texto → jsonb/text rejeitam sempre)
  "23502", // not_null_violation (descricao NULL, warehouse_id ausente…)
  "23503", // foreign_key_violation (warehouse inexistente)
  "23514", // check_violation
]);

export function classificarErro(code: string | null, mensagem: string): ClasseErro {
  if (code === "PGRST202" || code === "42883") return "rpc_ausente";
  if (code !== null && (code.startsWith("NFE") || SQLSTATES_DE_DADO.has(code))) return "dado";
  // PostgREST sem código mas com a assinatura de função ausente (versões que não emitem PGRST202).
  if (code === null && /could not find the function|function .* does not exist/i.test(mensagem)) return "rpc_ausente";
  return "infra";
}

function erroDe(error: ErroPostgrest): ErroRpc {
  const code = typeof error.code === "string" && error.code ? error.code : null;
  const mensagem = typeof error.message === "string" && error.message ? error.message : "erro sem mensagem";
  return { tipo: "erro", classe: classificarErro(code, mensagem), code, mensagem };
}

function inteiroNaoNegativo(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null;
}

/**
 * Interpreta o jsonb que a RPC devolve. Fail-closed: forma inesperada é ERRO (classe infra), nunca
 * "importada" por boa vontade — um 2xx ao Omie diz "pode descartar o evento".
 */
export function interpretarResultadoRpc(data: unknown): DesfechoImportacao {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return { tipo: "erro", classe: "infra", code: null, mensagem: "a RPC devolveu um corpo em formato inesperado" };
  }
  const r = data as Record<string, unknown>;
  const id = typeof r.id === "string" ? r.id : null;
  const itens = inteiroNaoNegativo(r.itens);
  if (id === null || itens === null) {
    return { tipo: "erro", classe: "infra", code: null, mensagem: `a RPC devolveu resultado sem id/itens legíveis (${String(r.resultado)})` };
  }
  switch (r.resultado) {
    case "importada":
    case "reparada":
    case "ja_importada":
      return { tipo: r.resultado, id, itens };
    case "bloqueada":
      return { tipo: "bloqueada", id, itens, motivo: typeof r.motivo === "string" ? r.motivo : "motivo não informado" };
    case "divergente": {
      const esperados = inteiroNaoNegativo(r.esperados);
      if (esperados === null) {
        return { tipo: "erro", classe: "infra", code: null, mensagem: "a RPC devolveu divergente sem `esperados` legível" };
      }
      return { tipo: "divergente", id, itens, esperados, motivo: typeof r.motivo === "string" ? r.motivo : "motivo não informado" };
    }
    default:
      return { tipo: "erro", classe: "infra", code: null, mensagem: `a RPC devolveu resultado desconhecido (${String(r.resultado)})` };
  }
}

/**
 * Estrutura e campos obrigatórios do lote ANTES dos defaults dos mapeadores chegarem ao SQL — o
 * mapper transforma `7`/`null` em "Item sem descrição, quantidade 0", que o DDL aceita (parecer
 * adversarial). Devolve o motivo da rejeição, ou `null` se o lote está são. Não valida o que a RPC
 * já valida melhor (sequência repetida, tipos que não cabem): valida o que ela NÃO vê — a quantidade
 * zero/negativa e a descrição vazia fabricadas por default.
 */
export function validarLote(itens: unknown): string | null {
  if (!Array.isArray(itens)) return "itens não é uma lista";
  if (itens.length === 0) return "lote sem itens";
  for (let i = 0; i < itens.length; i++) {
    const it = itens[i];
    const n = i + 1;
    if (it === null || typeof it !== "object" || Array.isArray(it)) return `item #${n}: não é um objeto`;
    const r = it as Record<string, unknown>;
    const seq = typeof r.sequencia === "string" ? Number(r.sequencia) : r.sequencia;
    if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 1) return `item #${n}: sequencia inválida (${String(r.sequencia)})`;
    const q = typeof r.quantidade_nfe === "string" ? Number(r.quantidade_nfe) : r.quantidade_nfe;
    if (typeof q !== "number" || !Number.isFinite(q) || q <= 0) return `item #${n}: quantidade_nfe inválida (${String(r.quantidade_nfe)})`;
    if (typeof r.descricao !== "string" || r.descricao.trim() === "") return `item #${n}: descricao vazia`;
    if (typeof r.unidade_nfe !== "string" || r.unidade_nfe.trim() === "") return `item #${n}: unidade_nfe vazia`;
  }
  return null;
}

/** Lote rejeitado ANTES do banco: a mesma classe (dado, NFE01) que a RPC daria — registrável e 422. */
export function erroDeLote(motivo: string): ErroRpc {
  return { tipo: "erro", classe: "dado", code: "NFE01", mensagem: `lote inválido: ${motivo}` };
}

export interface EntradaImportacao {
  cabecalho: Record<string, unknown>;
  /** Itens SEM `id`/`nfe_recebimento_id` (a RPC ignora os dois e carimba o cabeçalho que valer). */
  itens: Record<string, unknown>[];
  origem: OrigemImportacao;
}

/** Chama a RPC. Nunca lança: transporte que explode vira `erro` classe infra. Valida o lote antes. */
export async function importarViaRpc(cliente: ClienteRpc, entrada: EntradaImportacao): Promise<DesfechoImportacao> {
  const motivo = validarLote(entrada.itens);
  if (motivo !== null) return erroDeLote(motivo);
  let resposta: RespostaRpc;
  try {
    resposta = await cliente.rpc(RPC_IMPORTAR, {
      p_cabecalho: entrada.cabecalho,
      p_itens: entrada.itens,
      p_origem: entrada.origem,
    });
  } catch (e) {
    return { tipo: "erro", classe: "infra", code: null, mensagem: mensagemDeErro(e) ?? "falha de transporte sem mensagem" };
  }
  if (resposta.error) return erroDe(resposta.error);
  return interpretarResultadoRpc(resposta.data);
}

/**
 * O que vai ao ledger durável `nfe_importacao_falhas`: erro de DADO (reenviar não conserta) e os
 * IMPEDIMENTOS da RPC (`bloqueada`, `divergente`) — sem registro, um conflito permanente (cabeçalho de
 * outro armazém com a mesma chave) consumiria a única consulta da rodada para sempre. `rpc_ausente`
 * é deploy fora de ordem (não é a NF-e) e `infra` vale repetir: não entram.
 */
export function registravel(d: DesfechoImportacao): { code: string; mensagem: string } | null {
  switch (d.tipo) {
    case "erro":
      return d.classe === "dado" ? { code: d.code ?? "DADO", mensagem: d.mensagem } : null;
    case "bloqueada":
      return { code: "BLOQUEADA", mensagem: d.motivo };
    case "divergente":
      return { code: "DIVERGENTE", mensagem: `${d.motivo}: ${d.itens} gravados, ${d.esperados} no payload` };
    default:
      return null;
  }
}

export interface FalhaImportacao {
  chaveAcesso: string;
  origem: OrigemImportacao;
  code: string;
  mensagem: string;
  warehouseId?: string | null;
  omieIdReceb?: number | null;
}

/**
 * Registro DURÁVEL fora da transação abortada (a RPC apaga a linha no sucesso). Devolve as tentativas
 * acumuladas, ou `null` se não registrou — fail-open COM deadline e COM log: o ledger não pode derrubar
 * nem segurar a resposta ao Omie, mas a ausência fica escrita.
 */
export async function registrarFalhaImportacao(
  cliente: ClienteRpc,
  falha: FalhaImportacao,
  deadlineMs = LEDGER_DEADLINE_MS,
): Promise<number | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const prazo = new Promise<"prazo">((resolve) => {
    timer = setTimeout(() => resolve("prazo"), deadlineMs);
  });
  try {
    const escrita = Promise.resolve(cliente.rpc(RPC_REGISTRAR_FALHA, {
      p_chave_acesso: falha.chaveAcesso,
      p_origem: falha.origem,
      p_sqlstate: falha.code,
      p_erro: falha.mensagem,
      p_warehouse_id: falha.warehouseId ?? null,
      p_omie_id_receb: falha.omieIdReceb ?? null,
    }));
    const r = await Promise.race([escrita, prazo]);
    if (r === "prazo") {
      console.error(`[nfe-importacao] falha NÃO registrada para ${falha.chaveAcesso}: ledger não respondeu em ${deadlineMs}ms`);
      return null;
    }
    if (r.error) {
      console.error(`[nfe-importacao] falha NÃO registrada para ${falha.chaveAcesso}:`, r.error.message);
      return null;
    }
    return inteiroNaoNegativo(r.data);
  } catch (e) {
    console.error(`[nfe-importacao] falha NÃO registrada para ${falha.chaveAcesso}:`, mensagemDeErro(e) ?? "falha sem mensagem");
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Colunas do cabeçalho que a triagem lê para decidir se a NF-e ainda PRECISA de importação. */
export const SELECT_TRIAGEM =
  "id, omie_id_receb, chave_acesso, warehouse_id, status, conferente_id, conferido_at, efetivado_at, efetivacao_lock_at, nfe_recebimento_itens(count)";

export type Triagem =
  /** Tem itens, ou não pode ser reparado: NÃO gasta consulta/importação. */
  | { tipo: "completo"; itens: number }
  /** `pendente`, 0 itens comprovados, 4 sinais NULL comprovados: a importação COMPLETA este cabeçalho. */
  | { tipo: "reparavel" }
  | { tipo: "erro"; mensagem: string };

const SINAIS_DE_USO = ["conferente_id", "conferido_at", "efetivado_at", "efetivacao_lock_at"] as const;

/**
 * Lê a linha do `SELECT_TRIAGEM`. Contagem ilegível é ERRO, nunca zero (money-path: ausente ≠ zero);
 * sinal AUSENTE da resposta não é NULL comprovado → conta como em uso (não reparável = completo).
 */
export function triarCabecalho(linha: unknown): Triagem {
  if (linha === null || typeof linha !== "object" || Array.isArray(linha)) {
    return { tipo: "erro", mensagem: "cabeçalho em formato inesperado" };
  }
  const l = linha as Record<string, unknown>;
  const embutido = l.nfe_recebimento_itens;
  const bruto = Array.isArray(embutido) && embutido.length === 1 && embutido[0] && typeof embutido[0] === "object"
    ? (embutido[0] as Record<string, unknown>).count
    : undefined;
  const itens = inteiroNaoNegativo(bruto);
  if (itens === null) return { tipo: "erro", mensagem: "contagem de itens da NF-e indisponível" };
  if (itens > 0) return { tipo: "completo", itens };
  const emUso = SINAIS_DE_USO.some((c) => !(c in l) || l[c] !== null);
  if (l.status === "pendente" && !emUso) return { tipo: "reparavel" };
  return { tipo: "completo", itens: 0 };
}
