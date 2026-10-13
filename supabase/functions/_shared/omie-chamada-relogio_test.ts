// Testa o CÓDIGO REAL de omie-chamada-relogio.ts no runtime real (Deno), com abort REAL (teto de
// poucos ms injetado) — não leitura de token do fonte.
// Roda com: deno test --no-remote supabase/functions/_shared/omie-chamada-relogio_test.ts
//
// O que protege, em ordem de custo: (1) uma escrita perdida no transporte NUNCA sai como
// transitória/genérica — sai marcada como indeterminada, com vocabulário que nenhum predicado
// vizinho lê como "duplicado", "não existe" ou "repita"; (2) um socket pendurado é cortado no teto;
// (3) sem tempo viável, a chamada não é feita; (4) leitura que estoura lança (nunca null = EOF).
import {
  chamarComRelogio,
  decidirFaultTransitorio,
  ehEscritaIndeterminada,
  ehEscritaOmie,
  erroEscritaAmbigua,
  escritaRepetivel,
  OmieEscritaIndeterminada,
  prazoDaChamadaOmie,
  TETO_CHAMADA_OMIE_MS,
  tetoEsperaTravaMs,
} from "./omie-chamada-relogio.ts";
import { classificarFaultstring } from "./omie-falha.ts";
import { type ClienteCota, CotaOmieIndisponivel, obterVez } from "./omie-cota.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (a !== b) throw new Error(msg ?? `esperado ${JSON.stringify(b)}, veio ${JSON.stringify(a)}`);
}

async function capturar(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    if (e instanceof Error) return e;
    throw new Error(`lançou não-Error: ${String(e)}`);
  }
  throw new Error("esperava exceção e a chamada resolveu");
}

// `fetch` pendurado de verdade: só termina quando o signal aborta (como o fetch do Deno).
function pendurado(signal: AbortSignal): Promise<never> {
  return new Promise((_, rej) => {
    if (signal.aborted) return rej(signal.reason);
    signal.addEventListener("abort", () => rej(signal.reason), { once: true });
  });
}

const LONGE = () => Date.now() + 60_000;
const RAPIDO = { tetoMs: 30, minimoMs: 1 };

// Normalização igual à dos predicados vizinhos (sem acento, minúsculo).
const norm = (t: string) => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

Deno.test("ehEscritaOmie: só os prefixos de leitura conhecidos são leitura; o resto (e o desconhecido) é escrita", () => {
  for (const m of ["ListarPedidos", "ConsultarPedido", "ConsultarOS", "ListarClientes", "PesquisarLancamentos", "ObterDocumentos"]) {
    assertEquals(ehEscritaOmie(m), false, `${m} é leitura`);
  }
  for (
    const m of [
      "IncluirPedido", "IncluirItemPedido", "ExcluirItemPedido", "AlterarPedidoVenda", "TotalizarPedido",
      "IncluirCliente", "IncluirOS", "AlterarOS", "ExcluirOS", "IncluirOrdemProducao", "CancelarPedido",
      "MetodoNovoQueNinguemViu", "Listar", "Listarx", "",
    ]
  ) {
    assertEquals(ehEscritaOmie(m), true, `${JSON.stringify(m)} tem de ser escrita (fail-closed)`);
  }
});

Deno.test("teto: igual ao do #3001 (140s) e prazo = início + teto", () => {
  assertEquals(TETO_CHAMADA_OMIE_MS, 140_000);
  assertEquals(prazoDaChamadaOmie(1_000), 141_000);
});

Deno.test("ESCRITA pendurada: abortada no teto e marcada INDETERMINADA (nunca transitória)", async () => {
  const t0 = Date.now();
  const e = await capturar(chamarComRelogio(pendurado, { metodo: "IncluirPedido", conta: "oben", deadline: LONGE(), ...RAPIDO }));
  const dur = Date.now() - t0;
  if (dur > 2_000) throw new Error(`o teto de 30ms não cortou o socket (${dur}ms)`);
  assertEquals(ehEscritaIndeterminada(e), true, `esperava a marca de indeterminada, veio: ${e.message}`);
  assertEquals(e instanceof OmieEscritaIndeterminada, true);
  assertEquals(e.message.startsWith("OMIE_ESCRITA_INDETERMINADA (oben): IncluirPedido "), true, e.message);
  assertEquals(e.message.includes("PODE ter gravado"), true, e.message);
  assertEquals(e.message.startsWith("OMIE_TRANSIENT"), false, "escrita não pode sair com o prefixo que o laço trata como pausa repetível");
});

Deno.test("ESCRITA com falha de transporte NÃO-abort (reset, corpo ilegível): também indeterminada", async () => {
  for (const causa of [new TypeError("error sending request: connection reset"), new SyntaxError("Unexpected token < in JSON")]) {
    const e = await capturar(chamarComRelogio(() => Promise.reject(causa), { metodo: "IncluirOS", conta: "colacor_sc", deadline: LONGE() }));
    assertEquals(ehEscritaIndeterminada(e), true, `${causa.name} numa escrita tem de virar indeterminada, veio: ${e.message}`);
    assertEquals(e.cause, causa, "o erro cru fica em `cause`, não na mensagem");
    assertEquals(e.message.includes("connection") || e.message.includes("Unexpected"), false, "a mensagem não ecoa o erro cru");
  }
});

Deno.test("mensagem da indeterminada: nenhum predicado vizinho a lê como duplicado, ausência ou transitório", async () => {
  const msgs: string[] = [];
  msgs.push((await capturar(chamarComRelogio(pendurado, { metodo: "IncluirPedido", conta: "oben", deadline: LONGE(), ...RAPIDO }))).message);
  msgs.push((await capturar(chamarComRelogio(() => Promise.reject(new TypeError("x")), { metodo: "ExcluirOS", conta: "colacor_sc", deadline: LONGE() }))).message);
  for (const m of msgs) {
    const t = norm(m);
    // isOmieDuplicatePedido (omie-vendas-sync / src/lib/omie/pedido-duplicate.ts)
    assertEquals(t.includes("cadastrad") || t.includes("integra"), false, `casaria o detector de PEDIDO DUPLICADO: ${m}`);
    // MARCADORES_OS_AUSENTE do osAusenteNoOmie (omie-sync) — o que apaga o pedido de 6 tabelas
    for (const marcador of ["nao existe", "nao encontrad", "nao cadastrad"]) {
      assertEquals(t.includes(marcador), false, `casaria "${marcador}" (OS ausente): ${m}`);
    }
    // transitório = repetível. Indeterminada não pode ser.
    assertEquals(classificarFaultstring(m), "indeterminada", `classificarFaultstring não pode chamá-la de transitória: ${m}`);
  }
});

Deno.test("LEITURA pendurada: lança OMIE_TRANSIENT transitório (nunca resolve null)", async () => {
  const e = await capturar(chamarComRelogio(pendurado, { metodo: "ListarPedidos", conta: "colacor", deadline: LONGE(), ...RAPIDO }));
  assertEquals(ehEscritaIndeterminada(e), false);
  assertEquals(e.message.startsWith("OMIE_TRANSIENT (colacor): timeout"), true, e.message);
  assertEquals(classificarFaultstring(e.message), "transitorio", e.message);
});

Deno.test("LEITURA com erro que não é abort: passa INTACTO (comportamento de hoje)", async () => {
  const causa = new Error("Erro Omie Vendas (oben): qualquer coisa");
  const e = await capturar(chamarComRelogio(() => Promise.reject(causa), { metodo: "ConsultarPedido", conta: "oben", deadline: LONGE() }));
  assertEquals(e, causa);
});

Deno.test("sinalExtra (os 80s da trava) continua valendo: o primeiro a disparar vence", async () => {
  const extra = new AbortController();
  const p = capturar(chamarComRelogio(pendurado, { metodo: "ListarPedidos", conta: "oben", deadline: LONGE(), sinalExtra: extra.signal }));
  extra.abort(new DOMException("trava", "TimeoutError"));
  const e = await p;
  assertEquals(e.message.startsWith("OMIE_TRANSIENT (oben): timeout"), true, e.message);
});

Deno.test("sem tempo viável: NÃO chama `fazer` e diz que a chamada não foi feita", async () => {
  let chamou = 0;
  const fazer = () => {
    chamou++;
    return Promise.resolve("ok");
  };
  const agora = 5_000_000;
  for (const deadline of [agora, agora - 1, agora + 1_999]) {
    const e = await capturar(chamarComRelogio(fazer, { metodo: "IncluirPedido", conta: "oben", deadline, agora: () => agora }));
    assertEquals(e.message.includes("NÃO foi feita"), true, e.message);
    assertEquals(ehEscritaIndeterminada(e), false, "não chamar é certeza, não indeterminação");
  }
  assertEquals(chamou, 0, "fazer não pode ter sido chamado");
});

Deno.test("caminho feliz: devolve o que `fazer` devolve e o signal recebido nasce vivo", async () => {
  let vivo: boolean | null = null;
  const r = await chamarComRelogio((s) => {
    vivo = !s.aborted;
    return Promise.resolve({ codigo_pedido: 42 });
  }, { metodo: "IncluirPedido", conta: "oben", deadline: LONGE() });
  assertEquals((r as { codigo_pedido: number }).codigo_pedido, 42);
  assertEquals(vivo, true);
});

// ── Achados do challenge Codex (M-33 p3) ──────────────────────────────────────────────────────

Deno.test("decidirFaultTransitorio: escrita NÃO-repetível com transitório ambíguo PARA; rate-limit e SET repetem", () => {
  for (const m of ["IncluirPedido", "IncluirItemPedido", "ExcluirItemPedido", "IncluirCliente", "CancelarPedido", "IncluirOS", "MetodoNovo"]) {
    assertEquals(decidirFaultTransitorio(m, false), "indeterminada", `${m} + SOAP-ERROR/timeout não pode repetir`);
    assertEquals(decidirFaultTransitorio(m, true), "repetir", `${m} + rate-limit (o Omie recusou) pode repetir`);
  }
  for (const m of ["AlterarPedidoVenda", "TotalizarPedido", "AlterarOS", "AlterarOrdemProducao", "ListarPedidos", "ConsultarPedido"]) {
    assertEquals(decidirFaultTransitorio(m, false), "repetir", `${m} é SET/leitura: repetir é seguro`);
  }
  assertEquals(escritaRepetivel("Alterar"), false, "prefixo sozinho não é método");
  assertEquals(escritaRepetivel("Alteracao"), false);
});

Deno.test("escrita com resposta ambígua ANTERIOR e sem tempo para repetir: INDETERMINADA, nunca 'NÃO foi feita'", async () => {
  let chamou = 0;
  const fazer = () => (chamou++, Promise.resolve("ok"));
  const agora = 5_000_000;
  const e = await capturar(chamarComRelogio(fazer, {
    metodo: "IncluirPedido", conta: "oben", deadline: agora + 1_999, agora: () => agora, envioAnteriorAmbiguo: true,
  }));
  assertEquals(ehEscritaIndeterminada(e), true, `esperava indeterminada, veio: ${e.message}`);
  assertEquals(e.message.includes("NÃO foi feita"), false, e.message);
  assertEquals(chamou, 0, "sem tempo: não chama");
  // controle do par: sem envio ambíguo anterior, a afirmação de não-envio continua valendo
  const e2 = await capturar(chamarComRelogio(fazer, { metodo: "IncluirPedido", conta: "oben", deadline: agora, agora: () => agora }));
  assertEquals(e2.message.includes("NÃO foi feita"), true, e2.message);
  // e numa LEITURA a flag não inventa indeterminação
  const e3 = await capturar(chamarComRelogio(fazer, {
    metodo: "ListarPedidos", conta: "oben", deadline: agora, agora: () => agora, envioAnteriorAmbiguo: true,
  }));
  assertEquals(ehEscritaIndeterminada(e3), false, e3.message);
});

Deno.test("erroEscritaAmbigua: marcada, sem ecoar a faultstring (que pode trazer a app_key) e fora dos predicados vizinhos", () => {
  const fault = "SOAP-ERROR: Broken response [1503123456] timeout";
  const e = erroEscritaAmbigua("IncluirItemPedido", "oben", fault);
  assertEquals(ehEscritaIndeterminada(e), true);
  assertEquals(e.cause, fault);
  assertEquals(e.message.includes("1503123456") || e.message.includes("SOAP"), false, e.message);
  const t = norm(e.message);
  for (const proibido of ["cadastrad", "integra", "nao existe", "nao encontrad"]) {
    assertEquals(t.includes(proibido), false, `"${proibido}" em: ${e.message}`);
  }
  assertEquals(classificarFaultstring(e.message), "indeterminada", e.message);
});

Deno.test("tetoEsperaTravaMs: limita a espera pela trava ao que sobra do prazo menos uma chamada viável", () => {
  const t = 1_000_000;
  assertEquals(tetoEsperaTravaMs(t, t + 140_000), 20_000, "com folga, o teto padrão da trava");
  assertEquals(tetoEsperaTravaMs(t, t + 7_000), 5_000, "7s restantes − 2s de chamada viável");
  assertEquals(tetoEsperaTravaMs(t, t + 1_500), 0, "abaixo do piso: não espera");
  assertEquals(tetoEsperaTravaMs(t, t - 10), 0, "vencido: não espera");
});

Deno.test("composição real com obterVez: trava ocupada perto do prazo NÃO espera além dele (achado P2 do Codex)", async () => {
  const chamadas: string[] = [];
  const db: ClienteCota = {
    rpc(fn) {
      chamadas.push(fn);
      // ocupada por mais 20s
      return Promise.resolve({ data: [{ ok: false, motivo: "ocupado", ate: "2026-10-10T12:00:20Z" }], error: null });
    },
  };
  const agora = Date.parse("2026-10-10T12:00:00Z");
  const esperas: number[] = [];
  const e = await capturar(obterVez(db, "oben", "ListarPedidos", {
    agora: () => agora,
    esperar: (ms) => (esperas.push(ms), Promise.resolve()),
    tetoEsperaMs: tetoEsperaTravaMs(agora, agora + 3_000), // retentativa aos 137s de 140s
  }));
  assertEquals(e instanceof CotaOmieIndisponivel, true, e.message);
  assertEquals(esperas.length, 0, `não podia dormir com 3s restantes, dormiu ${JSON.stringify(esperas)}`);
  assertEquals(chamadas.length, 1, "uma consulta à trava, nenhuma outra");
});
