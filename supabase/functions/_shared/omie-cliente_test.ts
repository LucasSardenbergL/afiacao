// Testa o CÓDIGO REAL de omie-cliente.ts no runtime real (Deno), com `fetch` falso e abort REAL.
// Roda com: deno test --no-remote supabase/functions/_shared/omie-cliente_test.ts
//
// O que protege, em ordem de custo: (1) escrita NÃO-repetível nunca é reenviada — 5xx, fault
// ambígua ou queda de rede saem `OmieEscritaIndeterminada` com UM fetch só (o ConcluirRecebimento
// do omie-nfe-recebimento era reenviado em 5xx); (2) a faultstring decide antes do status (EOF
// com 500 é fim, não falha de transporte); (3) REDUNDANT não é repetido (renova a trava);
// (4) leitura repete só transitório, dentro do deadline; (5) socket pendurado é cortado.
import {
  chamarOmie,
  classificarResposta,
  fimDePaginacao,
  lerResposta,
  type PedidoOmie,
  type RespostaOmie,
} from "./omie-cliente.ts";
import { ehEscritaIndeterminada } from "./omie-chamada-relogio.ts";

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

type Passo = { status: number; corpo: string } | { lanca: string };

/** `fetch` falso que devolve os passos em ordem e conta as chamadas. */
function roteiro(passos: Passo[]) {
  const corpos: string[] = [];
  const fetchImpl = ((_url: string, init?: RequestInit) => {
    corpos.push(String(init?.body ?? ""));
    const p = passos[Math.min(corpos.length - 1, passos.length - 1)];
    if ("lanca" in p) return Promise.reject(new TypeError(p.lanca));
    return Promise.resolve(new Response(p.corpo, { status: p.status }));
  }) as typeof fetch;
  return { fetchImpl, corpos };
}

const dormidas: number[] = [];
const semSono = (ms: number) => {
  dormidas.push(ms);
  return Promise.resolve();
};

function pedido(metodo: string): PedidoOmie {
  return {
    url: "https://app.omie.com.br/api/v1/produtos/recebimentonfe/",
    metodo,
    param: { nIdReceb: 42 },
    credenciais: { appKey: "chave-x", appSecret: "segredo-y" },
  };
}

const OK = { status: 200, corpo: '{"cEtapa":"40"}' };
const S503 = { status: 503, corpo: "<html>Service Unavailable</html>" };
const EOF_500 = { status: 500, corpo: '{"faultstring":"ERROR: Não existem registros para a página [3]!"}' };

function r(status: number, corpo: string): RespostaOmie {
  return lerResposta(status, corpo);
}

// ── Parse e classificação ────────────────────────────────────────────────────────────────────

Deno.test("lerResposta: corpo ilegível ou não-objeto vira null (nunca {} = 'vazio')", () => {
  assertEquals(r(200, "<html>").corpo, null);
  assertEquals(r(200, "[1,2]").corpo, null);
  assertEquals(r(200, "").corpo, null);
  assertEquals(r(200, '{"a":1}').corpo?.a, 1);
  assertEquals(r(500, '{"faultstring":"  x  ","faultcode":5113}').faultstring, "x");
  assertEquals(r(500, '{"faultcode":5113}').faultcode, "5113");
});

Deno.test("classificarResposta: a faultstring decide ANTES do status (#1614)", () => {
  assertEquals(classificarResposta(r(EOF_500.status, EOF_500.corpo)), "final");
  assertEquals(fimDePaginacao(r(EOF_500.status, EOF_500.corpo)), true);
  // fault de negócio com 500: definitiva, não transitória
  assertEquals(classificarResposta(r(500, '{"faultstring":"Pedido já cadastrado"}')), "final");
  assertEquals(classificarResposta(r(200, '{"faultstring":"SOAP-ERROR: Broken response"}')), "transitorio");
});

Deno.test("classificarResposta: REDUNDANT/bloqueio são final; concorrência e 429 são rate_limit", () => {
  assertEquals(classificarResposta(r(500, '{"faultstring":"Consumo redundante detectado. Aguarde 60 segundos (REDUNDANT)"}')), "final");
  assertEquals(classificarResposta(r(500, '{"faultstring":"API bloqueada por consumo indevido"}')), "final");
  assertEquals(classificarResposta(r(500, '{"faultstring":"Já existe uma requisição desse método sendo executada"}')), "rate_limit");
  assertEquals(classificarResposta(r(429, "")), "rate_limit");
});

Deno.test("classificarResposta: 5xx sem fault e 2xx ilegível são transitórios; 4xx é final", () => {
  assertEquals(classificarResposta(r(503, "x")), "transitorio");
  assertEquals(classificarResposta(r(200, "{cortad")), "transitorio");
  assertEquals(classificarResposta(r(403, "Forbidden")), "final");
  assertEquals(classificarResposta(r(200, '{"a":1}')), "final");
});

// ── Corpo do request ─────────────────────────────────────────────────────────────────────────

Deno.test("chamarOmie: envelope do contrato — call, credencial e param:[param]", async () => {
  const { fetchImpl, corpos } = roteiro([OK]);
  await chamarOmie(pedido("ConsultarRecebimento"), { conta: "OB", fetchImpl, dormir: semSono });
  const enviado = JSON.parse(corpos[0]);
  assertEquals(enviado.call, "ConsultarRecebimento");
  assertEquals(enviado.app_key, "chave-x");
  assertEquals(enviado.app_secret, "segredo-y");
  assertEquals(JSON.stringify(enviado.param), '[{"nIdReceb":42}]');
});

// ── ESCRITA: o money-path ────────────────────────────────────────────────────────────────────

Deno.test("ESCRITA não-repetível com 5xx: indeterminada, UM fetch só (nunca reenvia)", async () => {
  const { fetchImpl, corpos } = roteiro([S503, OK]);
  const e = await capturar(chamarOmie(pedido("ConcluirRecebimento"), { conta: "OB", fetchImpl, dormir: semSono }));
  assertEquals(ehEscritaIndeterminada(e), true, `esperava indeterminada, veio: ${e.message}`);
  assertEquals(corpos.length, 1, "ConcluirRecebimento foi reenviado");
});

Deno.test("ESCRITA não-repetível com queda de rede: indeterminada, UM fetch só", async () => {
  const { fetchImpl, corpos } = roteiro([{ lanca: "error sending request" }, OK]);
  const e = await capturar(chamarOmie(pedido("IncluirPedCompra"), { conta: "OB", fetchImpl, dormir: semSono }));
  assertEquals(ehEscritaIndeterminada(e), true, `esperava indeterminada, veio: ${e.message}`);
  assertEquals(corpos.length, 1, "IncluirPedCompra foi reenviado após queda de rede");
});

Deno.test("ESCRITA de SET (Alterar*) com 5xx: repete e devolve a resposta boa", async () => {
  const { fetchImpl, corpos } = roteiro([S503, OK]);
  const res = await chamarOmie(pedido("AlterarEtapaRecebimento"), { conta: "OB", fetchImpl, dormir: semSono });
  assertEquals(res.ok, true);
  assertEquals(corpos.length, 2);
});

Deno.test("ESCRITA de SET que esgota em transitório: indeterminada (a anterior pode ter gravado)", async () => {
  const { fetchImpl, corpos } = roteiro([S503]);
  const e = await capturar(chamarOmie(pedido("AlterarRecebimento"), { conta: "OB", fetchImpl, dormir: semSono, maxTentativas: 3 }));
  assertEquals(ehEscritaIndeterminada(e), true, `esperava indeterminada, veio: ${e.message}`);
  assertEquals(corpos.length, 3);
});

Deno.test("ESCRITA recusada por concorrência (rate_limit): repetir é seguro — nada foi aplicado", async () => {
  const conc = { status: 500, corpo: '{"faultstring":"Já existe uma requisição desse método sendo executada"}' };
  const { fetchImpl, corpos } = roteiro([conc, OK]);
  const res = await chamarOmie(pedido("IncluirPedCompra"), { conta: "OB", fetchImpl, dormir: semSono });
  assertEquals(res.ok, true);
  assertEquals(corpos.length, 2);
});

Deno.test("ESCRITA com fault de negócio (500 + 'já cadastrado'): devolve para o chamador, sem repetir", async () => {
  const { fetchImpl, corpos } = roteiro([{ status: 500, corpo: '{"faultstring":"Pedido já cadastrado para o código de integração"}' }]);
  const res = await chamarOmie(pedido("IncluirPedCompra"), { conta: "OB", fetchImpl, dormir: semSono });
  assertEquals(res.faultstring?.includes("cadastrado"), true);
  assertEquals(corpos.length, 1);
});

Deno.test("ESCRITA: classificador da edge não reabre o reenvio (decidirFaultTransitorio manda)", async () => {
  const { fetchImpl, corpos } = roteiro([S503, OK]);
  const e = await capturar(chamarOmie(pedido("ConcluirRecebimento"), {
    conta: "OB", fetchImpl, dormir: semSono, classificar: () => "transitorio",
  }));
  assertEquals(ehEscritaIndeterminada(e), true, `esperava indeterminada, veio: ${e.message}`);
  assertEquals(corpos.length, 1);
});

// ── LEITURA ──────────────────────────────────────────────────────────────────────────────────

Deno.test("LEITURA: repete 5xx e devolve a resposta boa", async () => {
  const { fetchImpl, corpos } = roteiro([S503, S503, OK]);
  const res = await chamarOmie(pedido("ListarRecebimentos"), { conta: "OB", fetchImpl, dormir: semSono });
  assertEquals(res.ok, true);
  assertEquals(corpos.length, 3);
});

Deno.test("LEITURA: esgotou em 5xx → devolve a última resposta (o chamador decide), sem lançar", async () => {
  const { fetchImpl, corpos } = roteiro([S503]);
  const res = await chamarOmie(pedido("ListarRecebimentos"), { conta: "OB", fetchImpl, dormir: semSono, maxTentativas: 2 });
  assertEquals(res.status, 503);
  assertEquals(corpos.length, 2);
});

Deno.test("LEITURA: EOF com 500 é final — um fetch só, sem retentativa", async () => {
  const { fetchImpl, corpos } = roteiro([EOF_500, OK]);
  const res = await chamarOmie(pedido("ListarRecebimentos"), { conta: "OB", fetchImpl, dormir: semSono });
  assertEquals(fimDePaginacao(res), true);
  assertEquals(corpos.length, 1);
});

Deno.test("LEITURA: REDUNDANT não é repetido (repetir renova a trava do Omie)", async () => {
  const red = { status: 500, corpo: '{"faultstring":"Consumo redundante detectado. Aguarde 60 segundos (REDUNDANT)"}' };
  const { fetchImpl, corpos } = roteiro([red, OK]);
  const res = await chamarOmie(pedido("ListarRecebimentos"), { conta: "OB", fetchImpl, dormir: semSono });
  assertEquals(res.status, 500);
  assertEquals(corpos.length, 1);
});

Deno.test("LEITURA: queda de rede é repetida; esgotada, a exceção sobe (nunca vira resposta vazia)", async () => {
  const um = roteiro([{ lanca: "connection reset" }, OK]);
  const res = await chamarOmie(pedido("ListarProdutos"), { conta: "OB", fetchImpl: um.fetchImpl, dormir: semSono });
  assertEquals(res.ok, true);
  assertEquals(um.corpos.length, 2);

  const dois = roteiro([{ lanca: "connection reset" }]);
  const e = await capturar(chamarOmie(pedido("ListarProdutos"), { conta: "OB", fetchImpl: dois.fetchImpl, dormir: semSono }));
  assertEquals(e.message, "connection reset");
  assertEquals(dois.corpos.length, 3);
});

Deno.test("LEITURA: espera que não cabe no deadline não dorme — devolve a resposta já", async () => {
  let t = 0;
  const { fetchImpl, corpos } = roteiro([S503, OK]);
  dormidas.length = 0;
  const res = await chamarOmie(pedido("ListarNF"), {
    conta: "OB", fetchImpl, dormir: semSono, agora: () => t, deadline: 5_000,
    atrasoMs: () => (t = 4_000, 2_000), // depois da 1ª resposta, sobram 1s: não cabe 2s + piso
  });
  assertEquals(res.status, 503);
  assertEquals(corpos.length, 1);
  assertEquals(dormidas.length, 0);
});

Deno.test("LEITURA: sem tempo viável, a chamada nem é feita", async () => {
  const { fetchImpl, corpos } = roteiro([OK]);
  const e = await capturar(chamarOmie(pedido("ListarNF"), { conta: "OB", fetchImpl, dormir: semSono, agora: () => 1_000, deadline: 1_500 }));
  assertEquals(e.message.includes("a chamada NÃO foi feita"), true, e.message);
  assertEquals(corpos.length, 0);
});

Deno.test("LEITURA: socket pendurado é cortado no teto do request (abort REAL)", async () => {
  let chamadas = 0;
  const pendurado = ((_u: string, init?: RequestInit) => {
    chamadas++;
    return new Promise((_, rej) => init?.signal?.addEventListener("abort", () => rej(init.signal!.reason)));
  }) as typeof fetch;
  const e = await capturar(chamarOmie(pedido("ListarNF"), {
    conta: "OB", fetchImpl: pendurado, dormir: semSono, tetoPorRequestMs: 20, minimoMs: 5, maxTentativas: 1,
  }));
  assertEquals(e.message.startsWith("OMIE_TRANSIENT (OB): timeout"), true, e.message);
  assertEquals(chamadas, 1);
});

Deno.test("classificador da edge decide a LEITURA (ex.: SOAP-ENV:Client = definitivo)", async () => {
  const { fetchImpl, corpos } = roteiro([{ status: 500, corpo: "SOAP-ENV:Client produto" }, OK]);
  const res = await chamarOmie(pedido("ListarProdutos"), {
    conta: "OB", fetchImpl, dormir: semSono,
    classificar: (x) => (x.texto.includes("SOAP-ENV:Client") ? "final" : classificarResposta(x)),
  });
  assertEquals(res.status, 500);
  assertEquals(corpos.length, 1);
});
