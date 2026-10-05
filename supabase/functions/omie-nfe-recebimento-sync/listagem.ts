// Triagem da listagem do cron da `omie-nfe-recebimento-sync`: decide quem gasta a ÚNICA consulta de
// detalhe da rodada (`MAX_DETAIL_CALLS=1` — a trava anti-redundância do Omie morde o método por conta).
//
// Lógica PURA (sem rede, sem banco) para caber no `--no-remote` do `test:edges`. Testes em
// listagem_test.ts.
//
// POR QUE EXISTE (2026-10-01): de 14/08 em diante o Omie da Oben teve 70 recebimentos — lidos pela
// `omie-sync-nfes-recebidas` no MESMO endpoint — e esta sync importou ZERO, com `success:true` em
// toda rodada. A listagem não pedia `cExibirDetalhes:'S'`, e sem ele o Omie não devolve
// `infoCadastro` (provado na `omie-nfe-reconcile` em 2026-07-17): "recebida no Omie", "cancelada" e
// "sem chave" só apareciam DEPOIS da consulta de detalhe, e o pulo não ficava registrado. A mesma
// NF-e do topo da listagem gastava a consulta de TODA rodada — e metade das NF-e da Oben o time
// recebe direto no Omie. Já a falha que o Omie devolve como corpo com HTTP 200 (`faultstring`)
// virava "listagem vazia" ou "sem chave", calada.

import { classificarFaultstring, redigirSegredo } from "../_shared/omie-falha.ts";
import { normalizarChaveAcesso } from "./chave.ts";
import { estadoNoOmie } from "./estado.ts";

/** Registro da `ListarRecebimentos` — só o que a triagem lê. */
export interface RegistroListagem {
  nIdReceb?: number | string;
  cabec?: {
    nIdReceb?: number | string;
    cChaveNFe?: string | null;
    cChaveNfe?: string | null;
  };
  infoCadastro?: { cCancelada?: string; cRecebido?: string };
}

/**
 * Parâmetros da `ListarRecebimentos`. `cExibirDetalhes:'S'` traz `infoCadastro` e a chave já na
 * listagem; `cOrdenarPor:'CODIGO'` dá ordem estável. Os dois vêm da `omie-sync-nfes-recebidas`, a
 * leitura do mesmo endpoint que enxerga a Oben.
 */
export function paramsListagem(pagina: number, dtEmissaoDe: string): Record<string, unknown> {
  return {
    nPagina: pagina,
    nRegistrosPorPagina: 50,
    cOrdenarPor: "CODIGO",
    dtEmissaoDe,
    cExibirDetalhes: "S",
  };
}

export type PaginaListagem =
  | { tipo: "registros"; registros: RegistroListagem[]; totalPaginas: number | undefined }
  | { tipo: "fim" }
  | { tipo: "falha"; mensagem: string };

function comoRegistro(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/**
 * Texto da falha do corpo — a `faultstring` ou, sem ela, o `faultcode` (um corpo só com `faultcode`
 * passava como lista vazia: revisão do Codex, 2026-10-05) —, ou `null` quando o corpo não é falha.
 */
function textoDaFalha(corpo: Record<string, unknown>): string | null {
  for (const campo of [corpo.faultstring, corpo.faultcode]) {
    if (typeof campo === "string" && campo.trim() !== "") return campo;
  }
  return null;
}

/**
 * Lê o corpo de UMA página. O corpo decide antes do status: o Omie devolve falha como
 * `faultstring` com HTTP 200. "Não existem registros para a página" é fim; qualquer outra é falha,
 * com o texto redigido — a falha de credencial do Omie ecoa a app_key.
 */
export function interpretarPaginaListagem(corpo: unknown): PaginaListagem {
  const c = comoRegistro(corpo);
  if (!c) return { tipo: "falha", mensagem: "a listagem não respondeu um objeto JSON" };
  const falha = textoDaFalha(c);
  if (falha !== null) {
    return classificarFaultstring(falha) === "fim_de_pagina"
      ? { tipo: "fim" }
      : { tipo: "falha", mensagem: redigirSegredo(falha) };
  }
  const registros = Array.isArray(c.recebimentos) ? (c.recebimentos as RegistroListagem[]) : [];
  return { tipo: "registros", registros, totalPaginas: c.nTotalPaginas as number | undefined };
}

/** Falha que o Omie devolve no corpo do `ConsultarRecebimento` (HTTP 200), já redigida. `null` = sem falha. */
export function falhaNoCorpo(corpo: unknown): string | null {
  const c = comoRegistro(corpo);
  if (!c) return "o detalhe não respondeu um objeto JSON";
  const falha = textoDaFalha(c);
  return falha === null ? null : redigirSegredo(falha);
}

/**
 * Corpo de uma resposta NÃO-2xx do Omie quando ele traz `faultstring`: o Omie manda o "não existem
 * registros para a página" (fim de listagem) e falhas de negócio com HTTP 500 — visto em prod em
 * 2026-10-05, conta CC, `faultcode` SOAP-ENV:Client-5113. Volta ao chamador, que classifica; `null`
 * = não é corpo de falha do Omie (HTML de gateway, texto solto), e aí é falha de transporte.
 */
export function corpoDeFalhaOmie(texto: string): Record<string, unknown> | null {
  try {
    const c = comoRegistro(JSON.parse(texto));
    return c !== null && textoDaFalha(c) !== null ? c : null;
  } catch {
    return null;
  }
}

/** Id e chave de um registro da listagem; `null` onde o Omie não deu valor utilizável. */
export function identidadeDoRegistro(rec: RegistroListagem): { id: number | null; chave: string | null } {
  const cabec = rec.cabec ?? {};
  const id = Number(cabec.nIdReceb ?? rec.nIdReceb);
  return {
    id: Number.isSafeInteger(id) && id > 0 ? id : null,
    chave: normalizarChaveAcesso(cabec.cChaveNFe || cabec.cChaveNfe),
  };
}

/** O que já está em `nfe_recebimentos`: ids desta conta e chaves (a chave é única no banco). */
export interface JaImportados {
  ids: ReadonlySet<number>;
  chaves: ReadonlySet<string>;
}

export type MotivoPulo = "sem_id" | "ja_importado" | "cancelado" | "recebido_no_omie";

/**
 * Por que a candidata é INCOMPLETA: a listagem não deu o bastante para decidir sem a consulta —
 * `listagem_magra` = sem estado utilizável (sem `infoCadastro`, ou sem os "N" explícitos);
 * `chave_na_listagem` = aberta, mas sem chave legível.
 */
export type Incompleta = "listagem_magra" | "chave_na_listagem";

export type Triagem =
  | { tipo: "pular"; motivo: MotivoPulo }
  | { tipo: "consultar"; nIdReceb: number; incompleta: Incompleta | null };

/**
 * Decide se o registro merece a consulta de detalhe da rodada. Só PULA com evidência da própria
 * listagem: já importada (pelo id ou pela chave), cancelada ou recebida no Omie. O que a listagem
 * não diz não é descartado — vai à consulta como INCOMPLETA (estado desconhecido, ou sem chave
 * legível: a presença de `infoCadastro` não prova que o cabeçalho veio inteiro).
 */
export function triarRegistro(rec: RegistroListagem, ja: JaImportados): Triagem {
  const { id, chave } = identidadeDoRegistro(rec);
  if (id === null) return { tipo: "pular", motivo: "sem_id" };
  if (ja.ids.has(id) || (chave !== null && ja.chaves.has(chave))) return { tipo: "pular", motivo: "ja_importado" };
  const estado = estadoNoOmie(rec.infoCadastro);
  if (estado === "cancelado" || estado === "recebido_no_omie") return { tipo: "pular", motivo: estado };
  if (estado === "desconhecido") return { tipo: "consultar", nIdReceb: id, incompleta: "listagem_magra" };
  if (chave === null) return { tipo: "consultar", nIdReceb: id, incompleta: "chave_na_listagem" };
  return { tipo: "consultar", nIdReceb: id, incompleta: null };
}

/**
 * O que a triagem viu numa conta. `aguardando` = candidatas além da consulta da rodada (a fila que
 * o cron horário drena); `listagem_magra` > 0 = o Omie não trouxe `infoCadastro`;
 * `sem_chave_na_listagem` = candidatas que só a consulta resolve.
 */
export interface ContagemArmazem {
  listados: number;
  ja_importados: number;
  cancelados: number;
  recebidos_no_omie: number;
  sem_id: number;
  listagem_magra: number;
  sem_chave_na_listagem: number;
  aguardando: number;
  consultados: number;
  importados: number;
}

export function contagemVazia(): ContagemArmazem {
  return {
    listados: 0,
    ja_importados: 0,
    cancelados: 0,
    recebidos_no_omie: 0,
    sem_id: 0,
    listagem_magra: 0,
    sem_chave_na_listagem: 0,
    aguardando: 0,
    consultados: 0,
    importados: 0,
  };
}

const CAMPO_DO_PULO: Record<MotivoPulo, keyof ContagemArmazem> = {
  sem_id: "sem_id",
  ja_importado: "ja_importados",
  cancelado: "cancelados",
  recebido_no_omie: "recebidos_no_omie",
};

export function registrarPulo(contagem: ContagemArmazem, motivo: MotivoPulo): void {
  contagem[CAMPO_DO_PULO[motivo]]++;
}
