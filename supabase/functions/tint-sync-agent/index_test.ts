// index_test.ts — o HANDLER da `tint-sync-agent` executado, com um PostgREST falso que captura o
// que de fato sai pelo fio (scanner Lovable Security, lote 6 — money-path).
// Roda com: deno test --no-remote --allow-read=supabase/functions supabase/functions/tint-sync-agent/
//
// Por que existe: os testes dos módulos puros (`catalogo-rows_test.ts`, `snapshot-relogio_test.ts`)
// provam o builder, a recusa e o validador, e não que a ROTA os usa. Acrescentar `created_at` à
// linha DEPOIS do builder, confirmar ao conector um lote com item recusado, ou parar de conferir o
// veredito do relógio deixava aquelas suítes verdes (achado do Codex no desenho). Aqui a prova é o
// corpo do POST que a edge manda ao banco e a resposta que ela dá ao conector:
//   · /catalogs — nenhuma linha e nenhum `columns=` carrega coluna do servidor (`id`,
//     `created_at`, `matched_id`); item com campo fora da lista não vira linha, conta em
//     `error_count`/`errors[]` (com isso o conector não confirma o lote) e fica em `tint_sync_errors`;
//     entidade gravável que não vem como lista é 400 sem escrita;
//   · /keys-snapshot — `generated_at` ilegível ou além da folga responde 400 SEM escrever nada.
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
/** Quantas respostas de `tint_sync_errors` o fake JÁ devolveu (a rota tem de esperar por elas, com teto). */
let registrosRespondidos = 0;
/** Quando ligado, o fake só responde `tint_sync_errors` depois que o staging de precos_base chegou. */
let segurar: { liberar: () => void; solto: Promise<void>; estourou: boolean } | null = null;
/** Quando ligado, o fake RECUSA o insert em `tint_sync_errors` (o supabase-js resolve com `error`, sem lançar). */
let recusarRegistro = false;

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
  if (tabela === "tint_sync_errors") {
    if (segurar) {
      // Segura o registro até a ÚLTIMA escrita de staging chegar. Se a rota esperar pelo registro
      // antes de gravar o staging, isto só solta pelo teto — e o teste acusa.
      const s = segurar;
      let teto: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([s.solto, new Promise<void>((res) => { teto = setTimeout(() => { s.estourou = true; res(); }, 1_500); })]);
      if (teto !== undefined) clearTimeout(teto);
    } else {
      await new Promise((res) => setTimeout(res, 20));
    }
    registrosRespondidos += 1;
    if (recusarRegistro) return json({ code: "XX000", message: "falha simulada do registro" }, 500);
    return new Response(null, { status: 201 });
  }
  if (tabela === "tint_staging_precos_base" && segurar) segurar.liberar();
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
  registrosRespondidos = 0;
  segurar = null;
  recusarRegistro = false;
  h.limpar();
}

const staging = () => escritas.filter((e) => e.tabela.startsWith("tint_staging_"));
const registros = () => escritas.filter((e) => e.tabela === "tint_sync_errors");

/** Nenhuma linha entregue ao banco, nem o `columns=`, carrega coluna que é do servidor. */
function semColunaDoServidor() {
  let linhas = 0;
  for (const e of staging()) {
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
  return linhas;
}

const TABELAS_DE_STAGING = [
  "tint_staging_produtos",
  "tint_staging_bases",
  "tint_staging_embalagens",
  "tint_staging_skus",
  "tint_staging_corantes",
  "tint_staging_precos_base",
];

/** O lote como o conector de verdade envia (connector/sayersync/sync.go). */
const LOTE_REAL = {
  produtos: [{ cod_produto: "P1", descricao: "Tinta base" }],
  bases: [{ id_base_sayersystem: "B1", descricao: "Base P" }],
  embalagens: [{ id_embalagem_sayersystem: "E1", descricao: "Galão", volume_ml: 3600 }],
  skus: [{ cod_produto: "P1", id_base: "B1", id_embalagem: "E1" }],
  corantes: [
    { id_corante_sayersystem: "C1", descricao: "Amarelo", volume_ml: 1000 },
    { id_corante_sayersystem: "C2", custo: 85.4, volume_ml: 950 },
  ],
  precos_base: [{ cod_produto: "P1", id_base: "B1", id_embalagem: "E1", custo: 50, imposto_pct: 10, margem_pct: 30 }],
};

Deno.test("/catalogs: lote real do conector — as 6 escritas na ordem, zero erro, nenhuma coluna do servidor", async () => {
  zerar();
  const r = await h.handler()(pedir("catalogs", LOTE_REAL));
  const corpo = await r.json();
  igual(r.status, 200, `status (corpo: ${JSON.stringify(corpo)})`);
  igual([corpo.ok, corpo.error_count, corpo.errors, corpo.received_count, corpo.inserted_count], [true, 0, [], 7, 7], "resposta ao conector");
  // Presença: as 6 escritas, na ordem. Sem isto, uma rota que não grava nada passaria no resto.
  igual(staging().map((e) => `${e.metodo} ${e.tabela}`), TABELAS_DE_STAGING.map((t) => `POST ${t}`), "escritas de staging");
  igual(semColunaDoServidor(), 7, "linhas entregues");
  igual(registros().length, 0, "nada em tint_sync_errors");
  const corantes = staging()[4].corpo as Record<string, unknown>[];
  igual([corantes[0].id_corante_sayersystem, corantes[0].descricao, corantes[0].volume_ml], ["C1", "Amarelo", 1000], "corante descritivo");
  igual([corantes[1].id_corante_sayersystem, corantes[1].custo, corantes[1].volume_ml], ["C2", 85.4, 950], "corante só de preço");
});

/** Toda coluna do servidor com valor escolhido pelo agente. */
const VENENO = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  created_at: "2099-01-01T00:00:00Z",
  matched_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
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

Deno.test("/catalogs: item com coluna do servidor é RECUSADO — não vira linha, conta como erro, o lote não é confirmado", async () => {
  zerar();
  const r = await h.handler()(pedir("catalogs", LOTE_HOSTIL));
  const corpo = await r.json();
  igual(r.status, 200, `status (corpo: ${JSON.stringify(corpo)})`);

  // O conector só confirma o lote com error_count == 0 e errors vazio (connector/sayersync/sync.go).
  igual([corpo.received_count, corpo.inserted_count, corpo.error_count], [7, 2, 5], "contagens da resposta");
  igual((corpo.errors as { entity_type: string }[]).map((e) => e.entity_type), ["produtos", "bases", "embalagens", "skus", "corantes"], "errors[] por entidade");
  for (const e of corpo.errors as { message: string }[]) {
    if (!e.message.includes("created_at") || !e.message.includes("1 item(ns) recusado(s)")) {
      throw new Error(`mensagem da recusa não nomeia o campo: ${e.message}`);
    }
  }

  // Só o corante limpo e o precos_base viram linha; nenhuma das 4 entidades só-hostis escreve.
  igual(staging().map((e) => e.tabela), ["tint_staging_corantes", "tint_staging_precos_base"], "escritas de staging");
  igual(semColunaDoServidor(), 2, "linhas entregues");
  const corantes = staging()[0].corpo as Record<string, unknown>[];
  igual(corantes.map((l) => l.id_corante_sayersystem), ["C2"], "o corante hostil (custo 0,01) não chegou ao staging");
  igual([corantes[0].preco_litro, corantes[0].volume_ml], [120, 950], "o corante limpo entra com o dado dele");
  const precos = staging()[1].corpo as Record<string, unknown>[];
  igual([precos[0].custo, precos[0].imposto_pct, precos[0].margem_pct], [50, 10, 30], "precos_base: negócio entra");

  // A recusa fica registrada, uma linha por entidade, com os nomes e sem o item — e a rota ESPEROU
  // o banco responder os 5 registros antes de devolver a resposta ao conector.
  igual(registros().map((e) => String((e.corpo as Record<string, unknown>).entity_type)).sort(), ["bases", "corantes", "embalagens", "produtos", "skus"], "tint_sync_errors por entidade");
  igual(registrosRespondidos, 5, "os 5 registros responderam antes da resposta da rota");
  for (const e of registros()) {
    const linha = e.corpo as Record<string, unknown>;
    igual(linha.sync_run_id, RUN, "registro no run do servidor");
    igual(linha.error_details, { campos: ["created_at", "id", "matched_id"], itens_recusados: 1, nao_objetos: 0 }, "detalhe da recusa");
    igual(linha.raw_data, null, "o item recusado não é copiado para o registro");
  }
});

Deno.test("/catalogs: o registro da recusa não segura a gravação dos itens limpos", async () => {
  zerar();
  let liberar: () => void = () => {};
  const solto = new Promise<void>((res) => {
    liberar = res;
  });
  segurar = { liberar, solto, estourou: false };
  const r = await h.handler()(pedir("catalogs", LOTE_HOSTIL));
  const corpo = await r.json();
  const estourou = segurar.estourou;
  segurar = null;
  igual(r.status, 200, `status (corpo: ${JSON.stringify(corpo)})`);
  // O fake só responde tint_sync_errors depois que o staging de precos_base chega. Se a rota
  // esperasse o registro ANTES de gravar, isso nunca aconteceria e o fake soltaria pelo teto.
  igual(estourou, false, "o staging chegou enquanto os registros da recusa ainda estavam pendentes");
  igual(staging().map((e) => e.tabela), ["tint_staging_corantes", "tint_staging_precos_base"], "os itens limpos foram gravados");
  igual([corpo.error_count, registrosRespondidos], [5, 5], "recusa na resposta e os 5 registros confirmados");
});

Deno.test("/catalogs: nome de campo com emoji na fronteira do corte não derruba o fechamento do run", async () => {
  zerar();
  const nome = "a".repeat(59) + "😀";
  const r = await h.handler()(pedir("catalogs", { produtos: [{ cod_produto: "P1", [nome]: 1 }, { cod_produto: "P2" }] }));
  const corpo = await r.json();
  igual(r.status, 200, "status");
  const mensagem = String((corpo.errors as { message: string }[])[0].message);
  // O que vai para o jsonb (resposta guardada do run e tint_sync_errors) não pode ter substituto isolado.
  for (const e of escritas) {
    const texto = JSON.stringify(e.corpo);
    if (/\\ud[89ab][0-9a-f]{2}(?!\\ud[c-f][0-9a-f]{2})/i.test(texto)) throw new Error(`${e.tabela}: substituto isolado no corpo gravado: ${texto.slice(0, 200)}`);
  }
  if (!mensagem.endsWith(nome)) throw new Error("o nome saiu cortado no meio do emoji: " + JSON.stringify(mensagem));
});

Deno.test("/catalogs: controle — o lote hostil trazia mesmo as colunas proibidas", () => {
  for (const [entidade, itens] of Object.entries(LOTE_HOSTIL)) {
    const item = itens[0] as Record<string, unknown>;
    for (const proibida of PROIBIDAS) {
      if (!(proibida in item)) throw new Error(`${entidade}: o item de teste não carrega "${proibida}" — o teste acima seria vácuo`);
    }
  }
});

Deno.test("/catalogs: campo de negócio desconhecido também recusa o item (o caso `ativo`, visto em campo)", async () => {
  zerar();
  const r = await h.handler()(pedir("catalogs", { produtos: [{ cod_produto: "P1", descricao: "x", ativo: true }, { cod_produto: "P2", descricao: "y" }] }));
  const corpo = await r.json();
  igual(r.status, 200, "status");
  igual([corpo.received_count, corpo.inserted_count, corpo.error_count], [2, 1, 1], "contagens");
  igual((corpo.errors as { message: string }[])[0].message, "1 item(ns) recusado(s): campo(s) fora da lista da entidade: ativo", "mensagem");
  igual((staging()[0].corpo as Record<string, unknown>[]).map((l) => l.cod_produto), ["P2"], "só o item limpo");
});

Deno.test("/catalogs: item que não é objeto é recusado — não derruba a rota nem vira linha de chave vazia", async () => {
  zerar();
  const r = await h.handler()(pedir("catalogs", { produtos: ["abc", [1, 2], null, { cod_produto: "P1" }] }));
  const corpo = await r.json();
  igual(r.status, 200, `status (corpo: ${JSON.stringify(corpo)})`);
  igual([corpo.received_count, corpo.inserted_count, corpo.error_count], [4, 1, 3], "contagens");
  igual((corpo.errors as { message: string }[])[0].message, "3 item(ns) recusado(s): 3 item(ns) que não são objeto", "mensagem");
  igual((staging()[0].corpo as Record<string, unknown>[]).map((l) => l.cod_produto), ["P1"], "só o objeto válido");
});

Deno.test("/catalogs: entidade gravável que não vem como lista → 400, sem run e sem escrita", async () => {
  for (const [lote, erro] of [
    [{ corantes: { id_corante_sayersystem: "C1", custo: 1 } }, "corantes: must be an array"],
    [{ produtos: [{ cod_produto: "P1" }], skus: "x" }, "skus: must be an array"],
    [{ precos_base: { custo: 1 } }, "precos_base: must be an array"],
    [[{ produtos: [] }], "body must be a JSON object"],
  ] as [unknown, string][]) {
    zerar();
    const r = await h.handler()(pedir("catalogs", lote));
    const corpo = await r.json();
    igual([r.status, corpo.ok, corpo.error], [400, false, erro], `resposta para ${JSON.stringify(lote)}`);
    igual(escritas.length, 0, `nenhuma escrita (nem o run) para ${JSON.stringify(lote)}`);
  }
});

Deno.test("/catalogs: `null` vale como entidade ausente — lote sem item gravável segue no ack sem run", async () => {
  zerar();
  const r = await h.handler()(pedir("catalogs", { corantes: null, padracores: [{ x: 1 }] }));
  const corpo = await r.json();
  igual([r.status, corpo.ok, corpo.sync_run_id, corpo.error_count], [200, true, null, 0], "ack sem run");
  igual(escritas.length, 0, "nenhuma escrita");
});

Deno.test("token errado → 401 e ZERO escrita (o fake de auth não está aberto)", async () => {
  zerar();
  const r = await h.handler()(pedir("catalogs", LOTE_REAL, "token-errado"));
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
const daqui = (minutos: number) => new Date(Date.now() + minutos * 60_000).toISOString();

Deno.test("/keys-snapshot: generated_at além da folga de 10 min → 400 e ZERO escrita", async () => {
  // +11 min prende a folga no HANDLER: com o relógio do servidor adiantado em 2 min o caso passaria.
  for (const futuro of ["2099-01-01T00:00:00Z", daqui(60), daqui(11)]) {
    zerar();
    const r = await h.handler()(pedir("keys-snapshot", snapshot(futuro)));
    const corpo = await r.json();
    igual(r.status, 400, `status para ${futuro}`);
    if (!String(corpo.error).includes("in the future")) throw new Error(`recusou pelo motivo errado: ${corpo.error}`);
    igual(escritas.length, 0, `nenhuma escrita para ${futuro}`);
  }
});

Deno.test("/keys-snapshot: generated_at ilegível, sem fuso ou fora do calendário → 400 e ZERO escrita", async () => {
  for (const ruim of ["ontem", "2026-11-17T03:03:41", "2026-02-30T00:00:00Z", 1_794_625_421_000, { ts: "2026-11-17T03:03:41Z" }]) {
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
  const gerado = daqui(-4).replace(/\.\d{3}Z$/, "Z"); // RFC 3339 sem fração, ~4 min atrás
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

Deno.test("/keys-snapshot: 9 minutos à frente ainda entra (a folga é de 10)", async () => {
  // −: com o relógio do servidor ATRASADO em 2 min o caso seria recusado.
  zerar();
  const r = await h.handler()(pedir("keys-snapshot", snapshot(daqui(9))));
  await r.body?.cancel();
  igual(r.status, 200, "status");
  igual(escritas.filter((e) => e.tabela === "tint_keys_snapshots").length, 1, "1 insert");
});

Deno.test("/catalogs: registro da recusa que o banco NÃO grava — a recusa segue na resposta e o console avisa", async () => {
  const avisos: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { avisos.push(args.map(String).join(" ")); };
  try {
    // controle: com o registro gravando, nenhum aviso
    zerar();
    const ok = await h.handler()(pedir("catalogs", { produtos: [{ cod_produto: "P1", created_at: "2099-01-01T00:00:00Z" }] }));
    igual([ok.status, (await ok.json()).error_count], [200, 1], "controle: recusa na resposta");
    igual(avisos.filter((a) => a.includes("NÃO foi gravado")).length, 0, "controle: sem aviso quando o registro grava");

    zerar();
    recusarRegistro = true;
    const r = await h.handler()(pedir("catalogs", { produtos: [{ cod_produto: "P1", created_at: "2099-01-01T00:00:00Z" }] }));
    const corpo = await r.json();
    igual([r.status, corpo.error_count, corpo.errors.length], [200, 1, 1], "a recusa não depende do registro");
    igual(registros().length, 1, "o registro foi tentado");
    igual(avisos.filter((a) => a.includes("registro da recusa em tint_sync_errors NÃO foi gravado")).length, 1, `um aviso no console (vieram: ${JSON.stringify(avisos)})`);
  } finally {
    console.error = original;
    zerar();
  }
});
