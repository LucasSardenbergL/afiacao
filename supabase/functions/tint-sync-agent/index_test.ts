// index_test.ts — o HANDLER da `tint-sync-agent` executado, com um PostgREST falso que captura o
// que de fato sai pelo fio (scanner Lovable Security, lote 6 — money-path).
// Roda com: deno test --no-remote --allow-read=supabase/functions supabase/functions/tint-sync-agent/
//
// Por que existe: os testes dos módulos puros (`catalogo-rows_test.ts`, `snapshot-relogio_test.ts`)
// provam o builder e o validador, e não que a ROTA os usa. Acrescentar `created_at` à linha DEPOIS
// do builder, ou parar de conferir o veredito do relógio, deixava aquelas suítes verdes (achado do
// Codex no desenho). Aqui a prova é o corpo do POST que a edge manda ao banco:
//   · /catalogs — nas 6 escritas de staging, nenhuma linha e nenhum `columns=` carrega coluna do
//     servidor (`id`, `created_at`, `matched_id`), e as do servidor têm o valor do servidor;
//   · /keys-snapshot — `generated_at` ilegível ou no futuro responde 400 SEM escrever nada.
//
// O que este teste NÃO prova: default, constraint e RLS do banco de verdade, a promoção, o preço
// final, a purga, nem o bundle servido. O fake responde o que o supabase-js espera ouvir.
import { ENV_TESTE, igual, instalarHarness } from "../_shared/harness-handler_test.ts";

const h = instalarHarness();
// Import COMPUTADO de propósito: o `deno test` type-checa só o grafo ESTÁTICO, e o type-check do
// `index.ts` é do gate `edges:typecheck` (ver _shared/harness-handler_test.ts).
await import(new URL("./index.ts", import.meta.url).href);

const TOKEN = "token-de-teste";
const LOJA = "L1";
const CONTA = "oben";
const RUN = "11111111-2222-4333-8444-555555555555";
const SETTING = "99999999-8888-4777-8666-555555555555";
const PROIBIDAS = ["id", "created_at", "matched_id"];

interface Escrita {
  tabela: string;
  metodo: string;
  colunas: string | null;
  corpo: unknown;
}
const escritas: Escrita[] = [];

/** PostgREST mínimo: devolve o que cada passo da rota espera e guarda TODA escrita. */
h.responderForaDoGate(async (r) => {
  const url = new URL(r.url);
  const tabela = url.pathname.replace("/rest/v1/", "");
  const querObjeto = (r.headers.get("accept") ?? "").includes("vnd.pgrst.object");
  const json = (corpo: unknown, status = 200) =>
    new Response(JSON.stringify(corpo), { status, headers: { "content-type": "application/json" } });

  if (r.method === "GET" || r.method === "HEAD") {
    if (r.method === "HEAD") return new Response(null, { status: 200, headers: { "content-range": "0-0/1" } });
    if (tabela === "tint_integration_settings") {
      const linha = { id: SETTING, account: CONTA, store_code: LOJA, sync_enabled: true, integration_mode: "manual", sync_token: TOKEN };
      return json(querObjeto ? linha : [linha]);
    }
    return json([]);
  }

  escritas.push({ tabela, metodo: r.method, colunas: url.searchParams.get("columns"), corpo: await r.json().catch(() => null) });
  if (tabela === "tint_sync_runs" && r.method === "POST") return json(querObjeto ? { id: RUN } : [{ id: RUN }], 201);
  if (tabela === "tint_sync_runs" && r.method === "PATCH") return json([{ id: RUN }]);
  return new Response(null, { status: 201 });
});

function pedir(rota: string, corpo: unknown, token = TOKEN): Request {
  return new Request(`${ENV_TESTE.SUPABASE_URL}/functions/v1/tint-sync-agent/${rota}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-sync-token": token, "x-store-code": LOJA },
    body: JSON.stringify(corpo),
  });
}

function zerar() {
  escritas.length = 0;
  h.limpar();
}

/** Toda coluna do servidor com valor escolhido pelo agente, mais um campo que nem existe. */
const VENENO = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  created_at: "2099-01-01T00:00:00Z",
  matched_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  staging_status: "promoted",
  sync_run_id: "run-de-outro",
  account: "outra-conta",
  store_code: "OUTRA",
};

const LOTE_HOSTIL = {
  produtos: [{ ...VENENO, cod_produto: "P1", descricao: "Tinta base" }],
  bases: [{ ...VENENO, id_base_sayersystem: "B1", descricao: "Base P" }],
  embalagens: [{ ...VENENO, id_embalagem_sayersystem: "E1", descricao: "Galão", volume_ml: 3600 }],
  skus: [{ ...VENENO, cod_produto: "P1", id_base: "B1", id_embalagem: "E1" }],
  corantes: [
    { ...VENENO, id_corante_sayersystem: "C1", descricao: "Amarelo", volume_ml: 1000, custo: 0.01 },
    { id_corante_sayersystem: "C2", volume_ml: 950, preco_litro: 120 },
  ],
  precos_base: [{ ...VENENO, cod_produto: "P1", id_base: "B1", id_embalagem: "E1", custo: 50, imposto_pct: 10, margem_pct: 30 }],
};

const TABELAS_DE_STAGING = [
  "tint_staging_produtos",
  "tint_staging_bases",
  "tint_staging_embalagens",
  "tint_staging_skus",
  "tint_staging_corantes",
  "tint_staging_precos_base",
];

Deno.test("/catalogs: nenhuma linha entregue ao banco carrega coluna do servidor vinda do agente", async () => {
  zerar();
  const r = await h.handler()(pedir("catalogs", LOTE_HOSTIL));
  const corpo = await r.json();
  igual(r.status, 200, `status (corpo: ${JSON.stringify(corpo)})`);

  const staging = escritas.filter((e) => e.tabela.startsWith("tint_staging_"));
  // Presença: as 6 escritas, na ordem. Sem isto, uma rota que não grava nada passaria no resto.
  igual(staging.map((e) => `${e.metodo} ${e.tabela}`), TABELAS_DE_STAGING.map((t) => `POST ${t}`), "escritas de staging");

  let linhas = 0;
  for (const e of staging) {
    if (!Array.isArray(e.corpo) || e.corpo.length === 0) throw new Error(`${e.tabela}: corpo do insert não é lista com linha`);
    const colunas = (e.colunas ?? "").replaceAll('"', "").split(",");
    for (const proibida of PROIBIDAS) {
      if (colunas.includes(proibida)) throw new Error(`${e.tabela}: columns= carrega "${proibida}" (${e.colunas})`);
    }
    for (const linha of e.corpo as Record<string, unknown>[]) {
      linhas += 1;
      for (const proibida of PROIBIDAS) {
        if (proibida in linha) {
          throw new Error(`${e.tabela}: a linha entregue carrega "${proibida}" = ${JSON.stringify(linha[proibida])}`);
        }
      }
      // O que é do servidor tem o valor do servidor, não o do item.
      igual(
        [linha.sync_run_id, linha.account, linha.store_code, linha.staging_status],
        [RUN, CONTA, LOJA, "pending"],
        `${e.tabela}: colunas do servidor`,
      );
    }
  }
  igual(linhas, 7, "linhas entregues (7 itens enviados)");

  // Controle: o dado de NEGÓCIO do mesmo item hostil chegou — a ausência acima não é a de uma linha vazia.
  const corantes = staging[4].corpo as Record<string, unknown>[];
  igual([corantes[0].id_corante_sayersystem, corantes[0].custo, corantes[0].volume_ml], ["C1", 0.01, 1000], "corante hostil: negócio entra");
  igual((corantes[0].raw_data as Record<string, unknown>).created_at, "2099-01-01T00:00:00Z", "raw_data guarda o item como veio");
  igual([corantes[1].id_corante_sayersystem, corantes[1].preco_litro], ["C2", 120], "corante sem descrição: negócio entra");
  const precos = staging[5].corpo as Record<string, unknown>[];
  igual([precos[0].custo, precos[0].imposto_pct, precos[0].margem_pct], [50, 10, 30], "precos_base: negócio entra");
});

Deno.test("/catalogs: controle — o lote hostil trazia mesmo as colunas proibidas", () => {
  for (const [entidade, itens] of Object.entries(LOTE_HOSTIL)) {
    const item = itens[0] as Record<string, unknown>;
    for (const proibida of PROIBIDAS) {
      if (!(proibida in item)) throw new Error(`${entidade}: o item de teste não carrega "${proibida}" — o teste acima seria vácuo`);
    }
  }
});

Deno.test("token errado → 401 e ZERO escrita (o fake de auth não está aberto)", async () => {
  zerar();
  const r = await h.handler()(pedir("catalogs", LOTE_HOSTIL, "token-errado"));
  await r.body?.cancel();
  igual(r.status, 401, "status");
  igual(escritas.length, 0, "nenhuma escrita sem o token da loja");
});

const snapshot = (generated_at: unknown) => ({
  entity: "formulas",
  snapshot_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  generated_at,
  total_chunks: 1,
  chunk_index: 0,
  keys: ["COR1|P1|B1|false"],
});

Deno.test("/keys-snapshot: generated_at no futuro → 400 e ZERO escrita", async () => {
  for (const futuro of ["2099-01-01T00:00:00Z", new Date(Date.now() + 60 * 60_000).toISOString()]) {
    zerar();
    const r = await h.handler()(pedir("keys-snapshot", snapshot(futuro)));
    const corpo = await r.json();
    igual(r.status, 400, `status para ${futuro}`);
    if (!String(corpo.error).includes("in the future")) throw new Error(`recusou pelo motivo errado: ${corpo.error}`);
    igual(escritas.length, 0, `nenhuma escrita para ${futuro}`);
  }
});

Deno.test("/keys-snapshot: generated_at ilegível ou sem fuso → 400 e ZERO escrita", async () => {
  for (const ruim of ["ontem", "2026-11-17T03:03:41", 1_794_625_421_000, { ts: "2026-11-17T03:03:41Z" }]) {
    zerar();
    const r = await h.handler()(pedir("keys-snapshot", snapshot(ruim)));
    const corpo = await r.json();
    igual(r.status, 400, `status para ${JSON.stringify(ruim)}`);
    if (!String(corpo.error).includes("RFC 3339")) throw new Error(`recusou pelo motivo errado: ${corpo.error}`);
    igual(escritas.length, 0, `nenhuma escrita para ${JSON.stringify(ruim)}`);
  }
});

Deno.test("/keys-snapshot: controle — instante real do conector entra, gravado como veio", async () => {
  zerar();
  const gerado = new Date(Date.now() - 4 * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z"); // RFC 3339, ~4 min atrás
  const r = await h.handler()(pedir("keys-snapshot", snapshot(gerado)));
  const corpo = await r.json();
  igual(r.status, 200, `status (corpo: ${JSON.stringify(corpo)})`);
  igual(corpo.ok, true, "ok");
  const inserts = escritas.filter((e) => e.tabela === "tint_keys_snapshots" && e.metodo === "POST");
  igual(inserts.length, 1, "1 insert em tint_keys_snapshots");
  const linha = inserts[0].corpo as Record<string, unknown>;
  igual(linha.generated_at, gerado, "generated_at gravado exatamente como veio");
  igual([linha.setting_id, linha.account, linha.store_code], [SETTING, CONTA, LOJA], "colunas do servidor");
});

Deno.test("/keys-snapshot: 5 minutos à frente ainda entra (a tolerância é de 10)", async () => {
  zerar();
  const r = await h.handler()(pedir("keys-snapshot", snapshot(new Date(Date.now() + 5 * 60_000).toISOString())));
  await r.body?.cancel();
  igual(r.status, 200, "status");
  igual(escritas.filter((e) => e.tabela === "tint_keys_snapshots").length, 1, "1 insert");
});
