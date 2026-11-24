// `assertEquals` local em vez de std/assert remoto: `test:edges` roda com `--no-remote`.
function assertEquals(atual: unknown, esperado: unknown) {
  const a = JSON.stringify(atual);
  const e = JSON.stringify(esperado);
  if (a !== e) throw new Error(`esperado ${e}, veio ${a}`);
}
import { lerResposta } from "../_shared/omie-cliente.ts";
import { classificarConsulta, classificarErro, coletarJanela, faultDeCota } from "./decisao.ts";

const PID = 12156020937;
const resp = (status: number, corpo: unknown) => lerResposta(status, JSON.stringify(corpo));
const tipo = (r: ReturnType<typeof resp>, pid = PID) => classificarConsulta(r, pid).tipo;

// Texto REAL do Omie (ConsultarPedido do PV 12231, excluído — medido 2026-11-21).
const FAULT_REAL = `ERROR: Pedido não cadastrado para o Código [${PID}] !`;

Deno.test("ausente: fault real do Omie com o código consultado", () => {
  const c = classificarConsulta(resp(500, { faultstring: FAULT_REAL, faultcode: "SOAP-ENV:Client-103" }), PID);
  assertEquals(c.tipo, "ausente");
});

Deno.test("indeterminado: negação que cita OUTRO código", () => {
  assertEquals(tipo(resp(500, { faultstring: "ERROR: Pedido não cadastrado para o Código [999] !" })), "indeterminado");
});

Deno.test("indeterminado: negação sem código nenhum", () => {
  assertEquals(tipo(resp(500, { faultstring: "ERROR: Pedido não cadastrado!" })), "indeterminado");
});

Deno.test("indeterminado: código consultado como PREFIXO de outro não casa", () => {
  assertEquals(tipo(resp(500, { faultstring: `ERROR: Pedido não cadastrado para o Código [${PID}9] !` })), "indeterminado");
});

Deno.test("indeterminado: fault de outra entidade cita o código", () => {
  assertEquals(tipo(resp(500, { faultstring: `ERROR: Cliente não cadastrado para o Código [${PID}] !` })), "indeterminado");
  assertEquals(tipo(resp(500, { faultstring: `ERROR: Aplicativo não encontrado [${PID}]` })), "indeterminado");
});

Deno.test("indeterminado: transitório / rate limit / 5xx sem fault / corpo ilegível", () => {
  assertEquals(tipo(resp(500, { faultstring: "Broken response from SOAP server" })), "indeterminado");
  assertEquals(tipo(resp(500, { faultstring: "ERROR: Já existe uma requisição desse método sendo executada" })), "indeterminado");
  assertEquals(tipo(lerResposta(429, "")), "indeterminado");
  assertEquals(tipo(lerResposta(502, "<html>bad gateway</html>")), "indeterminado");
  assertEquals(tipo(lerResposta(200, "{corte")), "indeterminado");
});

Deno.test("existe: cabeçalho com o MESMO codigo_pedido", () => {
  const c = classificarConsulta(resp(200, {
    pedido_venda_produto: { cabecalho: { codigo_pedido: PID, numero_pedido: "12231", etapa: "10" }, infoCadastro: { cancelado: "N" } },
  }), PID);
  assertEquals(c, { tipo: "existe", codigoPedido: PID, numeroPedido: "12231", etapa: "10", cancelado: "N" });
});

Deno.test("indeterminado: 200 com OUTRO codigo_pedido ou sem cabeçalho", () => {
  assertEquals(tipo(resp(200, { pedido_venda_produto: { cabecalho: { codigo_pedido: 1 } } })), "indeterminado");
  assertEquals(tipo(resp(200, { pedido_venda_produto: { cabecalho: { codigo_pedido: String(PID) } } })), "indeterminado");
  assertEquals(tipo(resp(200, {})), "indeterminado");
});

Deno.test("indeterminado: código consultado inválido nunca vira ausência", () => {
  assertEquals(tipo(resp(500, { faultstring: "ERROR: Pedido não cadastrado para o Código [0] !" }), 0), "indeterminado");
});

Deno.test("exceção de transporte é indeterminado", () => {
  assertEquals(classificarErro("OMIE_TRANSIENT timeout").tipo, "indeterminado");
});

// ── Endurecimento (Codex desenho 2026-11-21, P0-2) ──
Deno.test("indeterminado: negação de CLIENTE colada a um PID entre colchetes", () => {
  assertEquals(tipo(resp(500, { faultstring: `Pedido [${PID}] - cliente não cadastrado` })), "indeterminado");
});
Deno.test("indeterminado: 425 com corpo de fault de ausência (sintético)", () => {
  assertEquals(tipo(resp(425, { faultstring: FAULT_REAL })), "indeterminado");
});
Deno.test("indeterminado: 425 real de bloqueio, e faultDeCota o reconhece", () => {
  const r = resp(425, { faultstring: "ERROR: API bloqueada por consumo indevido. Tente novamente em 1799 segundos." });
  assertEquals(tipo(r), "indeterminado");
  assertEquals(faultDeCota(r) !== null, true);
  assertEquals(faultDeCota(resp(500, { faultstring: FAULT_REAL })), null);
});

// ── coletarJanela ──
const pagina = (cods: number[], totPag: number, totReg: number) =>
  resp(200, { pagina: 1, total_de_paginas: totPag, total_de_registros: totReg, pedido_venda_produto: cods.map((c) => ({ cabecalho: { codigo_pedido: c } })) });
const eofDe = (n: number) => resp(500, { faultstring: `ERROR: Não existem registros para a página [${n}]!` });
const roteiro = (paginas: ReturnType<typeof resp>[]) => (n: number) => Promise.resolve(paginas[n - 1] ?? eofDe(n));

Deno.test("janela completa: lê até o EOF e devolve os PIDs", async () => {
  const j = await coletarJanela(roteiro([pagina([1, 2], 2, 3), pagina([3], 2, 3)]));
  assertEquals(j, { completa: true, pids: [1, 2, 3], paginas: 2 });
});
Deno.test("janela vazia: EOF na página 1 é completa com 0 PIDs", async () => {
  assertEquals(await coletarJanela(roteiro([])), { completa: true, pids: [], paginas: 1 });
});
Deno.test("janela incompleta: lidos < declarados", async () => {
  const j = await coletarJanela(roteiro([pagina([1, 2], 1, 5)]));
  assertEquals(j.completa, false);
});
Deno.test("janela incompleta: página com rate limit no meio", async () => {
  const j = await coletarJanela(roteiro([pagina([1], 3, 3), lerResposta(429, ""), pagina([3], 3, 3)]));
  assertEquals(j.completa, false);
});
Deno.test("janela incompleta: EOF antes do fim declarado", async () => {
  const j = await coletarJanela(roteiro([pagina([1], 3, 3)]));
  assertEquals(j.completa, false);
});
Deno.test("janela incompleta: item sem codigo_pedido", async () => {
  const j = await coletarJanela(roteiro([resp(200, { total_de_paginas: 1, total_de_registros: 1, pedido_venda_produto: [{ cabecalho: {} }] })]));
  assertEquals(j.completa, false);
});
Deno.test("janela incompleta: teto de páginas", async () => {
  // PIDs DISTINTOS por página: a janela só pode terminar incompleta pelo TETO (não por página repetida).
  let n = 0;
  const j = await coletarJanela(() => Promise.resolve(pagina([++n], 1, 1)), 3);
  assertEquals(j.completa, false);
  assertEquals(j.completa === false && j.motivo, "teto de 3 páginas");
});

// ── Codex de desenho rodada 2 (P0-1/P0-2) ─────────────────────────────────────────────────────────
Deno.test("indeterminado: texto INTEGRAL de ausência com HTTP 401/403/502/200 não é ausência", () => {
  for (const st of [200, 401, 403, 502]) {
    assertEquals(tipo(resp(st, { faultstring: FAULT_REAL, faultcode: "SOAP-ENV:Client-103" })), "indeterminado");
  }
});

Deno.test("indeterminado: ausência sem 'ERROR:' ou sem '!' ou em outra caixa", () => {
  for (const f of [`Pedido não cadastrado para o Código [${PID}] !`, `ERROR: Pedido não cadastrado para o Código [${PID}]`,
                   `ERROR: PEDIDO NÃO CADASTRADO PARA O CÓDIGO [${PID}] !`]) {
    assertEquals(tipo(resp(500, { faultstring: f, faultcode: "SOAP-ENV:Client-103" })), "indeterminado");
  }
});

Deno.test("indeterminado: faultcode de servidor/autenticação com o texto de ausência", () => {
  assertEquals(tipo(resp(500, { faultstring: FAULT_REAL, faultcode: "SOAP-ENV:Server" })), "indeterminado");
  assertEquals(tipo(resp(500, { faultstring: FAULT_REAL, faultcode: "MISUSE_API_PROCESS" })), "indeterminado");
});

Deno.test("janela incompleta: 425 com texto de EOF NÃO é fim", async () => {
  const p1 = resp(200, { total_de_paginas: 1, total_de_registros: 1, pedido_venda_produto: [{ cabecalho: { codigo_pedido: 1 } }] });
  const falso425 = resp(425, { faultstring: "ERROR: Não existem registros para a página [2]!" });
  const j = await coletarJanela(roteiro([p1, falso425]));
  assertEquals(j.completa, false);
});

Deno.test("janela incompleta: EOF que nega OUTRA página", async () => {
  const p1 = resp(200, { total_de_paginas: 1, total_de_registros: 1, pedido_venda_produto: [{ cabecalho: { codigo_pedido: 1 } }] });
  const j = await coletarJanela(roteiro([p1, eofDe(7)]));
  assertEquals(j.completa, false);
});

Deno.test("janela incompleta: página repetida", async () => {
  const p = resp(200, { total_de_paginas: 2, pedido_venda_produto: [{ cabecalho: { codigo_pedido: 1 } }] });
  const j = await coletarJanela(roteiro([p, p]));
  assertEquals(j.completa, false);
});

Deno.test("presença por página chega mesmo quando a janela termina incompleta", async () => {
  const vistos: number[][] = [];
  const p1 = resp(200, { total_de_paginas: 3, pedido_venda_produto: [{ cabecalho: { codigo_pedido: 11 } }] });
  const j = await coletarJanela(roteiro([p1, resp(502, {})]), 50, (pids) => { vistos.push(pids); return Promise.resolve(); });
  assertEquals(j.completa, false);
  assertEquals(vistos, [[11]]);
});

// ── Codex de código (P0-3, P1) ───────────────────────────────────────────────────────────────────
Deno.test("presença sai ANTES de rejeitar a página: item ilegível e total acima do teto", async () => {
  const vistos: number[][] = [];
  const guardar = (p: number[]) => { vistos.push(p); return Promise.resolve(); };
  const ilegivel = resp(200, { total_de_paginas: 1, pedido_venda_produto: [{ cabecalho: { codigo_pedido: 21 } }, { cabecalho: {} }] });
  assertEquals((await coletarJanela(roteiro([ilegivel]), 50, guardar)).completa, false);
  const teto = resp(200, { total_de_paginas: 7, pedido_venda_produto: [{ cabecalho: { codigo_pedido: 22 } }] });
  assertEquals((await coletarJanela(roteiro([teto]), 3, guardar)).completa, false);
  assertEquals(vistos, [[21], [22]]);
});

Deno.test("indeterminado: faultcode BRUTO não-string (objeto) com o texto de ausência", () => {
  assertEquals(tipo(resp(500, { faultstring: FAULT_REAL, faultcode: { x: 1 } })), "indeterminado");
  assertEquals(tipo(resp(500, { faultstring: FAULT_REAL, faultcode: ["SOAP-ENV:Client"] })), "indeterminado");
  assertEquals(tipo(resp(500, { faultstring: FAULT_REAL })), "ausente");
});
