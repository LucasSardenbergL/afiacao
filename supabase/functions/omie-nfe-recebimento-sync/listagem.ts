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

/** Texto da `faultstring` do corpo, ou `null` quando o corpo não traz uma. */
function textoDaFalha(corpo: Record<string, unknown>): string | null {
  const fs = corpo.faultstring;
  return typeof fs === "string" && fs.trim() !== "" ? fs : null;
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

export type MotivoPulo = "sem_id" | "ja_importado" | "cancelado" | "recebido_no_omie" | "sem_chave";

export type Triagem =
  | { tipo: "pular"; motivo: MotivoPulo }
  /** `listagemMagra`: veio sem `infoCadastro` (o Omie ignorou `cExibirDetalhes`) — o detalhe decide. */
  | { tipo: "consultar"; nIdReceb: number; listagemMagra: boolean };

const sim = (v: unknown) => String(v ?? "").trim().toUpperCase() === "S";

/**
 * Decide se o registro merece a consulta de detalhe da rodada. A listagem COM detalhes decide
 * tudo (cancelada, recebida no Omie, sem chave); a listagem MAGRA só sabe o id, e aí a consulta
 * confere o resto, como antes.
 */
export function triarRegistro(rec: RegistroListagem, jaImportados: ReadonlySet<number>): Triagem {
  const cabec = rec.cabec ?? {};
  const id = Number(cabec.nIdReceb ?? rec.nIdReceb);
  if (!Number.isSafeInteger(id) || id <= 0) return { tipo: "pular", motivo: "sem_id" };
  if (jaImportados.has(id)) return { tipo: "pular", motivo: "ja_importado" };
  const info = rec.infoCadastro;
  if (!info) return { tipo: "consultar", nIdReceb: id, listagemMagra: true };
  if (sim(info.cCancelada)) return { tipo: "pular", motivo: "cancelado" };
  if (sim(info.cRecebido)) return { tipo: "pular", motivo: "recebido_no_omie" };
  if (normalizarChaveAcesso(cabec.cChaveNFe || cabec.cChaveNfe) === null) return { tipo: "pular", motivo: "sem_chave" };
  return { tipo: "consultar", nIdReceb: id, listagemMagra: false };
}

/**
 * O que a rodada viu numa conta — vai na resposta (`por_armazem`), que o `net._http_response`
 * guarda: é o sensor do cron. `aguardando` = candidatas além da consulta da rodada, a fila que o
 * cron horário drena; `listagem_magra` > 0 = o Omie não trouxe `infoCadastro`.
 */
export interface ContagemArmazem {
  listados: number;
  ja_importados: number;
  cancelados: number;
  recebidos_no_omie: number;
  sem_chave: number;
  sem_id: number;
  listagem_magra: number;
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
    sem_chave: 0,
    sem_id: 0,
    listagem_magra: 0,
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
  sem_chave: "sem_chave",
};

export function registrarPulo(contagem: ContagemArmazem, motivo: MotivoPulo): void {
  contagem[CAMPO_DO_PULO[motivo]]++;
}
