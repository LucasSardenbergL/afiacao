// Testes do helper da sonda de deploy POR CRON (spec v5). Rodam com:
//   deno test --no-remote --allow-read=supabase/functions supabase/functions/_shared/sonda-cron_test.ts
//
// Este helper é money-path: um erro aqui não devolve resposta errada — ele deixa uma credencial
// inválida atestar (mentira sobre qual bundle está no ar) ou muda o CORS do app inteiro.
import {
  atenderSondaOptions,
  barreiraSaida,
  chaveUtilizavel,
  classificarRespostaAlvo,
  derivarCredencial,
  HEADER_SONDA,
  METODO_SONDA,
  montarRequestSonda,
  verificarCredencial,
} from "./sonda-cron.ts";
import { criarRespostaSonda } from "./sonda-versao.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(
      `${msg ?? "assertEquals"}\n  esperado: ${JSON.stringify(b)}\n  recebido: ${JSON.stringify(a)}`,
    );
  }
}

const CHAVE = "Jefe";
/** 44 chars base64 → 33 bytes decodificados (acima do piso de forma). */
const CHAVE_FORTE = "u".repeat(44);
const respostaSonda = criarRespostaSonda("monthly-report");

Deno.test("derivarCredencial: vetores fixos por edge (calculados uma vez e congelados aqui)", async () => {
  assertEquals(
    await derivarCredencial(CHAVE, "monthly-report"),
    "04855b66e0237a22cb2039fa2859d597b90adf29ee61ce9cd2f3d03c37e7ce42",
  );
  assertEquals(
    await derivarCredencial(CHAVE, "calculate-scores"),
    "325f17a6509571aa519f49ec2422bbde00d2ec225b496549906f74ae6b5079cb",
  );
  assertEquals(
    await derivarCredencial(CHAVE, "sync-reprocess"),
    "48f9b5235b76111f7e08312b3abb00e942d7a827793565039cda7976e7174702",
  );
  assertEquals(
    await derivarCredencial(CHAVE, "sonda-relay"),
    "c09cdd0051980ceff1989c755d98a9ef47a592ecd193627041c83836a364943d",
  );
});

Deno.test("verificarCredencial: aceita a própria edge; recusa outra edge, hex inválido, ausente, chave ausente", async () => {
  const cred = await derivarCredencial(CHAVE, "monthly-report");
  assertEquals(await verificarCredencial(CHAVE, "monthly-report", cred), true);
  assertEquals(await verificarCredencial(CHAVE, "calculate-scores", cred), false, "credencial de OUTRA edge");
  assertEquals(await verificarCredencial(CHAVE, "monthly-report", "zz" + cred.slice(2)), false, "hex inválido");
  assertEquals(await verificarCredencial(CHAVE, "monthly-report", cred.slice(0, 10)), false, "tamanho errado");
  assertEquals(await verificarCredencial(CHAVE, "monthly-report", cred.toUpperCase()), true, "hex maiúsculo é o mesmo valor");
  assertEquals(await verificarCredencial(CHAVE, "monthly-report", null), false, "ausente");
  assertEquals(await verificarCredencial(undefined, "monthly-report", cred), false, "chave ausente");
  assertEquals(await verificarCredencial("", "monthly-report", cred), false, "chave vazia");
});

Deno.test("chaveUtilizavel: ausente/vazia/curta → false (checagem de FORMA; a entropia vem do procedimento)", () => {
  assertEquals(chaveUtilizavel(undefined), false);
  assertEquals(chaveUtilizavel(""), false);
  assertEquals(chaveUtilizavel("curta"), false);
  assertEquals(chaveUtilizavel(CHAVE_FORTE), true);
});

Deno.test("atenderSondaOptions: só responde com credencial válida desta edge; nunca lê corpo; na dúvida, null", async () => {
  const cred = await derivarCredencial(CHAVE_FORTE, "monthly-report");
  const url = "http://x/functions/v1/monthly-report";
  const ok = await atenderSondaOptions(
    new Request(url, { method: "OPTIONS", headers: { [HEADER_SONDA]: cred } }),
    respostaSonda,
    "v9.9-teste",
    CHAVE_FORTE,
  );
  if (!ok) throw new Error("credencial válida tinha de responder");
  assertEquals(ok.status, 200);
  const corpo = await ok.json();
  assertEquals(corpo.ok, true);
  assertEquals(corpo.probe, true);
  assertEquals(corpo.edge, "monthly-report");
  assertEquals(corpo.versao, "v9.9-teste");
  assertEquals(typeof corpo.fonte, "string");

  const negativos: Record<string, Record<string, string>> = {
    ausente: {},
    invalida: { [HEADER_SONDA]: "zz" },
    outraEdge: { [HEADER_SONDA]: await derivarCredencial(CHAVE_FORTE, "calculate-scores") },
    outraChave: { [HEADER_SONDA]: await derivarCredencial(CHAVE_FORTE + "x", "monthly-report") },
  };
  for (const [nome, headers] of Object.entries(negativos)) {
    assertEquals(
      await atenderSondaOptions(new Request(url, { method: "OPTIONS", headers }), respostaSonda, "v9.9-teste", CHAVE_FORTE),
      null,
      nome,
    );
  }
  assertEquals(
    await atenderSondaOptions(
      new Request(url, { method: "OPTIONS", headers: { [HEADER_SONDA]: cred } }),
      respostaSonda,
      "v9.9-teste",
      "",
    ),
    null,
    "chave vazia",
  );
  // Sem o 4º argumento, o helper lê `SONDA_HMAC_KEY` do ambiente. Este teste roda no sandbox do
  // `deno test` SEM `--allow-env` (é assim que o `test:edges` do CI roda, e o flag não se afrouxa):
  // a leitura lança, o helper trata como ausência e devolve o CORS de sempre. Fail-closed provado
  // no ambiente em que ele mais importa — não é o caso de borda, é a configuração do CI.
  assertEquals(
    await atenderSondaOptions(
      new Request(url, { method: "OPTIONS", headers: { [HEADER_SONDA]: cred } }),
      respostaSonda,
      "v9.9-teste",
    ),
    null,
    "ambiente ilegível (sandbox sem --allow-env) → CORS, nunca crash",
  );
  assertEquals(
    await atenderSondaOptions(
      new Request(url, { method: "POST", headers: { [HEADER_SONDA]: cred }, body: "{}" }),
      respostaSonda,
      "v9.9-teste",
      CHAVE_FORTE,
    ),
    null,
    "método ≠ OPTIONS",
  );
});

Deno.test("montarRequestSonda: OPTIONS, um header, corpo nulo, redirect manual, URL do projeto", () => {
  const r = montarRequestSonda("https://ref.supabase.co", "monthly-report", "abc");
  assertEquals(r.method, METODO_SONDA);
  assertEquals([...r.headers.keys()], [HEADER_SONDA]);
  assertEquals(r.headers.get(HEADER_SONDA), "abc");
  assertEquals(r.body, null);
  assertEquals(r.redirect, "manual");
  assertEquals(r.url, "https://ref.supabase.co/functions/v1/monthly-report");
});

Deno.test("classificarRespostaAlvo: contrato COMPLETO atesta; qualquer coisa mais fraca não", () => {
  const bom = JSON.stringify({ ok: true, probe: true, versao: "v1.1-x", edge: "monthly-report", fonte: "a".repeat(64) });
  assertEquals(classificarRespostaAlvo("monthly-report", 200, "application/json", bom), { classe: "atestou", corpo: bom });
  assertEquals(classificarRespostaAlvo("monthly-report", 200, "text/plain;charset=UTF-8", "ok").classe, "cors-sem-sonda");
  assertEquals(classificarRespostaAlvo("monthly-report", 200, null, "").classe, "cors-sem-sonda");
  assertEquals(
    classificarRespostaAlvo("monthly-report", 200, "application/json", JSON.stringify({ probe: true, edge: "monthly-report", versao: "x" })).classe,
    "contrato-invalido",
    "sem ok/fonte",
  );
  assertEquals(
    classificarRespostaAlvo("monthly-report", 200, "application/json", JSON.stringify({ ok: true, probe: "true", edge: "monthly-report", versao: "x", fonte: "nao-mapeada" })).classe,
    "contrato-invalido",
    "probe string",
  );
  assertEquals(
    classificarRespostaAlvo("monthly-report", 200, "application/json", JSON.stringify({ ok: true, probe: true, edge: "outra", versao: "x", fonte: "nao-mapeada" })).classe,
    "identidade-divergente",
  );
  assertEquals(classificarRespostaAlvo("monthly-report", 200, "application/json", "[1]").classe, "contrato-invalido", "array");
  assertEquals(classificarRespostaAlvo("monthly-report", 200, "application/json", "{".padEnd(5000, " ")).classe, "contrato-invalido", "> 4 KB");
  for (const s of [301, 302, 303, 307, 308]) {
    assertEquals(classificarRespostaAlvo("monthly-report", s, null, "").classe, "redirect", `status ${s}`);
  }
  assertEquals(classificarRespostaAlvo("monthly-report", 500, null, "").classe, "erro-http");
});

Deno.test("barreiraSaida: só OPTIONS, só o header, corpo nulo, redirect manual, origem e path do alvo allowlisted", () => {
  const base = "https://ref.supabase.co";
  const allow = new Set(["monthly-report"]);
  const bom = montarRequestSonda(base, "monthly-report", "abc");
  assertEquals(barreiraSaida(bom, base, "monthly-report", allow), null);
  assertEquals(
    barreiraSaida(new Request(bom.url, { method: "POST", headers: { [HEADER_SONDA]: "abc" }, redirect: "manual" }), base, "monthly-report", allow)?.includes("OPTIONS"),
    true,
    "método",
  );
  assertEquals(
    barreiraSaida(new Request(bom.url, { method: "OPTIONS", headers: { [HEADER_SONDA]: "abc", "x-cron-secret": "s" }, redirect: "manual" }), base, "monthly-report", allow)?.includes("header"),
    true,
    "header a mais",
  );
  assertEquals(
    barreiraSaida(new Request(bom.url, { method: "OPTIONS", headers: { [HEADER_SONDA]: "abc" } }), base, "monthly-report", allow)?.includes("redirect"),
    true,
    "redirect default",
  );
  assertEquals(
    barreiraSaida(montarRequestSonda("https://outro.host", "monthly-report", "abc"), base, "monthly-report", allow)?.includes("origem"),
    true,
    "origem",
  );
  assertEquals(
    barreiraSaida(montarRequestSonda(base, "calculate-scores", "abc"), base, "calculate-scores", allow)?.includes("allowlist"),
    true,
    "alvo fora da allowlist",
  );
});
