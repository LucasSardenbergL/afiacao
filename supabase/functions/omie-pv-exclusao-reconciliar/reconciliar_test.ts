// `assertEquals` local em vez de std/assert remoto: `test:edges` roda com `--no-remote`.
function assertEquals(atual: unknown, esperado: unknown) {
  const a = JSON.stringify(atual);
  const e = JSON.stringify(esperado);
  if (a !== e) throw new Error(`esperado ${e}, veio ${a}`);
}
import { dataOmie, type Db, reconciliarConta } from "./reconciliar.ts";

const PID = 12156020937;
const CRED = { appKey: "k", appSecret: "s" };

interface ChamadaRpc { fn: string; args: Record<string, unknown> }

/** Banco falso: responde as RPCs pelo nome e grava tudo o que foi chamado. */
function dbFalso(respostas: Record<string, (args: Record<string, unknown>) => { data: unknown; error: { message: string } | null }>) {
  const chamadas: ChamadaRpc[] = [];
  const db: Db = {
    rpc(fn: string, args: Record<string, unknown>) {
      chamadas.push({ fn, args });
      const r = respostas[fn];
      return Promise.resolve(r ? r(args) : { data: null, error: { message: `rpc ${fn} não esperada no teste` } });
    },
  };
  return { db, chamadas };
}

const vezLivre = () => ({ data: [{ ok: true, motivo: "livre", ate: null }], error: null });
const base = {
  omie_cota_tentar: vezLivre,
  omie_cota_liberar: () => ({ data: null, error: null }),
  omie_cota_registrar_fault: () => ({ data: null, error: null }),
  omie_pv_execucao_iniciar: () => ({ data: [{ execucao_id: 42, motivo: "iniciada" }], error: null }),
  omie_pv_listar_vez: () => ({ data: true, error: null }),
  omie_pv_presenca_registrar: () => ({ data: { presencas: 0 }, error: null }),
  omie_pv_execucao_encerrar: () => ({ data: null, error: null }),
  omie_pv_triagem_janelas: () => ({
    data: [{ de: "2026-11-16", ate: "2026-11-21", tipo: "corrente" }, { de: "2025-03-03", ate: "2025-03-09", tipo: "cursor" }],
    error: null,
  }),
  omie_pv_triagem_registrar: () => ({ data: { suspeitos: 0 }, error: null }),
  omie_pv_proxima_consulta: () => ({ data: [{ log_id: 7, omie_pedido_id: PID, motivo: "concedida" }], error: null }),
  omie_pv_consulta_registrar: () => ({ data: { efeito: "ok" }, error: null }),
};

/** fetch falso: uma resposta por chamada, na ordem; grava o método de cada uma. */
function fetchFalso(respostas: Array<{ status: number; corpo: unknown }>) {
  const metodos: string[] = [];
  const f = ((_url: string | URL | Request, init?: RequestInit) => {
    const corpo = JSON.parse(String(init?.body ?? "{}")) as { call: string };
    metodos.push(corpo.call);
    const r = respostas.shift();
    if (!r) return Promise.reject(new Error("fetch além do roteiro do teste"));
    return Promise.resolve(new Response(JSON.stringify(r.corpo), { status: r.status }));
  }) as typeof fetch;
  return { f, metodos };
}

const pagina = (pids: number[]) => ({
  status: 200,
  corpo: { pagina: 1, total_de_paginas: 1, registros: pids.length, total_de_registros: pids.length,
           pedido_venda_produto: pids.map((p) => ({ cabecalho: { codigo_pedido: p } })) },
});
const EOF = { status: 500, corpo: { faultstring: "ERROR: Não existem registros para a página [2]!", faultcode: "SOAP-ENV:Client-5113" } };
const FAULT_AUSENTE = { status: 500, corpo: { faultstring: `ERROR: Pedido não cadastrado para o Código [${PID}] !`, faultcode: "SOAP-ENV:Client-103" } };
const FAULT_425 = { status: 425, corpo: { faultstring: "API bloqueada por consumo indevido. Tente novamente em 1799 segundos.", faultcode: "MISUSE_API_PROCESS" } };

Deno.test("dataOmie: ISO → DD/MM/AAAA; lixo lança", () => {
  assertEquals(dataOmie("2026-01-05"), "05/01/2026");
  let lancou = "";
  try { dataOmie("05/01/2026"); } catch (e) { lancou = (e as Error).message; }
  assertEquals(lancou.startsWith("data inválida para o filtro do Omie"), true);
});

Deno.test("fluxo feliz: 2 janelas completas registradas, 1 consulta ausente registrada com o log_id", async () => {
  const { db, chamadas } = dbFalso(base);
  const { f, metodos } = fetchFalso([pagina([1, 2]), EOF, pagina([3]), EOF, FAULT_AUSENTE]);
  const r = await reconciliarConta("oben", { db, credenciais: CRED, fetchImpl: f });
  assertEquals(metodos, ["ListarPedidos", "ListarPedidos", "ListarPedidos", "ListarPedidos", "ConsultarPedido"]);
  assertEquals(r.janelas.map((j) => j.desfecho), ["registrada", "registrada"]);
  const reg = chamadas.filter((c) => c.fn === "omie_pv_triagem_registrar").map((c) => c.args.p_pids);
  assertEquals(reg, [[1, 2], [3]]);
  const cons = chamadas.find((c) => c.fn === "omie_pv_consulta_registrar");
  assertEquals(cons?.args.p_log_id, 7);
  assertEquals(cons?.args.p_resultado, "ausente");
  assertEquals(r.parou_por_cota, null);
  assertEquals(r.erro, null);
});

Deno.test("filtro do Omie: inclusão S + datas DD/MM/AAAA da janela", async () => {
  const { db } = dbFalso(base);
  const corpos: Record<string, unknown>[] = [];
  const f = ((_u: string | URL | Request, init?: RequestInit) => {
    const c = JSON.parse(String(init?.body)) as { call: string; param: Record<string, unknown>[] };
    corpos.push(c.param[0]);
    return Promise.resolve(new Response(JSON.stringify(c.call === "ListarPedidos" ? pagina([]).corpo : FAULT_AUSENTE.corpo),
      { status: c.call === "ListarPedidos" ? 200 : 500 }));
  }) as typeof fetch;
  await reconciliarConta("oben", { db, credenciais: CRED, fetchImpl: f });
  assertEquals(corpos[0].filtrar_apenas_inclusao, "S");
  assertEquals(corpos[0].filtrar_por_data_de, "16/11/2026");
  assertEquals(corpos[0].filtrar_por_data_ate, "21/11/2026");
  assertEquals(corpos[1].filtrar_por_data_de, "03/03/2025");
});

Deno.test("janela INCOMPLETA (total declarado > lidos) não registra suspeito nenhum", async () => {
  const { db, chamadas } = dbFalso(base);
  const truncada = { status: 200, corpo: { ...pagina([1]).corpo, total_de_registros: 5 } };
  const { f } = fetchFalso([truncada, EOF, pagina([3]), EOF, FAULT_AUSENTE]);
  const r = await reconciliarConta("oben", { db, credenciais: CRED, fetchImpl: f });
  assertEquals(r.janelas[0].desfecho, "incompleta");
  const reg = chamadas.filter((c) => c.fn === "omie_pv_triagem_registrar").map((c) => c.args.p_tipo);
  assertEquals(reg, ["cursor"]);
});

Deno.test("janela com resposta 5xx não registra (página não-final ≠ fim)", async () => {
  const { db, chamadas } = dbFalso(base);
  const { f } = fetchFalso([{ status: 502, corpo: {} }, pagina([3]), EOF, FAULT_AUSENTE]);
  const r = await reconciliarConta("oben", { db, credenciais: CRED, fetchImpl: f });
  assertEquals(r.janelas[0].desfecho, "incompleta");
  assertEquals(chamadas.filter((c) => c.fn === "omie_pv_triagem_registrar").length, 1);
});

Deno.test("425 na CONSULTA: registra o bloqueio na trava compartilhada, NÃO devolve como ausência, conta para", async () => {
  const { db, chamadas } = dbFalso(base);
  const { f, metodos } = fetchFalso([pagina([1]), EOF, pagina([2]), EOF, FAULT_425]);
  const r = await reconciliarConta("oben", { db, credenciais: CRED, fetchImpl: f });
  assertEquals(metodos.filter((m) => m === "ConsultarPedido").length, 1);
  const fault = chamadas.find((c) => c.fn === "omie_cota_registrar_fault");
  assertEquals(fault?.args.p_metodo, "ConsultarPedido");
  assertEquals(Number(fault?.args.p_bloqueio_segundos) >= 1799, true);
  assertEquals(chamadas.find((c) => c.fn === "omie_pv_consulta_registrar")?.args.p_resultado, "bloqueado");
  assertEquals(r.parou_por_cota?.startsWith("ConsultarPedido"), true);
});

Deno.test("425 na LISTAGEM: registra para todas as edges e a conta para (nem consulta)", async () => {
  const { db, chamadas } = dbFalso(base);
  const { f, metodos } = fetchFalso([FAULT_425]);
  const r = await reconciliarConta("oben", { db, credenciais: CRED, fetchImpl: f });
  assertEquals(metodos, ["ListarPedidos"]);
  assertEquals(chamadas.find((c) => c.fn === "omie_cota_registrar_fault")?.args.p_metodo, "ListarPedidos");
  assertEquals(chamadas.some((c) => c.fn === "omie_pv_proxima_consulta"), false);
  assertEquals(chamadas.some((c) => c.fn === "omie_pv_triagem_registrar"), false);
  assertEquals(r.parou_por_cota !== null, true);
});

Deno.test("trava compartilhada BLOQUEADA: nenhuma chamada ao Omie", async () => {
  const { db } = dbFalso({ ...base, omie_cota_tentar: () => ({ data: [{ ok: false, motivo: "bloqueado", ate: "2099-01-01T00:00:00Z" }], error: null }) });
  const { f, metodos } = fetchFalso([]);
  const r = await reconciliarConta("oben", { db, credenciais: CRED, fetchImpl: f });
  assertEquals(metodos, []);
  assertEquals(r.parou_por_cota !== null, true);
});

Deno.test("banco nega a vez de consulta: nenhuma ConsultarPedido", async () => {
  const { db, chamadas } = dbFalso({ ...base, omie_pv_proxima_consulta: () => ({ data: [{ log_id: null, omie_pedido_id: null, motivo: "aguardando_vez" }], error: null }) });
  const { f, metodos } = fetchFalso([pagina([1]), EOF, pagina([2]), EOF]);
  const r = await reconciliarConta("oben", { db, credenciais: CRED, fetchImpl: f });
  assertEquals(metodos, ["ListarPedidos", "ListarPedidos", "ListarPedidos", "ListarPedidos"]);
  assertEquals(r.consulta?.desfecho, "sem_vez");
  assertEquals(chamadas.some((c) => c.fn === "omie_pv_consulta_registrar"), false);
});

Deno.test("disjuntor do banco (RAISE) vira janela recusada e a consulta segue", async () => {
  const { db } = dbFalso({ ...base, omie_pv_triagem_registrar: () => ({ data: { recusa: "disjuntor_suspeitos" }, error: null }) });
  const { f } = fetchFalso([pagina([1]), EOF, pagina([2]), EOF, FAULT_AUSENTE]);
  const r = await reconciliarConta("oben", { db, credenciais: CRED, fetchImpl: f });
  assertEquals(r.janelas.map((j) => j.desfecho), ["recusada", "recusada"]);
  assertEquals(r.consulta?.desfecho, "ausente");
});

Deno.test("resposta do Omie de OUTRO PV na consulta = indeterminado (nunca existe/ausente)", async () => {
  const { db, chamadas } = dbFalso(base);
  const { f } = fetchFalso([pagina([1]), EOF, pagina([2]), EOF, { status: 200, corpo: { pedido_venda_produto: { cabecalho: { codigo_pedido: 1 } } } }]);
  await reconciliarConta("oben", { db, credenciais: CRED, fetchImpl: f });
  assertEquals(chamadas.find((c) => c.fn === "omie_pv_consulta_registrar")?.args.p_resultado, "indeterminado");
});

Deno.test("sem credenciais: nada é chamado", async () => {
  const { db, chamadas } = dbFalso(base);
  const { f, metodos } = fetchFalso([]);
  const r = await reconciliarConta("colacor", { db, credenciais: null, fetchImpl: f });
  assertEquals(metodos, []);
  assertEquals(chamadas, []);
  assertEquals(r.execucao, "nao_iniciada");
  assertEquals(r.erro?.includes("credenciais"), true);
});

// ── contrato novo (Codex de desenho rodada 2) ─────────────────────────────────────────────────────
Deno.test("execução negada pelo banco (identidade/cadência): nenhuma chamada ao Omie", async () => {
  for (const motivo of ["identidade_divergente", "identidade_de_outra_conta", "execucao_recente"]) {
    const { db, chamadas } = dbFalso({ ...base, omie_pv_execucao_iniciar: () => ({ data: [{ execucao_id: null, motivo }], error: null }) });
    const { f, metodos } = fetchFalso([]);
    const r = await reconciliarConta("oben", { db, credenciais: CRED, fetchImpl: f });
    assertEquals(metodos, []);
    assertEquals(r.execucao, motivo);
    assertEquals(chamadas.map((c) => c.fn), ["omie_pv_execucao_iniciar"]);
  }
});

Deno.test("identidade vai como hash de 32 hex, nunca a app_key", async () => {
  const { db, chamadas } = dbFalso(base);
  const { f } = fetchFalso([pagina([1]), EOF, pagina([2]), EOF, FAULT_AUSENTE]);
  await reconciliarConta("oben", { db, credenciais: { appKey: "chave-secreta-123", appSecret: "s" }, fetchImpl: f });
  const h = String(chamadas[0].args.p_app_hash);
  assertEquals(/^[0-9a-f]{32}$/.test(h), true);
  assertEquals(JSON.stringify(chamadas).includes("chave-secreta-123"), false);
});

Deno.test("orçamento de listagem esgotado: a chamada NÃO sai e a janela fica incompleta", async () => {
  let n = 0;
  const { db, chamadas } = dbFalso({ ...base, omie_pv_listar_vez: () => ({ data: ++n <= 1, error: null }) });
  const { f, metodos } = fetchFalso([pagina([1]), FAULT_AUSENTE]);
  const r = await reconciliarConta("oben", { db, credenciais: CRED, fetchImpl: f });
  assertEquals(metodos, ["ListarPedidos", "ConsultarPedido"]);
  assertEquals(r.janelas.length, 1);
  assertEquals(r.janelas[0].desfecho, "incompleta");
  assertEquals(chamadas.some((c) => c.fn === "omie_pv_triagem_registrar"), false);
});

Deno.test("presença por página é registrada ANTES de a janela fechar (e mesmo se não fechar)", async () => {
  const { db, chamadas } = dbFalso(base);
  const { f } = fetchFalso([pagina([5, 6]), { status: 502, corpo: {} }, pagina([7]), EOF, FAULT_AUSENTE]);
  await reconciliarConta("oben", { db, credenciais: CRED, fetchImpl: f });
  const pres = chamadas.filter((c) => c.fn === "omie_pv_presenca_registrar").map((c) => c.args.p_pids);
  assertEquals(pres, [[5, 6], [7]]);
  assertEquals(chamadas.filter((c) => c.fn === "omie_pv_triagem_registrar").map((c) => c.args.p_tipo), ["cursor"]);
});

Deno.test("425 com corpo de EOF na listagem: é bloqueio, registrado na trava compartilhada", async () => {
  const { db, chamadas } = dbFalso(base);
  const { f } = fetchFalso([{ status: 425, corpo: { faultstring: "ERROR: Não existem registros para a página [1]!" } }]);
  const r = await reconciliarConta("oben", { db, credenciais: CRED, fetchImpl: f });
  const fault = chamadas.find((c) => c.fn === "omie_cota_registrar_fault");
  assertEquals(fault?.args.p_metodo, "ListarPedidos");
  assertEquals(Number(fault?.args.p_bloqueio_segundos) >= 1800, true);
  assertEquals(chamadas.some((c) => c.fn === "omie_pv_triagem_registrar"), false);
  assertEquals(r.parou_por_cota !== null, true);
});

Deno.test("trava compartilhada nega a CONSULTA: registrada como nao_enviada (não cobrada) e nenhum fetch", async () => {
  let n = 0;
  const { db, chamadas } = dbFalso({
    ...base,
    // as 4 páginas de listagem pegam a vez; a consulta não
    omie_cota_tentar: (a) => a.p_metodo === "ConsultarPedido" ? ({ data: [{ ok: false, motivo: "ocupado", ate: null }], error: null }) : (n++, vezLivre()),
  });
  const { f, metodos } = fetchFalso([pagina([1]), EOF, pagina([2]), EOF]);
  const r = await reconciliarConta("oben", { db, credenciais: CRED, fetchImpl: f });
  assertEquals(metodos.includes("ConsultarPedido"), false);
  assertEquals(chamadas.find((c) => c.fn === "omie_pv_consulta_registrar")?.args.p_resultado, "nao_enviada");
  assertEquals(r.consulta?.desfecho, "nao_enviada");
});

Deno.test("deadlock no registro: repete o MESMO log_id e para no sucesso", async () => {
  let n = 0;
  const { db, chamadas } = dbFalso({
    ...base,
    omie_pv_consulta_registrar: () => (++n === 1 ? { data: null, error: { message: "deadlock detected" } } : { data: { efeito: "baixa" }, error: null }),
  });
  const { f } = fetchFalso([pagina([1]), EOF, pagina([2]), EOF, FAULT_AUSENTE]);
  const r = await reconciliarConta("oben", { db, credenciais: CRED, fetchImpl: f });
  const regs = chamadas.filter((c) => c.fn === "omie_pv_consulta_registrar");
  assertEquals(regs.map((c) => c.args.p_log_id), [7, 7]);
  assertEquals(r.erro, null);
});

Deno.test("a execução é encerrada no banco com o resumo, também quando a consulta falha", async () => {
  const { db, chamadas } = dbFalso({ ...base, omie_pv_proxima_consulta: () => ({ data: null, error: { message: "boom" } }) });
  const { f } = fetchFalso([pagina([1]), EOF, pagina([2]), EOF]);
  const r = await reconciliarConta("oben", { db, credenciais: CRED, fetchImpl: f });
  assertEquals(r.erro?.includes("boom"), true);
  assertEquals(chamadas.at(-1)?.fn, "omie_pv_execucao_encerrar");
  assertEquals(chamadas.at(-1)?.args.p_execucao_id, 42);
});
