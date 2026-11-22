// Orquestração de UMA conta (injetável: db, fetch, relógio) — testes em reconciliar_test.ts.
//
// Ritmo (decisão do founder + Codex de desenho, 2026-11-21): por conta e por execução (cron de hora em hora),
//   · triagem: ≤ 2 janelas de inclusão (semana corrente + 1 do cursor) por ListarPedidos, coordenado com as
//     outras edges pela trava compartilhada (`comVezOmie`), sem retentativa de fault de cota;
//   · confirmação: ≤ 1 ConsultarPedido, e só quando o BANCO concede a vez (omie_pv_proxima_consulta impõe 1/h por
//     conta, o teto de ausências em 24h e o bloqueio registrado). Sem retentativa: cada tentativa conta para o
//     bloqueio de 30 min do Omie na 10ª requisição incorreta (incidente de 2026-11-21 18:53, Oben).
//   · 1º fault de cota (425 / consumo indevido / REDUNDANT) → registra o prazo na trava compartilhada e a conta PARA.
// A baixa em si é do banco (omie_pv_consulta_registrar), na 2ª ausência afirmada — esta camada só traz evidência.
import { chamarOmie, type RespostaOmie } from "../_shared/omie-cliente.ts";
import { type ClienteCota, classificarFaultCota, comVezOmie, CotaOmieIndisponivel, obterVez } from "../_shared/omie-cota.ts";
import { mensagemDeErro } from "../_shared/erro-mensagem.ts";
import { classificarConsulta, classificarErro, coletarJanela, type Consulta, faultDeCota } from "./decisao.ts";

export const OMIE_PEDIDO_URL = "https://app.omie.com.br/api/v1/produtos/pedido/";
export type Conta = "oben" | "colacor";

/** O mínimo do cliente Supabase que a orquestração usa (o mesmo da trava). */
export type Db = ClienteCota;

export interface Deps {
  db: Db;
  credenciais: { appKey: string; appSecret: string } | null;
  fetchImpl?: typeof fetch;
  /** Teto de páginas por janela (500 por página). */
  maxPaginas?: number;
}

export interface JanelaPedida { de: string; ate: string; tipo: "corrente" | "cursor" }

export type ResultadoJanela =
  | { tipo: JanelaPedida["tipo"]; de: string; ate: string; desfecho: "registrada"; resumo: unknown }
  | { tipo: JanelaPedida["tipo"]; de: string; ate: string; desfecho: "incompleta" | "recusada"; motivo: string };

export interface ResultadoConta {
  conta: Conta;
  janelas: ResultadoJanela[];
  consulta: { desfecho: string; detalhe?: unknown } | null;
  parou_por_cota: string | null;
  erro: string | null;
}

/** Data ISO (AAAA-MM-DD) → o formato do filtro do Omie (DD/MM/AAAA). */
export function dataOmie(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) throw new Error(`data inválida para o filtro do Omie: ${iso}`);
  return `${m[3]}/${m[2]}/${m[1]}`;
}

function lerJanelas(data: unknown): JanelaPedida[] {
  if (!Array.isArray(data)) throw new Error(`omie_pv_triagem_janelas sem lista: ${JSON.stringify(data)?.slice(0, 120)}`);
  return data.map((l) => {
    const r = l as Record<string, unknown>;
    if (typeof r.de !== "string" || typeof r.ate !== "string" || (r.tipo !== "corrente" && r.tipo !== "cursor")) {
      throw new Error(`omie_pv_triagem_janelas com linha fora do contrato: ${JSON.stringify(r).slice(0, 120)}`);
    }
    return { de: r.de, ate: r.ate, tipo: r.tipo };
  });
}

async function rpc(db: Db, nome: string, chamar: () => PromiseLike<{ data: unknown; error: { message: string } | null }>) {
  const { data, error } = await chamar();
  if (error) throw new Error(`${nome}: ${error.message}`);
  return data;
}

/** Fault de cota que a resposta trouxe, como texto para registrar — ou null. */
function cotaDe(r: RespostaOmie): string | null {
  return faultDeCota(r);
}

export async function reconciliarConta(conta: Conta, deps: Deps): Promise<ResultadoConta> {
  const out: ResultadoConta = { conta, janelas: [], consulta: null, parou_por_cota: null, erro: null };
  const { db } = deps;
  if (!deps.credenciais) {
    out.erro = `credenciais Omie da conta ${conta} ausentes`;
    return out;
  }
  const credenciais = deps.credenciais;

  // ── 1. Triagem por janela de inclusão ────────────────────────────────────────────────────────
  try {
    const janelas = lerJanelas(await rpc(db, "omie_pv_triagem_janelas", () =>
      db.rpc("omie_pv_triagem_janelas", { p_account: conta })));
    for (const j of janelas) {
      let cota: string | null = null;
      const janela = await coletarJanela(async (pagina) => {
        const r = await comVezOmie(db, conta, "ListarPedidos", () =>
          chamarOmie({
            url: OMIE_PEDIDO_URL,
            metodo: "ListarPedidos",
            param: {
              pagina,
              registros_por_pagina: 500,
              apenas_importado_api: "N",
              filtrar_apenas_inclusao: "S",
              filtrar_por_data_de: dataOmie(j.de),
              filtrar_por_data_ate: dataOmie(j.ate),
            },
            credenciais,
          }, { conta, maxTentativas: 2, fetchImpl: deps.fetchImpl }), cotaDe);
        cota = cotaDe(r);
        return r;
      }, deps.maxPaginas ?? 20);
      if (cota) {
        out.parou_por_cota = `ListarPedidos: ${String(cota).slice(0, 200)}`;
        out.janelas.push({ ...j, desfecho: "incompleta", motivo: "fault de cota" });
        return out;
      }
      if (!janela.completa) {
        // Janela incompleta não marca suspeito nenhum: o ausente seria "não li", não "não existe".
        out.janelas.push({ ...j, desfecho: "incompleta", motivo: janela.motivo });
        continue;
      }
      const { data, error } = await db.rpc("omie_pv_triagem_registrar", {
        p_account: conta, p_de: j.de, p_ate: j.ate, p_tipo: j.tipo, p_pids: janela.pids,
      });
      if (error) {
        // Disjuntor (RAISE) ou falha: nada foi gravado desta janela; segue para a próxima.
        out.janelas.push({ ...j, desfecho: "recusada", motivo: error.message.slice(0, 300) });
        continue;
      }
      out.janelas.push({ ...j, desfecho: "registrada", resumo: data });
    }
  } catch (e) {
    if (e instanceof CotaOmieIndisponivel) {
      out.parou_por_cota = e.message.slice(0, 300);
      return out;
    }
    out.erro = `triagem: ${(mensagemDeErro(e) ?? "erro").slice(0, 300)}`;
    // A confirmação não depende da triagem desta execução (o ledger já tem os suspeitos): segue.
  }

  // ── 2. Confirmação: no máximo UMA consulta, se o banco conceder a vez ──────────────────────────
  try {
    const vez = await rpc(db, "omie_pv_proxima_consulta", () =>
      db.rpc("omie_pv_proxima_consulta", { p_account: conta })) as Record<string, unknown> | null;
    const linha = Array.isArray(vez) ? vez[0] : vez;
    const logId = typeof linha?.log_id === "number" ? linha.log_id : null;
    const pid = typeof linha?.omie_pedido_id === "number" ? linha.omie_pedido_id : null;
    if (logId === null || pid === null) {
      out.consulta = { desfecho: "sem_vez", detalhe: linha?.motivo ?? null };
      return out;
    }

    let token: string;
    try {
      token = await obterVez(db, conta, "ConsultarPedido", { tetoEsperaMs: 0, tentativas: 1 });
    } catch (e) {
      // A vez do banco já foi gasta (fica no log); sem a trava compartilhada a chamada NÃO é feita.
      await registrarConsulta(db, logId, "indeterminado", { motivo: "trava_compartilhada", detalhe: mensagemDeErro(e) });
      out.consulta = { desfecho: "sem_trava", detalhe: mensagemDeErro(e) };
      if (e instanceof CotaOmieIndisponivel && e.motivo === "bloqueado") out.parou_por_cota = e.message.slice(0, 300);
      return out;
    }

    let consulta: Consulta;
    let cota: string | null = null;
    let devolver = true;
    try {
      const r = await chamarOmie({
        url: OMIE_PEDIDO_URL, metodo: "ConsultarPedido", param: { codigo_pedido: pid }, credenciais,
      }, { conta, maxTentativas: 1, fetchImpl: deps.fetchImpl });
      cota = cotaDe(r);
      consulta = classificarConsulta(r, pid);
    } catch (e) {
      consulta = classificarErro(mensagemDeErro(e) ?? "erro sem mensagem");
      cota = classificarFaultCota(mensagemDeErro(e) ?? "") ? (mensagemDeErro(e) ?? null) : null;
    }
    if (cota) {
      const f = classificarFaultCota(cota);
      const segundos = f && f.tipo !== "concorrente" ? f.segundos : 30 * 60;
      const { error } = await db.rpc("omie_cota_registrar_fault", {
        p_conta: conta, p_metodo: "ConsultarPedido", p_bloqueio_segundos: Math.max(1, Math.ceil(segundos)),
        p_fault: cota.slice(0, 300),
      });
      // Prazo não registrado: a vez fica retida e o lease faz as vezes do bloqueio.
      if (error) devolver = false;
      out.parou_por_cota = `ConsultarPedido: ${cota.slice(0, 200)}`;
    }
    if (devolver) {
      const { error } = await db.rpc("omie_cota_liberar", { p_conta: conta, p_metodo: "ConsultarPedido", p_token: token });
      if (error) console.warn(`[pv-exclusao][${conta}] liberar ConsultarPedido falhou (o lease vence sozinho): ${error.message}`);
    }

    const resultado = cota ? "bloqueado" : consulta.tipo;
    const detalhe = consulta.tipo === "existe"
      ? { etapa: consulta.etapa, cancelado: consulta.cancelado, numero_pedido: consulta.numeroPedido }
      : consulta.tipo === "ausente" ? { fault: consulta.fault } : { detalhe: consulta.detalhe };
    const reg = await registrarConsulta(db, logId, resultado, detalhe);
    out.consulta = { desfecho: resultado, detalhe: { omie_pedido_id: pid, registro: reg } };
  } catch (e) {
    out.erro = [out.erro, `consulta: ${(mensagemDeErro(e) ?? "erro").slice(0, 300)}`].filter(Boolean).join(" · ");
  }
  return out;
}

async function registrarConsulta(db: Db, logId: number, resultado: string, detalhe: unknown): Promise<unknown> {
  return await rpc(db, "omie_pv_consulta_registrar", () =>
    db.rpc("omie_pv_consulta_registrar", { p_log_id: logId, p_resultado: resultado, p_detalhe: detalhe ?? {} }));
}
