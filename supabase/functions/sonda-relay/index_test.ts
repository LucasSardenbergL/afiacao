// O relé é o único ponto de falha CATASTRÓFICA do mecanismo (mandar POST à alvo = fluxo real em
// bundle velho). Este teste não lê o código: ele captura o `Request` que o relé passa ao `fetch` e
// interroga o objeto — método, headers, corpo, redirect, URL.
// Roda com: deno test --no-remote --allow-read=supabase/functions supabase/functions/sonda-relay/
import { derivarCredencial, HEADER_SONDA } from "../_shared/sonda-cron.ts";

function eq(a: unknown, b: unknown, msg: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${msg}\n  esperado: ${JSON.stringify(b)}\n  recebido: ${JSON.stringify(a)}`);
  }
}

const CHAVE = "u".repeat(44);
const ENV: Record<string, string> = {
  CRON_SECRET: "cron-de-teste",
  SONDA_HMAC_KEY: CHAVE,
  SUPABASE_URL: "https://ref.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "srk",
};

let handler: ((r: Request) => Promise<Response>) | null = null;
(Deno as unknown as { serve: (a: unknown, b?: unknown) => unknown }).serve = (a, b) => {
  handler = (typeof a === "function" ? a : b) as typeof handler;
  return {};
};
(Deno.env as unknown as { get: (k: string) => string | undefined }).get = (k) => ENV[k];

const chamadas: Request[] = [];
let responder: (r: Request) => Promise<Response> = async () => new Response(null);
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const r = new Request(input, init);
  chamadas.push(r);
  return await responder(r);
}) as typeof fetch;

await import("./index.ts");
const h = handler!;

const URL_RELE = "https://ref.supabase.co/functions/v1/sonda-relay";
const cron = (corpo: unknown) =>
  new Request(URL_RELE, {
    method: "POST",
    headers: { "content-type": "application/json", "x-cron-secret": "cron-de-teste" },
    body: JSON.stringify(corpo),
  });
const ATESTACAO = JSON.stringify({
  ok: true,
  probe: true,
  versao: "v1.1-x",
  edge: "monthly-report",
  fonte: "a".repeat(64),
});
const json = (s: string, status = 200) =>
  new Response(s, { status, headers: { "content-type": "application/json" } });

Deno.test("relé: sem x-cron-secret → 401 e ZERO fetch", async () => {
  chamadas.length = 0;
  const r = await h(new Request(URL_RELE, { method: "POST", body: "{}" }));
  eq(r.status, 401, "status");
  eq(chamadas.length, 0, "não pode sair requisição sem o gate do cron");
});

Deno.test("relé: alvo fora da allowlist → 400 fora-da-allowlist e ZERO fetch", async () => {
  chamadas.length = 0;
  const r = await h(cron({ alvo: "omie-webhook", tick: "t" }));
  eq(r.status, 400, "status");
  eq((await r.json()).classe, "fora-da-allowlist", "classe");
  eq(chamadas.length, 0, "default-deny em runtime: nada sai para alvo não provado");
});

Deno.test("relé: alvo válido → exatamente 1 fetch OPTIONS, um header, corpo nulo, redirect manual, URL do projeto", async () => {
  chamadas.length = 0;
  responder = async () => json(ATESTACAO);
  const r = await h(cron({ alvo: "monthly-report", tick: "t" }));
  eq(r.status, 200, "status");
  eq(await r.text(), ATESTACAO, "corpo verbatim da alvo");
  eq(chamadas.length, 1, "exatamente 1 fetch");
  const s = chamadas[0];
  eq(s.method, "OPTIONS", "método do request de saída");
  eq([...s.headers.keys()], [HEADER_SONDA], "headers do request de saída");
  eq(s.body, null, "corpo do request de saída");
  eq(s.redirect, "manual", "redirect do request de saída");
  eq(s.url, "https://ref.supabase.co/functions/v1/monthly-report", "url");
  eq(s.headers.get(HEADER_SONDA), await derivarCredencial(CHAVE, "monthly-report"), "credencial derivada POR EDGE");
});

Deno.test("relé: cada classe de resposta da alvo, e o redirect NUNCA vira 2º fetch", async () => {
  const casos: Array<[string, (r: Request) => Promise<Response>, string]> = [
    ["cors", async () => new Response("ok", { status: 200, headers: { "content-type": "text/plain" } }), "cors-sem-sonda"],
    ["identidade", async () => json(ATESTACAO.replace("monthly-report", "outra-edge")), "identidade-divergente"],
    ["contrato", async () => json(JSON.stringify({ probe: true, edge: "monthly-report", versao: "x" })), "contrato-invalido"],
    ["303", async () => new Response(null, { status: 303, headers: { Location: "/functions/v1/monthly-report" } }), "redirect"],
    ["308", async () => new Response(null, { status: 308, headers: { Location: "/functions/v1/monthly-report" } }), "redirect"],
    ["timeout", async () => { throw new DOMException("t", "TimeoutError"); }, "timeout"],
    ["500", async () => new Response("x", { status: 500 }), "erro-http"],
  ];
  for (const [nome, resp, classe] of casos) {
    chamadas.length = 0;
    responder = resp;
    const r = await h(cron({ alvo: "monthly-report", tick: "t" }));
    const j = await r.json();
    eq(r.status, 200, `${nome}: status`);
    eq(j.ok, false, `${nome}: ok`);
    eq(j.classe, classe, `${nome}: classe`);
    eq("edge" in j || "versao" in j, false, `${nome}: corpo de erro não pode ter edge/versao no topo (entraria na janela viva como atestação)`);
    eq(chamadas.length, 1, `${nome}: exatamente 1 fetch — redirect não é seguido`);
  }
});

Deno.test("relé: SONDA_HMAC_KEY ausente → 500 sem-chave e ZERO fetch", async () => {
  const guardada = ENV.SONDA_HMAC_KEY;
  delete ENV.SONDA_HMAC_KEY;
  chamadas.length = 0;
  const r = await h(cron({ alvo: "monthly-report", tick: "t" }));
  eq(r.status, 500, "status");
  eq((await r.json()).classe, "sem-chave", "classe");
  eq(chamadas.length, 0, "sem chave não se pergunta nada a ninguém");
  ENV.SONDA_HMAC_KEY = guardada;
});

Deno.test("relé: OPTIONS com credencial responde a própria sonda; sem credencial devolve o CORS de sempre", async () => {
  chamadas.length = 0;
  const cred = await derivarCredencial(CHAVE, "sonda-relay");
  const r = await h(new Request(URL_RELE, { method: "OPTIONS", headers: { [HEADER_SONDA]: cred } }));
  const j = await r.json();
  eq(j.probe, true, "probe");
  eq(j.edge, "sonda-relay", "edge");
  const c = await h(new Request(URL_RELE, { method: "OPTIONS" }));
  eq(c.status, 200, "cors: status");
  eq(await c.text(), "", "cors: corpo vazio, como antes");
  eq(chamadas.length, 0, "o ramo OPTIONS não faz IO");
});

Deno.test("relé: POST {probe:true} com cron secret responde a sonda (caminho humano legado)", async () => {
  chamadas.length = 0;
  const r = await h(cron({ probe: true }));
  const j = await r.json();
  eq(j.probe, true, "probe");
  eq(j.edge, "sonda-relay", "edge");
  eq(chamadas.length, 0, "sonda não dispara relé");
});
