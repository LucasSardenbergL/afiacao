// dono-pela-rls_test.ts — o gate de dono EXECUTADO, ramo a ramo, casando a MARCA de cada um
// (status + `code`) e a FORMA exata da sonda que sai para o PostgREST. Sem rede: `fetch` e
// `Deno.env.get` são os do harness. O que o PostgREST e a RLS respondem de verdade está provado
// à parte, no banco: `db/test-seg-lote5-dono-pela-rls.sh` (PG17).
// Roda com: deno test --no-remote --allow-read=supabase/functions supabase/functions/_shared/dono-pela-rls_test.ts
import { ENV_TESTE, igual, instalarHarness } from "./harness-handler_test.ts";

const ANON = "anon-de-teste";
const env: Record<string, string> = { ...ENV_TESTE, SUPABASE_ANON_KEY: ANON };
const h = instalarHarness(env);
// Importa DEPOIS dos stubs: `auth.ts` lê SUPABASE_URL/SERVICE_ROLE no topo do módulo.
const { authorizeCronOrStaff } = await import("./auth.ts");
const {
  DONO_GATE_INDISPONIVEL,
  DONO_ID_INVALIDO,
  DONO_SEM_JWT,
  DONO_SEM_PERMISSAO,
  exigirDonoPelaRls,
} = await import("./dono-pela-rls.ts");

const ID = "0b9a3c1e-7d2f-4e58-9a61-3f2c8d4b5a70";
const URL_EDGE = `${ENV_TESTE.SUPABASE_URL}/functions/v1/qualquer`;
const req = (headers: Record<string, string> = { Authorization: "Bearer jwt-employee" }) =>
  new Request(URL_EDGE, { method: "POST", headers });
const STAFF = { via: "staff" as const };

const json = (corpo: unknown, status = 200) =>
  new Response(JSON.stringify(corpo), { status, headers: { "content-type": "application/json" } });

/** Recusa com a marca do ramo: status + code. "Veio um erro qualquer" não passa. */
async function recusou(r: Awaited<ReturnType<typeof exigirDonoPelaRls>>, status: number, code: string, msg: string) {
  igual(r.ok, false, `${msg}: ok`);
  if (r.ok) throw new Error("inalcançável");
  igual(r.response.status, status, `${msg}: status`);
  const corpo = (await r.response.json()) as { code?: string; error?: string };
  igual(corpo.code, code, `${msg}: code`);
  if (typeof corpo.error !== "string" || corpo.error.length === 0) throw new Error(`${msg}: sem mensagem`);
}

Deno.test("cron e service_role passam direto: ok por servidor, ZERO fetch", async () => {
  h.limpar();
  h.responderForaDoGate(() => {
    throw new Error("cron/service_role não podem sondar: não têm usuário");
  });
  igual(await exigirDonoPelaRls(req({}), { via: "cron" }, "kb_documents", ID), { ok: true, por: "servidor" }, "cron");
  igual(
    await exigirDonoPelaRls(req({}), { via: "service_role" }, "farmer_calls", "nem-uuid-e-passa-como-antes"),
    { ok: true, por: "servidor" },
    "service_role",
  );
  igual(h.chamadas.length, 0, "zero fetch");
});

Deno.test("principal que não é cron, service_role nem staff → 503 fechado e ZERO fetch (nasce sem acesso)", async () => {
  h.limpar();
  h.responderForaDoGate(() => json([{ id: ID }]));
  for (const via of ["webhook", "", "STAFF", undefined]) {
    const principal = { via } as unknown as Parameters<typeof exigirDonoPelaRls>[1];
    await recusou(await exigirDonoPelaRls(req(), principal, "kb_documents", ID), 503, DONO_GATE_INDISPONIVEL, String(via));
  }
  igual(h.chamadas.length, 0, "zero fetch");
});

Deno.test("staff DONO: a sonda devolve a linha → ok por rls; a sonda é o PATCH no-op com o JWT do chamador", async () => {
  h.limpar();
  h.responderForaDoGate(() => json([{ id: ID }]));
  const r = await exigirDonoPelaRls(req(), STAFF, "kb_documents", ID);
  igual(r, { ok: true, por: "rls" }, "resultado");

  igual(h.chamadas.length, 1, "uma sonda, nada mais");
  const sonda = h.chamadas[0];
  igual(sonda.method, "PATCH", "método");
  // A URL INTEIRA: sem o filtro `id=eq.<id>` o corpo regravaria a PK de outra linha.
  igual(sonda.url, `${ENV_TESTE.SUPABASE_URL}/rest/v1/kb_documents?id=eq.${ID}&select=id`, "url");
  igual(await sonda.json(), { id: ID }, "corpo: a PK regravada com o MESMO valor do filtro");
  igual(sonda.headers.get("Authorization"), "Bearer jwt-employee", "Authorization é o do chamador");
  igual(sonda.headers.get("apikey"), ANON, "apikey é a anon");
  igual(sonda.headers.get("Prefer"), "return=representation", "Prefer");
  for (const [nome, valor] of sonda.headers) {
    if (valor.includes(ENV_TESTE.SUPABASE_SERVICE_ROLE_KEY)) {
      throw new Error(`a service-role saiu no header ${nome}: com ela a sonda diria "pode" para qualquer um`);
    }
  }
});

Deno.test("staff NÃO-dono: a RLS filtra e a sonda volta vazia → 403 DONO_SEM_PERMISSAO", async () => {
  h.limpar();
  h.responderForaDoGate(() => json([]));
  await recusou(await exigirDonoPelaRls(req(), STAFF, "kb_documents", ID), 403, DONO_SEM_PERMISSAO, "lista vazia");
  igual(h.chamadas.length, 1, "só a sonda saiu");
});

Deno.test("PostgREST responde 403 (42501) → 403 DONO_SEM_PERMISSAO", async () => {
  h.limpar();
  h.responderForaDoGate(() => json({ code: "42501", message: "new row violates row-level security policy" }, 403));
  await recusou(await exigirDonoPelaRls(req(), STAFF, "farmer_calls", ID), 403, DONO_SEM_PERMISSAO, "403 do banco");
});

Deno.test("sonda sem veredito → 503 DONO_GATE_INDISPONIVEL (fechado), nunca ok", async () => {
  const semVeredito: Array<[string, () => Response]> = [
    ["HTTP 500", () => json({ message: "boom" }, 500)],
    ["HTTP 401 (JWT expirou entre o gate e a sonda)", () => json({ code: "PGRST301" }, 401)],
    ["HTTP 404 (tabela fora do schema cache)", () => json({ code: "PGRST205" }, 404)],
    ["200 com objeto em vez de lista", () => json({ id: ID })],
    ["200 com corpo que não é JSON", () => new Response("<html>", { status: 200 })],
    ["200 com DUAS linhas", () => json([{ id: ID }, { id: ID }])],
    ["200 com a linha de OUTRO id", () => json([{ id: "11111111-2222-4333-8444-555555555555" }])],
    ["200 com linha sem id", () => json([{}])],
  ];
  for (const [nome, resposta] of semVeredito) {
    h.limpar();
    h.responderForaDoGate(resposta);
    await recusou(await exigirDonoPelaRls(req(), STAFF, "kb_documents", ID), 503, DONO_GATE_INDISPONIVEL, nome);
  }
});

Deno.test("fetch lança (rede/timeout) → 503 DONO_GATE_INDISPONIVEL", async () => {
  h.limpar();
  h.responderForaDoGate(() => {
    throw new TypeError("connection reset");
  });
  await recusou(await exigirDonoPelaRls(req(), STAFF, "kb_documents", ID), 503, DONO_GATE_INDISPONIVEL, "fetch lançou");
});

Deno.test("id que não é uuid → 400 DONO_ID_INVALIDO e ZERO fetch (nada vai para a URL)", async () => {
  h.responderForaDoGate(() => json([{ id: ID }]));
  const invalidos: unknown[] = [
    undefined,
    null,
    "",
    123,
    { id: ID },
    "abc",
    `${ID}&select=*`,
    `${ID},id.neq.x`,
    `eq.${ID}`,
    ` ${ID}`,
    `${ID}\n`,
    ID.replaceAll("-", ""),
  ];
  for (const id of invalidos) {
    h.limpar();
    await recusou(await exigirDonoPelaRls(req(), STAFF, "kb_documents", id), 400, DONO_ID_INVALIDO, JSON.stringify(id));
    igual(h.chamadas.length, 0, `zero fetch para ${JSON.stringify(id)}`);
  }
});

Deno.test("uuid em MAIÚSCULAS: filtro e corpo vão em minúsculas e a linha devolvida casa", async () => {
  h.limpar();
  h.responderForaDoGate(() => json([{ id: ID }]));
  const r = await exigirDonoPelaRls(req(), STAFF, "farmer_calls", ID.toUpperCase());
  igual(r, { ok: true, por: "rls" }, "resultado");
  igual(h.chamadas[0].url, `${ENV_TESTE.SUPABASE_URL}/rest/v1/farmer_calls?id=eq.${ID}&select=id`, "url");
  igual(await h.chamadas[0].json(), { id: ID }, "corpo");
});

Deno.test("staff sem Bearer → 401 DONO_SEM_JWT e ZERO fetch (não cai no service-role)", async () => {
  const semBearer: Array<Record<string, string>> = [{}, { Authorization: "Basic abc" }, { Authorization: "" }];
  for (const headers of semBearer) {
    h.limpar();
    h.responderForaDoGate(() => json([{ id: ID }]));
    await recusou(await exigirDonoPelaRls(req(headers), STAFF, "kb_documents", ID), 401, DONO_SEM_JWT, JSON.stringify(headers));
    igual(h.chamadas.length, 0, "zero fetch");
  }
});

Deno.test("SUPABASE_ANON_KEY ou SUPABASE_URL ausente → 503 fechado e ZERO fetch", async () => {
  for (const chave of ["SUPABASE_ANON_KEY", "SUPABASE_URL"]) {
    h.limpar();
    h.responderForaDoGate(() => json([{ id: ID }]));
    const antes = env[chave];
    delete env[chave];
    try {
      await recusou(await exigirDonoPelaRls(req(), STAFF, "kb_documents", ID), 503, DONO_GATE_INDISPONIVEL, chave);
      igual(h.chamadas.length, 0, `zero fetch sem ${chave}`);
    } finally {
      env[chave] = antes;
    }
  }
});

// A fronteira inteira, na ordem em que a edge a monta: `authorizeCronOrStaff` de verdade e o gate em
// seguida. É o que prova que o `via` do AuthResult chega ao gate como ele espera.
Deno.test("fronteira: JWT de employee NÃO-dono → 403 e só user + user_roles + a sonda saíram", async () => {
  h.limpar();
  h.responderForaDoGate(() => json([]));
  const r0 = req({ Authorization: "Bearer jwt-employee" });
  const auth = await authorizeCronOrStaff(r0);
  if (!auth.ok) throw new Error("employee tinha de passar no gate de staff");
  igual(auth.via, "staff", "via");
  await recusou(await exigirDonoPelaRls(r0, auth, "kb_documents", ID), 403, DONO_SEM_PERMISSAO, "employee não-dono");
  igual(
    h.chamadas.map((c) => `${c.method} ${new URL(c.url).pathname}`),
    ["GET /auth/v1/user", "GET /rest/v1/user_roles", "PATCH /rest/v1/kb_documents"],
    "sequência",
  );
});

Deno.test("fronteira: x-cron-secret (sinais-batch) → via cron, segue sem sondar", async () => {
  h.limpar();
  h.responderForaDoGate(() => {
    throw new Error("o cron não sonda");
  });
  const r0 = req({ "x-cron-secret": ENV_TESTE.CRON_SECRET });
  const auth = await authorizeCronOrStaff(r0);
  if (!auth.ok) throw new Error("cron tinha de passar");
  igual(await exigirDonoPelaRls(r0, auth, "farmer_calls", ID), { ok: true, por: "servidor" }, "cron segue");
  igual(h.chamadas.length, 0, "zero fetch");
});
