// Orquestração de UMA conta (injetável: db, fetch) — testes em reconciliar_test.ts.
//
// Ritmo (founder + Codex de desenho rodada 2, 2026-11-21) — TODO teto é imposto no BANCO, esta camada só pede a vez:
//   · execução: ≤ 1 por conta a cada 50 min, presa à identidade da credencial (hash da app_key);
//   · ListarPedidos: ≤ 6 chamadas físicas por conta em 60 min (`omie_pv_listar_vez` antes de CADA página), 100 por
//     página, SEM retentativa, coordenado com as outras edges pela trava compartilhada (`comVezOmie`);
//   · ConsultarPedido: ≤ 1 por conta em 60 min e ≤ 4 tentativas cobradas em 24h (`omie_pv_proxima_consulta`), SEM
//     retentativa — cada tentativa conta para o bloqueio de 30 min do Omie na 10ª requisição incorreta (incidente de
//     2026-11-21 18:53, Oben);
//   · 1º fault de cota (425/429/consumo indevido/REDUNDANT) → prazo registrado na trava compartilhada, a conta PARA.
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
  /** Relógio da conta (epoch ms): toda chamada ao Omie divide ESTE prazo (cron dá 150 s para as duas contas). */
  deadline?: number;
}

export interface JanelaPedida { de: string; ate: string; tipo: "corrente" | "cursor" }

export type ResultadoJanela =
  | { tipo: JanelaPedida["tipo"]; de: string; ate: string; desfecho: "registrada"; resumo: unknown }
  | { tipo: JanelaPedida["tipo"]; de: string; ate: string; desfecho: "incompleta" | "recusada"; motivo: string };

export interface ResultadoConta {
  conta: Conta;
  execucao: string;
  janelas: ResultadoJanela[];
  consulta: { desfecho: string; detalhe?: unknown } | null;
  parou_por_cota: string | null;
  erro: string | null;
}

/** Bloqueio sem prazo legível: o Omie documenta ~30 min. */
const BLOQUEIO_PADRAO = "API bloqueada por consumo indevido (HTTP 425 sem prazo legível)";

/** Data ISO (AAAA-MM-DD) → o formato do filtro do Omie (DD/MM/AAAA). */
export function dataOmie(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) throw new Error(`data inválida para o filtro do Omie: ${iso}`);
  return `${m[3]}/${m[2]}/${m[1]}`;
}

/** Identidade da credencial SEM o segredo: 32 hex do sha-256 da app_key. */
export async function hashAppKey(appKey: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(appKey));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

/**
 * Texto de cota para a trava compartilhada registrar. Um 425/429 cujo corpo não tem o texto do bloqueio (ex.: corpo de
 * EOF) ainda é bloqueio: sem isto `comVezOmie` não o registraria (Codex rodada 2, P0-1).
 */
export function textoDeCota(r: RespostaOmie): string | null {
  const t = faultDeCota(r);
  if (t === null) return null;
  const f = classificarFaultCota(t);
  // 425/429 vence o texto: "requisição concorrente" com status de bloqueio é bloqueio (a trava não registra o
  // concorrente, e a outra edge entraria na hora — Codex código P1).
  if ((r.status === 425 || r.status === 429) && (f === null || f.tipo === "concorrente")) return BLOQUEIO_PADRAO;
  return f ? t : BLOQUEIO_PADRAO;
}

/** Timeout/abort do fetch: o Omie pode seguir processando — `comVezOmie` só retém a vez para DOMException. */
function comoTimeout(e: unknown): unknown {
  const msg = mensagemDeErro(e) ?? "";
  return /timeout|abort|prazo|sem tempo/i.test(msg) && !(e instanceof DOMException) ? new DOMException(msg, "TimeoutError") : e;
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

function primeiraLinha(data: unknown): Record<string, unknown> | null {
  const l = Array.isArray(data) ? data[0] : data;
  return l && typeof l === "object" ? l as Record<string, unknown> : null;
}

async function rpc(nome: string, chamar: () => PromiseLike<{ data: unknown; error: { message: string } | null }>) {
  const { data, error } = await chamar();
  if (error) throw new Error(`${nome}: ${error.message}`);
  return data;
}

/** Resposta sintética de "a chamada NÃO foi feita" (orçamento esgotado): a janela termina incompleta. */
const NAO_FEITA: RespostaOmie = { status: 0, ok: false, texto: "", corpo: null, faultstring: null, faultcode: null };

export async function reconciliarConta(conta: Conta, deps: Deps): Promise<ResultadoConta> {
  const out: ResultadoConta = { conta, execucao: "nao_iniciada", janelas: [], consulta: null, parou_por_cota: null, erro: null };
  const { db } = deps;
  if (!deps.credenciais) {
    out.erro = `credenciais Omie da conta ${conta} ausentes`;
    return out;
  }
  const credenciais = deps.credenciais;

  // ── 0. Execução: identidade da credencial + cadência (banco) ─────────────────────────────────────
  const appHash = await hashAppKey(credenciais.appKey);
  const ini = primeiraLinha(await rpc("omie_pv_execucao_iniciar", () =>
    db.rpc("omie_pv_execucao_iniciar", { p_account: conta, p_app_hash: appHash })));
  const execucaoId = typeof ini?.execucao_id === "number" ? ini.execucao_id : null;
  out.execucao = typeof ini?.motivo === "string" ? ini.motivo : "sem_motivo";
  if (execucaoId === null) return out;

  try {
    await triagem(conta, execucaoId, credenciais, deps, out);
    // Triagem que falhou pode ter perdido uma PRESENÇA no meio (Codex código P0-3): sem confirmação nesta execução.
    if (out.parou_por_cota === null && out.erro === null) await confirmacao(conta, execucaoId, credenciais, deps, out);
  } finally {
    const { error } = await db.rpc("omie_pv_execucao_encerrar", {
      p_execucao_id: execucaoId,
      p_resumo: { janelas: out.janelas, consulta: out.consulta, parou_por_cota: out.parou_por_cota, erro: out.erro },
    });
    if (error) console.warn(`[pv-exclusao][${conta}] encerrar execução falhou: ${error.message}`);
  }
  return out;
}

// ── 1. Triagem por janela de inclusão ────────────────────────────────────────────────────────────
async function triagem(
  conta: Conta, execucaoId: number, credenciais: { appKey: string; appSecret: string }, deps: Deps, out: ResultadoConta,
): Promise<void> {
  const { db } = deps;
  try {
    const janelas = lerJanelas(await rpc("omie_pv_triagem_janelas", () =>
      db.rpc("omie_pv_triagem_janelas", { p_account: conta })));
    for (const j of janelas) {
      let cota: string | null = null;
      let semOrcamento = false;
      const janela = await coletarJanela(async (pagina) => {
        const vez = await rpc("omie_pv_listar_vez", () => db.rpc("omie_pv_listar_vez", { p_execucao_id: execucaoId }));
        if (vez !== true) {
          semOrcamento = true;
          return NAO_FEITA;
        }
        const r = await comVezOmie(db, conta, "ListarPedidos", () =>
          chamarOmie({
            url: OMIE_PEDIDO_URL,
            metodo: "ListarPedidos",
            param: {
              pagina,
              registros_por_pagina: 100,
              apenas_importado_api: "N",
              filtrar_apenas_inclusao: "S",
              filtrar_por_data_de: dataOmie(j.de),
              filtrar_por_data_ate: dataOmie(j.ate),
            },
            credenciais,
          }, { conta, maxTentativas: 1, fetchImpl: deps.fetchImpl, deadline: deps.deadline }).catch((e) => {
            throw comoTimeout(e);
          }), textoDeCota);
        cota = textoDeCota(r);
        return r;
      }, 6, async (pids) => {
        // Presença vista é fato, mesmo que a janela não feche (Codex rodada 2, P0-2).
        if (pids.length > 0) {
          await rpc("omie_pv_presenca_registrar", () =>
            db.rpc("omie_pv_presenca_registrar", { p_execucao_id: execucaoId, p_pids: pids }));
        }
      });
      if (cota) {
        out.parou_por_cota = `ListarPedidos: ${String(cota).slice(0, 200)}`;
        out.janelas.push({ ...j, desfecho: "incompleta", motivo: "fault de cota" });
        return;
      }
      if (!janela.completa) {
        // Janela incompleta não marca suspeito nenhum: o ausente seria "não li", não "não existe".
        out.janelas.push({ ...j, desfecho: "incompleta", motivo: semOrcamento ? "orçamento de listagem esgotado" : janela.motivo });
        if (semOrcamento) return;
        continue;
      }
      const resumo = await rpc("omie_pv_triagem_registrar", () => db.rpc("omie_pv_triagem_registrar", {
        p_execucao_id: execucaoId, p_de: j.de, p_ate: j.ate, p_tipo: j.tipo, p_pids: janela.pids,
      })) as Record<string, unknown> | null;
      if (resumo && typeof resumo.recusa === "string") {
        out.janelas.push({ ...j, desfecho: "recusada", motivo: resumo.recusa });
        continue;
      }
      out.janelas.push({ ...j, desfecho: "registrada", resumo });
    }
  } catch (e) {
    if (e instanceof CotaOmieIndisponivel) {
      out.parou_por_cota = e.message.slice(0, 300);
      return;
    }
    out.erro = `triagem: ${(mensagemDeErro(e) ?? "erro").slice(0, 300)}`;
    // A confirmação não depende da triagem desta execução (o banco exige a identidade confirmada): segue.
  }
}

// ── 2. Confirmação: no máximo UMA consulta, se o banco conceder a vez ─────────────────────────────
async function confirmacao(
  conta: Conta, execucaoId: number, credenciais: { appKey: string; appSecret: string }, deps: Deps, out: ResultadoConta,
): Promise<void> {
  const { db } = deps;
  try {
    const linha = primeiraLinha(await rpc("omie_pv_proxima_consulta", () =>
      db.rpc("omie_pv_proxima_consulta", { p_execucao_id: execucaoId })));
    const logId = typeof linha?.log_id === "number" ? linha.log_id : null;
    const pid = typeof linha?.omie_pedido_id === "number" ? linha.omie_pedido_id : null;
    if (logId === null || pid === null) {
      out.consulta = { desfecho: "sem_vez", detalhe: linha?.motivo ?? null };
      return;
    }

    let token: string;
    try {
      token = await obterVez(db, conta, "ConsultarPedido", { tetoEsperaMs: 0, tentativas: 1 });
    } catch (e) {
      // Sem a trava compartilhada a chamada NÃO é feita — e a tentativa não é cobrada.
      await registrarConsulta(db, logId, "nao_enviada", { motivo: "trava_compartilhada", detalhe: mensagemDeErro(e) });
      out.consulta = { desfecho: "nao_enviada", detalhe: mensagemDeErro(e) };
      if (e instanceof CotaOmieIndisponivel && e.motivo === "bloqueado") out.parou_por_cota = e.message.slice(0, 300);
      return;
    }

    let consulta: Consulta;
    let cota: string | null = null;
    let devolver = true;
    try {
      const r = await chamarOmie({
        url: OMIE_PEDIDO_URL, metodo: "ConsultarPedido", param: { codigo_pedido: pid }, credenciais,
      }, { conta, maxTentativas: 1, fetchImpl: deps.fetchImpl, deadline: deps.deadline });
      cota = textoDeCota(r);
      consulta = classificarConsulta(r, pid);
    } catch (e) {
      const msg = mensagemDeErro(e) ?? "erro sem mensagem";
      consulta = classificarErro(msg);
      cota = classificarFaultCota(msg) ? msg : null;
      // Timeout: o Omie pode seguir processando — não devolver a vez (o lease vence sozinho).
      if (/timeout|abort/i.test(msg)) devolver = false;
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
}

/** Registra o resultado; deadlock com outro escritor (ATP/sync) desfaz a transação inteira → repete o MESMO log_id. */
async function registrarConsulta(db: Db, logId: number, resultado: string, detalhe: unknown): Promise<unknown> {
  for (let tentativa = 1; ; tentativa++) {
    const { data, error } = await db.rpc("omie_pv_consulta_registrar", { p_log_id: logId, p_resultado: resultado, p_detalhe: detalhe ?? {} });
    if (!error) return data;
    const codigo = (error as { code?: unknown }).code;
    const repetivel = codigo === "40P01" || codigo === "40001" || /deadlock|40P01|40001|serializ|impasse/i.test(error.message);
    if (tentativa >= 3 || !repetivel) {
      throw new Error(`omie_pv_consulta_registrar: ${error.message}`);
    }
    await new Promise((r) => setTimeout(r, 200 * tentativa));
  }
}
