// catalogo-rows_test.ts — contrato item→staging da rota /catalogs (scanner Lovable, lote 6).
// Roda no CI via `bun run test:edges` (deno test --no-remote) — SEM import remoto.
//
// O que está em jogo (money-path): `created_at` da linha de staging é a chave que decide qual
// linha VENCE na promoção, no cálculo de preço e na purga. Até a v1.3 a rota copiava o item
// inteiro, e quem tem o token de sync escolhia essa coluna. Estes testes travam a lista fechada:
// do item só saem colunas de negócio; o que é do servidor nunca vem do agente.
import {
  chavesDescartadas,
  COLUNAS_DO_SERVIDOR_NO_STAGING,
  ENTIDADES_STAGING_CATALOGO,
  erroDeFormaDoLote,
  MAX_CAMPOS_NA_RECUSA,
  mensagemDeRecusa,
  separarLoteDeCatalogo,
  MAX_TAMANHO_DE_CHAVE_NO_AVISO,
  montarStagingCatalogoRow,
  STAGING_CATALOGO,
  type EntidadeStagingCatalogo,
  type TintCatalogItem,
} from "./catalogo-rows.ts";

function assertEq(atual: unknown, esperado: unknown, msg: string) {
  if (!Object.is(atual, esperado)) {
    throw new Error(`${msg}: esperado ${JSON.stringify(esperado)}, veio ${JSON.stringify(atual)}`);
  }
}

function chavesOrdenadas(o: Record<string, unknown>): string {
  return Object.keys(o).sort().join(",");
}

const RUN = "run-1";
const CONTA = "oben";
const LOJA = "L1";

/** As 5 colunas que o servidor SEMPRE põe na linha (as outras 3 do servidor ficam com o default do banco). */
const SERVIDOR_NA_LINHA = ["account", "raw_data", "staging_status", "store_code", "sync_run_id"];

/** Item hostil: toda coluna do servidor com valor escolhido pelo agente, mais lixo. */
function itemHostil(extra: Record<string, unknown> = {}): TintCatalogItem {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    created_at: "2099-01-01T00:00:00Z",
    matched_id: "22222222-2222-4222-8222-222222222222",
    staging_status: "promoted",
    sync_run_id: "run-de-outro",
    account: "outra-conta",
    store_code: "OUTRA",
    raw_data: { forjado: true },
    coluna_que_nao_existe: "x",
    ...extra,
  } as TintCatalogItem;
}

Deno.test("colunas do servidor NUNCA saem do item — created_at, id e matched_id ficam fora da linha", () => {
  for (const entidade of ENTIDADES_STAGING_CATALOGO) {
    const item = itemHostil({ [STAGING_CATALOGO[entidade].chave]: "K1" });
    const row = montarStagingCatalogoRow(entidade, item, RUN, CONTA, LOJA);
    // As três que o banco preenche: a CHAVE não pode existir na linha (senão o default não vale).
    for (const proibida of ["created_at", "id", "matched_id"]) {
      if (proibida in row) {
        throw new Error(`${entidade}: a linha carrega "${proibida}" vindo do agente: ${JSON.stringify(row[proibida])}`);
      }
    }
    // As que o servidor escreve: valor do servidor, não o do item.
    assertEq(row.sync_run_id, RUN, `${entidade}: sync_run_id`);
    assertEq(row.account, CONTA, `${entidade}: account`);
    assertEq(row.store_code, LOJA, `${entidade}: store_code`);
    assertEq(row.staging_status, "pending", `${entidade}: staging_status`);
    // raw_data é o item INTEIRO — o que foi descartado continua lá, como evidência. Compara o
    // CONTEÚDO: o que importa é o que vai gravado, não ser o mesmo objeto em memória.
    assertEq(JSON.stringify(row.raw_data), JSON.stringify(item), `${entidade}: raw_data é o item recebido`);
    assertEq((row.raw_data as TintCatalogItem).created_at, "2099-01-01T00:00:00Z", `${entidade}: a coluna forjada segue no raw_data`);
  }
});

Deno.test("o conjunto de chaves da linha é FECHADO: servidor + colunas de negócio da entidade", () => {
  // Item com TODA coluna de negócio de TODAS as entidades, mais as do servidor e lixo.
  const todas: Record<string, unknown> = {};
  for (const e of ENTIDADES_STAGING_CATALOGO) {
    for (const c of STAGING_CATALOGO[e].colunas) todas[c] = `v-${c}`;
  }
  const esperado: Record<EntidadeStagingCatalogo, string[]> = {
    produtos: ["cod_produto", "descricao"],
    bases: ["descricao", "id_base_sayersystem"],
    embalagens: ["descricao", "id_embalagem_sayersystem", "volume_ml"],
    skus: ["cod_produto", "id_base", "id_embalagem"],
    corantes: ["custo", "descricao", "id_corante_sayersystem", "preco_litro", "volume_ml"],
  };
  for (const entidade of ENTIDADES_STAGING_CATALOGO) {
    const row = montarStagingCatalogoRow(entidade, itemHostil(todas), RUN, CONTA, LOJA);
    assertEq(
      chavesOrdenadas(row),
      [...SERVIDOR_NA_LINHA, ...esperado[entidade]].sort().join(","),
      `${entidade}: chaves da linha`,
    );
  }
});

Deno.test("valor é pass-through: 0, null e '' chegam como vieram; ausente fica AUSENTE", () => {
  const row = montarStagingCatalogoRow(
    "corantes",
    { id_corante_sayersystem: "C1", custo: 0, volume_ml: null as unknown as number, descricao: "" },
    RUN,
    CONTA,
    LOJA,
  );
  assertEq(row.custo, 0, "custo 0 preservado");
  assertEq(row.volume_ml, null, "volume_ml null preservado");
  assertEq(row.descricao, "", "descricao '' preservada");
  // preco_litro não veio: a chave NÃO existe (o banco grava NULL) — nunca 0, nunca ''.
  if ("preco_litro" in row) {
    throw new Error("preco_litro ausente no item apareceu na linha: " + JSON.stringify(row.preco_litro));
  }
});

Deno.test("texto numérico não é convertido — quem valida o tipo é o banco", () => {
  const row = montarStagingCatalogoRow(
    "corantes",
    { id_corante_sayersystem: "C1", custo: "12,50" as unknown as number },
    RUN,
    CONTA,
    LOJA,
  );
  assertEq(row.custo, "12,50", "custo em texto passa como veio");
});

Deno.test("chave da entidade: própria → item.id → ''", () => {
  const propria = montarStagingCatalogoRow("bases", { id_base_sayersystem: "B7", id: "IGNORADO" }, RUN, CONTA, LOJA);
  assertEq(propria.id_base_sayersystem, "B7", "chave própria vence");
  const peloId = montarStagingCatalogoRow("bases", { id: "B9" }, RUN, CONTA, LOJA);
  assertEq(peloId.id_base_sayersystem, "B9", "sem chave própria, usa item.id");
  if ("id" in peloId) throw new Error("item.id virou a coluna id da linha: " + JSON.stringify(peloId.id));
  const vazia = montarStagingCatalogoRow("bases", { descricao: "sem chave" }, RUN, CONTA, LOJA);
  assertEq(vazia.id_base_sayersystem, "", "sem chave e sem id vira ''");
  // Chave vazia no item ('') cai no mesmo caminho: '' é falsy.
  const vaziaExplicita = montarStagingCatalogoRow("skus", { cod_produto: "", id: "P3" }, RUN, CONTA, LOJA);
  assertEq(vaziaExplicita.cod_produto, "P3", "chave '' cai para item.id");
});

Deno.test("só propriedade PRÓPRIA entra: herdada e __proto__ não viram coluna", () => {
  const herdado = Object.create({ custo: 999, descricao: "herdada" }) as TintCatalogItem;
  herdado.id_corante_sayersystem = "C1";
  const row = montarStagingCatalogoRow("corantes", herdado, RUN, CONTA, LOJA);
  if ("custo" in row || "descricao" in row) {
    throw new Error("propriedade herdada entrou na linha: " + JSON.stringify(row));
  }
  // JSON.parse cria `__proto__` como propriedade PRÓPRIA: não pode trocar o protótipo da linha.
  const comProto = JSON.parse('{"id_corante_sayersystem":"C2","__proto__":{"created_at":"2099-01-01"}}') as TintCatalogItem;
  const row2 = montarStagingCatalogoRow("corantes", comProto, RUN, CONTA, LOJA);
  assertEq(Object.getPrototypeOf(row2), Object.prototype, "protótipo da linha intacto");
  if ("created_at" in row2) throw new Error("created_at chegou pela cadeia de protótipo");
});

Deno.test("a lista fechada não contém coluna do servidor, e a chave consta nas colunas", () => {
  const doServidor = new Set<string>(COLUNAS_DO_SERVIDOR_NO_STAGING);
  for (const entidade of ENTIDADES_STAGING_CATALOGO) {
    const cfg = STAGING_CATALOGO[entidade];
    for (const c of cfg.colunas) {
      if (doServidor.has(c)) throw new Error(`${entidade}: "${c}" é coluna do servidor e está na lista do agente`);
    }
    if (!(cfg.colunas as readonly string[]).includes(cfg.chave)) {
      throw new Error(`${entidade}: a chave "${cfg.chave}" não está em colunas`);
    }
    if (!cfg.tabela.startsWith("tint_staging_")) throw new Error(`${entidade}: tabela fora do staging: ${cfg.tabela}`);
  }
  // As três que o ataque usava estão declaradas como do servidor (o teste acima depende disso).
  for (const c of ["created_at", "id", "matched_id"]) {
    if (!doServidor.has(c)) throw new Error(`"${c}" saiu de COLUNAS_DO_SERVIDOR_NO_STAGING`);
  }
});

Deno.test("ordem e tabelas de gravação são as de sempre", () => {
  assertEq(
    ENTIDADES_STAGING_CATALOGO.join(","),
    "produtos,bases,embalagens,skus,corantes",
    "ordem de gravação",
  );
  assertEq(
    ENTIDADES_STAGING_CATALOGO.map((e) => `${STAGING_CATALOGO[e].tabela}:${STAGING_CATALOGO[e].chave}`).join(" "),
    "tint_staging_produtos:cod_produto tint_staging_bases:id_base_sayersystem " +
      "tint_staging_embalagens:id_embalagem_sayersystem tint_staging_skus:cod_produto " +
      "tint_staging_corantes:id_corante_sayersystem",
    "tabela e chave por entidade",
  );
});

// ─── Caracterização: para o agente REAL a linha não muda ──────────────────────────────────────
// `linhaLegada` é a cópia fiel do que o index.ts fazia até a v1.3. Os formatos abaixo são os que
// o agente envia de verdade (chaves do `raw_data` das 3.000 linhas mais recentes de cada tabela,
// PROD 2026-11-17), mais o corante com custo e preço.
function linhaLegada(chave: string, item: TintCatalogItem): Record<string, unknown> {
  const entityKey = (item[chave] as string | undefined) || item.id || "";
  const row: Record<string, unknown> = {
    sync_run_id: RUN,
    account: CONTA,
    store_code: LOJA,
    raw_data: item,
    staging_status: "pending",
  };
  for (const [k, v] of Object.entries(item)) {
    if (k in row) continue;
    row[k] = v;
  }
  row[chave] = entityKey;
  if (item.descricao) row.descricao = item.descricao;
  if (item.volume_ml !== undefined) row.volume_ml = item.volume_ml;
  if (item.preco_litro !== undefined) row.preco_litro = item.preco_litro;
  if (item.custo !== undefined) row.custo = item.custo;
  if (item.id_base) row.id_base = item.id_base;
  if (item.id_embalagem) row.id_embalagem = item.id_embalagem;
  return row;
}

function igualProfundo(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.join(",") !== kb.join(",")) return false;
  return ka.every((k) => Object.is(a[k], b[k]));
}

Deno.test("agente real: a linha nova é IGUAL à legada, chave a chave", () => {
  const casos: [EntidadeStagingCatalogo, TintCatalogItem][] = [
    ["produtos", { cod_produto: "P1", descricao: "Tinta base" }],
    ["bases", { id_base_sayersystem: "B1", descricao: "Base P" }],
    ["embalagens", { id_embalagem_sayersystem: "E1", descricao: "Galão", volume_ml: 3600 }],
    ["skus", { cod_produto: "P1", id_base: "B1", id_embalagem: "E1" }],
    ["corantes", { id_corante_sayersystem: "C1", descricao: "Amarelo", volume_ml: 1000 }],
    ["corantes", { id_corante_sayersystem: "C1", descricao: "Amarelo", volume_ml: 1000, custo: 85.4, preco_litro: 120 }],
    // Linha SÓ de preço do corante (connector/sayersync/sync.go: id + custo/volume presentes, sem descrição).
    ["corantes", { id_corante_sayersystem: "C1", custo: 85.4, volume_ml: 1000 }],
    ["corantes", { id_corante_sayersystem: "C1", custo: 85.4 }],
    ["corantes", { id_corante_sayersystem: "C1" }],
  ];
  for (const [entidade, item] of casos) {
    const nova = montarStagingCatalogoRow(entidade, item, RUN, CONTA, LOJA);
    const legada = linhaLegada(STAGING_CATALOGO[entidade].chave, item);
    if (!igualProfundo(nova, legada)) {
      throw new Error(`${entidade}: divergiu da legada\n nova=${JSON.stringify(nova)}\n legada=${JSON.stringify(legada)}`);
    }
  }
});

Deno.test("controle da caracterização: a legada ACEITAVA o created_at do agente, a nova não", () => {
  const item = itemHostil({ id_corante_sayersystem: "C1", custo: 0.01, volume_ml: 1000 });
  const legada = linhaLegada("id_corante_sayersystem", item);
  assertEq(legada.created_at, "2099-01-01T00:00:00Z", "a legada copiava created_at (o furo)");
  const nova = montarStagingCatalogoRow("corantes", item, RUN, CONTA, LOJA);
  if ("created_at" in nova) throw new Error("a nova ainda copia created_at");
  // O dado de negócio do mesmo item continua entrando: o agente segue podendo mandar custo.
  assertEq(nova.custo, 0.01, "custo do item entra");
});

Deno.test("lote heterogêneo: a união das colunas do chunk é a mesma da legada", () => {
  // O bulk insert manda `columns` = união das chaves do chunk e o PostgREST grava NULL no que
  // faltar. Misturar linha descritiva com linha só de preço não pode mudar essa união.
  const itens: TintCatalogItem[] = [
    { id_corante_sayersystem: "C1", descricao: "Amarelo", volume_ml: 1000 },
    { id_corante_sayersystem: "C2", custo: 85.4 },
    { id_corante_sayersystem: "C3", custo: 12, volume_ml: 950 },
  ];
  const uniao = (linhas: Record<string, unknown>[]) => [...new Set(linhas.flatMap((l) => Object.keys(l)))].sort().join(",");
  const novas = itens.map((i) => montarStagingCatalogoRow("corantes", i, RUN, CONTA, LOJA));
  const legadas = itens.map((i) => linhaLegada("id_corante_sayersystem", i));
  assertEq(uniao(novas), uniao(legadas), "união das colunas do chunk");
  assertEq(
    uniao(novas),
    "account,custo,descricao,id_corante_sayersystem,raw_data,staging_status,store_code,sync_run_id,volume_ml",
    "união esperada",
  );
});

Deno.test("chavesDescartadas: nomeia o que a lista não gravou — do servidor e desconhecido —, sem repetir", () => {
  const itens: TintCatalogItem[] = [
    itemHostil({ id_corante_sayersystem: "C1", custo: 1 }),
    itemHostil({ id_corante_sayersystem: "C2", campo_novo_do_conector: 7 }),
  ];
  assertEq(
    chavesDescartadas("corantes", itens).join(","),
    "account,campo_novo_do_conector,coluna_que_nao_existe,created_at,id,matched_id,raw_data,staging_status,store_code,sync_run_id",
    "chaves descartadas",
  );
  // Coluna de negócio de OUTRA entidade também é descarte nesta (produtos não tem custo).
  assertEq(chavesDescartadas("produtos", [{ cod_produto: "P1", custo: 5 }]).join(","), "custo", "custo em produtos");
});

Deno.test("chavesDescartadas: agente real não gera aviso; `id` usado como chave não é descarte", () => {
  assertEq(chavesDescartadas("corantes", [{ id_corante_sayersystem: "C1", descricao: "A", volume_ml: 1, custo: 2, preco_litro: 3 }]).length, 0, "corante completo");
  assertEq(chavesDescartadas("skus", [{ cod_produto: "P1", id_base: "B1", id_embalagem: "E1" }]).length, 0, "sku");
  assertEq(chavesDescartadas("bases", []).length, 0, "lote vazio");
  assertEq(chavesDescartadas("bases", [{ id: "B9", descricao: "x" }]).length, 0, "id como chave da entidade");
  assertEq(chavesDescartadas("bases", [{ id: "B9", id_base_sayersystem: "B1" }]).join(","), "id", "id sobrando ao lado da chave");
});

Deno.test("chavesDescartadas: nome longo é truncado (o nome vem do agente)", () => {
  const longo = "x".repeat(500);
  const saida = chavesDescartadas("produtos", [{ cod_produto: "P1", [longo]: 1 }]);
  assertEq(saida.length, 1, "uma chave");
  assertEq(saida[0].length, MAX_TAMANHO_DE_CHAVE_NO_AVISO, "tamanho truncado");
  assertEq(MAX_TAMANHO_DE_CHAVE_NO_AVISO, 60, "teto");
});

Deno.test("chavesDescartadas: controle e separador de linha no nome viram '?' (o nome vai para o log)", () => {
  const item = JSON.parse('{"cod_produto":"P1","a\\nb":1,"c\\u2028d":2,"e\\u0000f":3,"normal":4}') as TintCatalogItem;
  assertEq(chavesDescartadas("produtos", [item]).join(","), "a?b,c?d,e?f,normal", "nomes saneados");
});

// ─── Recusa do item (o lote com campo fora da lista não é confirmado ao conector) ─────────────

Deno.test("separarLoteDeCatalogo: item com campo fora da lista é recusado INTEIRO; o vizinho limpo entra", () => {
  const limpo: TintCatalogItem = { id_corante_sayersystem: "C2", volume_ml: 950, custo: 12 };
  const lote = separarLoteDeCatalogo(
    "corantes",
    [itemHostil({ id_corante_sayersystem: "C1", custo: 0.01 }), limpo, { id_corante_sayersystem: "C3", campo_novo: 1 }],
    RUN,
    CONTA,
    LOJA,
  );
  assertEq(lote.recusados, 2, "recusados");
  assertEq(lote.naoObjetos, 0, "nenhum não-objeto");
  assertEq(lote.linhas.length, 1, "só o item limpo vira linha");
  assertEq(lote.linhas[0].id_corante_sayersystem, "C2", "a linha é a do item limpo");
  assertEq(lote.linhas[0].custo, 12, "com o dado dele");
  // A recusa é do item inteiro: o custo do item hostil NÃO chega ao staging.
  if (lote.linhas.some((l) => l.id_corante_sayersystem === "C1" || l.id_corante_sayersystem === "C3")) {
    throw new Error("item recusado virou linha: " + JSON.stringify(lote.linhas));
  }
  assertEq(
    lote.camposRecusados.join(","),
    "account,campo_novo,coluna_que_nao_existe,created_at,id,matched_id,raw_data,staging_status,store_code,sync_run_id",
    "campos que causaram a recusa",
  );
});

Deno.test("separarLoteDeCatalogo: agente real passa inteiro, na ordem, sem recusa", () => {
  const itens: TintCatalogItem[] = [
    { id_corante_sayersystem: "C1", descricao: "Amarelo", volume_ml: 1000 },
    { id_corante_sayersystem: "C2", custo: 85.4 },
    { id_corante_sayersystem: "C3" },
  ];
  const lote = separarLoteDeCatalogo("corantes", itens, RUN, CONTA, LOJA);
  assertEq(lote.recusados, 0, "recusados");
  assertEq(lote.camposRecusados.length, 0, "campos recusados");
  assertEq(lote.linhas.map((l) => l.id_corante_sayersystem).join(","), "C1,C2,C3", "ordem preservada");
  // A linha de cada item é exatamente a do builder.
  for (let i = 0; i < itens.length; i++) {
    const esperada = montarStagingCatalogoRow("corantes", itens[i], RUN, CONTA, LOJA);
    if (!igualProfundo(lote.linhas[i], esperada)) throw new Error(`linha ${i} difere da do builder`);
  }
  assertEq(separarLoteDeCatalogo("bases", [], RUN, CONTA, LOJA).linhas.length, 0, "lote vazio");
});

Deno.test("separarLoteDeCatalogo: item que não é objeto é recusado, não vira linha de chave vazia", () => {
  const lote = separarLoteDeCatalogo("produtos", ["abc", [1, 2], null, 5, true, { cod_produto: "P1" }], RUN, CONTA, LOJA);
  assertEq(lote.recusados, 5, "recusados");
  assertEq(lote.naoObjetos, 5, "todos por não serem objeto");
  assertEq(lote.camposRecusados.length, 0, "sem nome de campo: não havia objeto para ler");
  assertEq(lote.linhas.length, 1, "o objeto válido entra");
  assertEq(lote.linhas[0].cod_produto, "P1", "com a chave dele");
});

Deno.test("separarLoteDeCatalogo: `id` no lugar da chave não é recusa; `id` sobrando ao lado da chave é", () => {
  assertEq(separarLoteDeCatalogo("bases", [{ id: "B9", descricao: "x" }], RUN, CONTA, LOJA).recusados, 0, "id como chave");
  const sobrando = separarLoteDeCatalogo("bases", [{ id: "B9", id_base_sayersystem: "B1" }], RUN, CONTA, LOJA);
  assertEq(sobrando.recusados, 1, "id ao lado da chave");
  assertEq(sobrando.camposRecusados.join(","), "id", "o campo recusado é o id");
});

Deno.test("mensagemDeRecusa: conta os itens e nomeia os campos; acima do teto vira +N", () => {
  const lote = separarLoteDeCatalogo("produtos", [{ cod_produto: "P1", ativo: true }, { cod_produto: "P2", ativo: false, updated_at: "x" }, "abc"], RUN, CONTA, LOJA);
  assertEq(
    mensagemDeRecusa(lote),
    "3 item(ns) recusado(s): campo(s) fora da lista da entidade: ativo, updated_at; 1 item(ns) que não são objeto",
    "mensagem",
  );
  const muitos: Record<string, unknown> = { cod_produto: "P1" };
  for (let i = 0; i < MAX_CAMPOS_NA_RECUSA + 3; i++) muitos[`campo_${String(i).padStart(2, "0")}`] = i;
  const msg = mensagemDeRecusa(separarLoteDeCatalogo("produtos", [muitos], RUN, CONTA, LOJA));
  if (!msg.endsWith("campo_19 (+3)")) throw new Error("teto de nomes não aplicado: " + msg);
  assertEq(MAX_CAMPOS_NA_RECUSA, 20, "teto");
  // Só não-objeto: a mensagem não inventa a parte dos campos.
  assertEq(
    mensagemDeRecusa(separarLoteDeCatalogo("produtos", [null], RUN, CONTA, LOJA)),
    "1 item(ns) recusado(s): 1 item(ns) que não são objeto",
    "mensagem só de não-objeto",
  );
});

Deno.test("erroDeFormaDoLote: entidade gravável que não é lista recusa o lote; null e ausente não", () => {
  assertEq(erroDeFormaDoLote({ produtos: [], corantes: [{ id_corante_sayersystem: "C1" }] }), null, "listas");
  assertEq(erroDeFormaDoLote({}), null, "lote sem entidade");
  assertEq(erroDeFormaDoLote({ corantes: null, precos_base: undefined }), null, "null e ausente valem como não veio");
  assertEq(erroDeFormaDoLote({ padracores: { a: 1 } }), null, "entidade que a rota não grava não é conferida");
  assertEq(erroDeFormaDoLote({ corantes: { id_corante_sayersystem: "C1" } }), "corantes: must be an array", "objeto no lugar da lista");
  assertEq(erroDeFormaDoLote({ produtos: [], skus: "x" }), "skus: must be an array", "texto no lugar da lista");
  assertEq(erroDeFormaDoLote({ precos_base: 0 }), "precos_base: must be an array", "precos_base também é conferido");
  for (const corpo of [null, undefined, "x", 5, [], [{ produtos: [] }]]) {
    assertEq(erroDeFormaDoLote(corpo), "body must be a JSON object", `corpo ${JSON.stringify(corpo)}`);
  }
});
