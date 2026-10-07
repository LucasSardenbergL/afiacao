// Testa a lógica PURA do reprocessProducts em LOTE (sync-reprocess) no runtime real (Deno).
// Roda com: deno test supabase/functions/sync-reprocess/products-lote_test.ts
//
// Contexto (2026-07-17): o reprocessProducts N+1 (2 round-trips PostgREST POR produto do
// ListarProdutos — 1 SELECT maybeSingle + 1 upsert) estourava o worker budget da edge no cron
// sync-reprocess-strategic (02:30 UTC) → HTTP 546 WORKER_RESOURCE_LIMIT, morte SEM exceção
// (o catch não roda) e órfã `running` em sync_reprocess_log — 52 órfãs de products/oben desde
// 28/02 (~1 a cada 2,7 dias). Mesma assinatura do inventory, curada nos PRs #1341/#1344.
// Este módulo isola a DECISÃO (filtros de exclusão, normalização, dedupe, divergência, row de
// upsert) do I/O, no padrão provado de inventory-lote.ts.
//
// Money-path (omie_products é o catálogo/preço que alimenta vendas e reposição): as
// invariantes finas são (a) filtros de exclusão FIÉIS ao N+1 (inativo, tipo K, famílias
// excluídas, jumbo, 810ml), (b) divergência com a MESMA comparação estrita do N+1
// (descricao com fallback "" e valor_unitario com fallback 0 — assimetria com o row
// preservada de propósito), (c) código ambíguo não conta divergência (fiel ao
// maybeSingle→PGRST116→null), (d) item malformado é descartado SOZINHO (no lote, um único
// item lixo derrubaria o chunk inteiro de 500 no Postgres; no N+1 o dano era 1 produto).
import {
  acumularProdutosDaPagina,
  EXCLUDED_FAMILIES,
  MAX_PAGINAS_PRODUTOS,
  planejarEscritaProdutos,
  type ProdutoCadastroOmie,
  SemValorUnitarioError,
} from "./products-lote.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(msg ?? `assertEquals falhou: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  }
}

const NOW = "2026-07-17T12:00:00.000Z";

// O payload do Omie AINDA traz o campo DEPRECATED de estoque; a interface não o declara de propósito
// (G5 do gate estoque-escritores). A fixture o carrega para provar que nada o lê.
const comCampoDeprecado = (ps: Array<ProdutoCadastroOmie & { quantidade_estoque?: unknown }>): ProdutoCadastroOmie[] => ps;

// ════════ acumularProdutosDaPagina — filtros de exclusão + normalização + dedupe ════════

Deno.test("acumular — produto elegível entra pela chave numérica; retorna quantos entraram", () => {
  const cat = new Map<number, ProdutoCadastroOmie>();
  const n = acumularProdutosDaPagina(cat, [
    { codigo_produto: 10, descricao: "Lixa 225", valor_unitario: 12.5 },
  ]);
  assertEquals(n, 1);
  assertEquals(cat.has(10), true);
  assertEquals(cat.get(10)?.descricao, "Lixa 225");
});

Deno.test("acumular — codigo_produto string numérica normaliza para chave number", () => {
  const cat = new Map<number, ProdutoCadastroOmie>();
  acumularProdutosDaPagina(cat, [{ codigo_produto: "77", descricao: "X" }]);
  assertEquals(cat.has(77), true);
  assertEquals(cat.size, 1);
});

// No N+1 o upsert com codigo_produto ausente tomava 23502 (NOT NULL) e falhava SÓ aquele
// produto; em lote o mesmo item derrubaria o chunk INTEIRO de 500 → descarta o ITEM.
Deno.test("acumular — código inválido (0/negativo/fracional/não-numérico/ausente) é descartado", () => {
  const cat = new Map<number, ProdutoCadastroOmie>();
  const n = acumularProdutosDaPagina(cat, [
    { codigo_produto: 0, descricao: "A" },
    { codigo_produto: -2, descricao: "B" },
    { codigo_produto: 1.5, descricao: "C" },
    { codigo_produto: "abc", descricao: "D" },
    { descricao: "E" },
    { codigo_produto: 88, descricao: "válido no meio do lixo" },
  ]);
  assertEquals(n, 1);
  assertEquals(cat.size, 1);
  assertEquals(cat.has(88), true);
});

Deno.test("acumular — inativo 'S' é descartado; 'N'/ausente entram (fiel ao N+1)", () => {
  const cat = new Map<number, ProdutoCadastroOmie>();
  const n = acumularProdutosDaPagina(cat, [
    { codigo_produto: 1, inativo: "S" },
    { codigo_produto: 2, inativo: "N" },
    { codigo_produto: 3 },
  ]);
  assertEquals(n, 2);
  assertEquals(cat.has(1), false);
  assertEquals(cat.has(2), true);
  assertEquals(cat.has(3), true);
});

Deno.test("acumular — tipo 'K' (kit) é descartado case-insensitive; outros tipos/ausente entram", () => {
  const cat = new Map<number, ProdutoCadastroOmie>();
  const n = acumularProdutosDaPagina(cat, [
    { codigo_produto: 1, tipo: "K" },
    { codigo_produto: 2, tipo: "k" },
    { codigo_produto: 3, tipo: "P" },
    { codigo_produto: 4 },
  ]);
  assertEquals(n, 2);
  assertEquals(cat.has(1), false);
  assertEquals(cat.has(2), false);
  assertEquals(cat.has(3), true);
  assertEquals(cat.has(4), true);
});

Deno.test("acumular — família excluída é descartada por INCLUDES, case-insensitive e com trim", () => {
  const cat = new Map<number, ProdutoCadastroOmie>();
  const n = acumularProdutosDaPagina(cat, [
    { codigo_produto: 1, descricao_familia: "  Uso e Consumo  " },
    { codigo_produto: 2, descricao_familia: "IMOBILIZADO GERAL" }, // includes pega substring
    { codigo_produto: 3, descricao_familia: "Matérias primas para conversão de cintas" },
    { codigo_produto: 4, descricao_familia: "Material para Tingimix" },
    { codigo_produto: 5, descricao_familia: "Abrasivos" },
    { codigo_produto: 6 }, // sem família entra
  ]);
  assertEquals(n, 2);
  assertEquals(cat.has(5), true);
  assertEquals(cat.has(6), true);
});

Deno.test("acumular — família começando com 'jumbo' é descartada (além das excluídas por includes)", () => {
  const cat = new Map<number, ProdutoCadastroOmie>();
  const n = acumularProdutosDaPagina(cat, [
    { codigo_produto: 1, descricao_familia: "Jumbos de lixa para discos" },
    { codigo_produto: 2, descricao_familia: "Jumbo qualquer outro" },
    { codigo_produto: 3, descricao_familia: "Lixa jumbo" }, // 'jumbo' no MEIO não pega no startsWith
  ]);
  assertEquals(n, 1);
  assertEquals(cat.has(3), true);
});

Deno.test("acumular — descrição com '810ml'/'810 ml' é descartada, case-insensitive", () => {
  const cat = new Map<number, ProdutoCadastroOmie>();
  const n = acumularProdutosDaPagina(cat, [
    { codigo_produto: 1, descricao: "Tinta 810ML especial" },
    { codigo_produto: 2, descricao: "Tinta 810 Ml especial" },
    { codigo_produto: 3, descricao: "Tinta 900ml" },
  ]);
  assertEquals(n, 1);
  assertEquals(cat.has(3), true);
});

// Codex P1 do #1353: Number(true)===1 — um boolean no codigo_produto viraria o código 1 e
// SOBRESCREVERIA o produto real de código 1 com dados de um item malformado (corrupção de
// catálogo). Código só pode chegar como number ou string (contrato Omie); o resto descarta.
Deno.test("acumular — codigo_produto boolean/array/objeto é descartado (nunca coage p/ código válido)", () => {
  const cat = new Map<number, ProdutoCadastroOmie>();
  const n = acumularProdutosDaPagina(cat, [
    { codigo_produto: true as unknown as number, descricao: "boolean vira 1 sem o guard" },
    { codigo_produto: [5] as unknown as number, descricao: "Number([5])===5 sem o guard" },
    { codigo_produto: {} as unknown as number, descricao: "objeto" },
  ]);
  assertEquals(n, 0);
  assertEquals(cat.size, 0);
});

// Codex P1 do #1353: no N+1, valor_unitario "abc" (truthy) ia pro payload e falhava SÓ aquele
// produto (22P02 silencioso); em lote derrubaria o chunk INTEIRO de 500. Descarta o ITEM —
// fiel em efeito (produto não escrito neste ciclo), nunca clampa lixo para 0 (fabricação).
Deno.test("acumular — valor_unitario LIXO (string não-numérica, NaN, ±Inf, boolean) descarta o ITEM", () => {
  const cat = new Map<number, ProdutoCadastroOmie>();
  const n = acumularProdutosDaPagina(cat, [
    { codigo_produto: 1, valor_unitario: "abc" as unknown as number },
    { codigo_produto: 3, valor_unitario: Number.NaN },
    { codigo_produto: 4, valor_unitario: Number.POSITIVE_INFINITY },
    { codigo_produto: 5, valor_unitario: true as unknown as number },
    { codigo_produto: 6, valor_unitario: 9.9 }, // válido no meio do lixo
  ]);
  assertEquals(n, 1);
  assertEquals(cat.size, 1);
  assertEquals(cat.has(6), true);
});

// 2026-10-06 (PR-2 do estoque com dono único): `quantidade_estoque` é "DEPRECATED." no Omie e não
// vai mais para a row — validá-lo descartava o PRODUTO (preço junto) por um campo que o passo não
// usa. O Omie serializa campo de esquema vazio como "" (cfop em 3.714/3.714): se o DEPRECATED
// passar a chegar assim, o descarte tiraria o catálogo inteiro da rodada.
Deno.test("acumular — lixo no quantidade_estoque (DEPRECATED, fora da row) NÃO tira o item", () => {
  const cat = new Map<number, ProdutoCadastroOmie>();
  const n = acumularProdutosDaPagina(cat, comCampoDeprecado([
    { codigo_produto: 2, valor_unitario: 1, quantidade_estoque: "lixo" },
    { codigo_produto: 4, valor_unitario: 1, quantidade_estoque: Number.POSITIVE_INFINITY },
    { codigo_produto: 7, valor_unitario: 1, quantidade_estoque: "" },
    { codigo_produto: 8, valor_unitario: 1, quantidade_estoque: true },
  ]));
  assertEquals(n, 4);
  assertEquals([...cat.keys()].sort((a, b) => a - b), [2, 4, 7, 8]);
});

// String numérica coage na ENTRADA (canônica): o N+1 mandava "5.5" cru e o Postgres coagia —
// funcionava. Coagir aqui preserva o efeito E mata o falso-positivo perpétuo de divergência
// (local 5.5 number vs "5.5" string divergia TODO ciclo no N+1 — decisão deliberada, ver
// comentário no módulo).
Deno.test("acumular — valor_unitario string NUMÉRICA coage para number", () => {
  const cat = new Map<number, ProdutoCadastroOmie>();
  const n = acumularProdutosDaPagina(cat, [
    { codigo_produto: 1, valor_unitario: "5.5" as unknown as number },
  ]);
  assertEquals(n, 1);
  assertEquals(cat.get(1)?.valor_unitario, 5.5);
});

Deno.test("acumular — mesmo código em páginas sucessivas: last-wins (dedupe p/ upsert em lote)", () => {
  const cat = new Map<number, ProdutoCadastroOmie>();
  acumularProdutosDaPagina(cat, [{ codigo_produto: 9, descricao: "v1", valor_unitario: 1 }]);
  acumularProdutosDaPagina(cat, [{ codigo_produto: 9, descricao: "v2", valor_unitario: 2 }]);
  assertEquals(cat.get(9)?.descricao, "v2");
  assertEquals(cat.size, 1); // duplicata no MESMO statement de upsert quebraria (21000)
});

Deno.test("acumular — versão INATIVA posterior não remove a elegível anterior (last-wins só entre elegíveis)", () => {
  const cat = new Map<number, ProdutoCadastroOmie>();
  acumularProdutosDaPagina(cat, [{ codigo_produto: 9, descricao: "v1" }]);
  acumularProdutosDaPagina(cat, [{ codigo_produto: 9, descricao: "v2", inativo: "S" }]);
  // Fiel ao N+1: o skip do inativo não desfazia o upsert já feito — a última versão ELEGÍVEL vale.
  assertEquals(cat.get(9)?.descricao, "v1");
});

// ════════ planejarEscritaProdutos — row de upsert + divergência ════════

Deno.test("planejar — row com os fallbacks do N+1 (produto mínimo: codigo_produto + preço)", () => {
  const cat = new Map<number, ProdutoCadastroOmie>();
  acumularProdutosDaPagina(cat, [{ codigo_produto: 42, valor_unitario: 0 }]);
  const plano = planejarEscritaProdutos(cat, [], "oben", NOW);
  assertEquals(plano.rows, [{
    omie_codigo_produto: 42,
    omie_codigo_produto_integracao: null,
    codigo: "PROD-42",
    descricao: "Sem descrição",
    unidade: "UN",
    ncm: null,
    valor_unitario: 0,
    ativo: true,
    familia: null,
    imagem_url: null,
    metadata: {},
    account: "oben",
    updated_at: NOW,
  }]);
});

Deno.test("planejar — row com campos preenchidos (imagem = primeira do array; metadata com o shape do N+1)", () => {
  const cat = new Map<number, ProdutoCadastroOmie>();
  acumularProdutosDaPagina(cat, comCampoDeprecado([{
    codigo_produto: 7,
    codigo_produto_integracao: "INT-7",
    codigo: "SKU-7",
    descricao: "Lixa 225",
    unidade: "PC",
    ncm: "6805.20.00",
    valor_unitario: 12.5,
    quantidade_estoque: 30,
    descricao_familia: "Abrasivos",
    imagens: [{ url_imagem: "https://a/1.png" }, { url_imagem: "https://a/2.png" }],
    marca: "Tyrolit",
    modelo: "M-1",
    peso_bruto: 1.2,
    peso_liq: 1.1,
    cfop: "5102",
  }]));
  const plano = planejarEscritaProdutos(cat, [], "colacor", NOW);
  assertEquals(plano.rows, [{
    omie_codigo_produto: 7,
    omie_codigo_produto_integracao: "INT-7",
    codigo: "SKU-7",
    descricao: "Lixa 225",
    unidade: "PC",
    ncm: "6805.20.00",
    valor_unitario: 12.5,
    ativo: true,
    familia: "Abrasivos",
    imagem_url: "https://a/1.png",
    metadata: {
      marca: "Tyrolit",
      modelo: "M-1",
      peso_bruto: 1.2,
      peso_liq: 1.1,
      descricao_familia: "Abrasivos",
      cfop: "5102",
    },
    account: "colacor",
    updated_at: NOW,
  }]);
});

Deno.test("planejar — rows cobrem TODOS os códigos acumulados (com e sem linha local)", () => {
  const cat = new Map<number, ProdutoCadastroOmie>();
  acumularProdutosDaPagina(cat, [
    { codigo_produto: 1, descricao: "A", valor_unitario: 0 },
    { codigo_produto: 2, descricao: "B", valor_unitario: 4 },
  ]);
  const plano = planejarEscritaProdutos(
    cat,
    [{ id: "u1", omie_codigo_produto: 1, descricao: "A", valor_unitario: 0 }],
    "oben",
    NOW,
  );
  assertEquals(plano.rows.map((r) => r.omie_codigo_produto), [1, 2]);
});

// 2026-10-01: `quantidade_estoque` é "DEPRECATED." na doc do Omie e chega como 0 — gravá-lo
// zerava o estoque de ~694 produtos posicionados até o passo de estoque, toda noite (a
// strategic contava 677–694 divergências em 19/19 noites; a operational, ≤13). O dono da
// coluna é o passo de estoque (ListarPosEstoque), inclusive o zero de quem saiu da lista.
Deno.test("planejar — a row NUNCA carrega a chave estoque (quantidade_estoque 30, 0 ou ausente)", () => {
  const cat = new Map<number, ProdutoCadastroOmie>();
  acumularProdutosDaPagina(cat, comCampoDeprecado([
    { codigo_produto: 1, valor_unitario: 5, quantidade_estoque: 30 },
    { codigo_produto: 2, valor_unitario: 5, quantidade_estoque: 0 },
    { codigo_produto: 3, valor_unitario: 5 },
  ]));
  const plano = planejarEscritaProdutos(cat, [], "oben", NOW);
  assertEquals(plano.rows.length, 3);
  assertEquals(plano.rows.filter((r) => Object.hasOwn(r, "estoque")).length, 0);
});

// O supabase-js manda `columns` = UNIÃO das chaves do lote e grava NULL na linha que não tem
// a chave (postgrest-js 2.110.7, upsert com defaultToNull=true). Omitir uma coluna só em
// ALGUMAS linhas apagaria o valor real (estoque) ou derrubaria o chunk (valor_unitario NOT
// NULL → 23502). Pino de forma: nasce verde, falsificado à parte.
Deno.test("planejar — todas as rows têm o MESMO conjunto de chaves (lote homogêneo para o upsert)", () => {
  const cat = new Map<number, ProdutoCadastroOmie>();
  acumularProdutosDaPagina(cat, comCampoDeprecado([
    { codigo_produto: 1, valor_unitario: 0 },
    {
      codigo_produto: 2,
      codigo_produto_integracao: "INT-2",
      codigo: "SKU-2",
      descricao: "Lixa",
      unidade: "PC",
      ncm: "6805.20.00",
      valor_unitario: 3,
      quantidade_estoque: 7,
      descricao_familia: "Abrasivos",
      imagens: [{ url_imagem: "https://a/1.png" }],
      marca: "M",
    },
  ]));
  const plano = planejarEscritaProdutos(cat, [], "oben", NOW);
  const formas = new Set(plano.rows.map((r) => Object.keys(r).sort().join(",")));
  assertEquals(plano.rows.length, 2);
  assertEquals(formas.size, 1);
});

// valor_unitario é obrigatório no cadastro do Omie; ausente é contrato quebrado, não preço 0.
// Fabricar 0 sobrescreveria o preço local; omitir só a coluna cairia no NULL do lote acima.
// O item inteiro fica de fora (o local é preservado) e o código é reportado.
Deno.test("planejar — valor_unitario AUSENTE: não vira row nem divergência e vai para semValorUnitario", () => {
  const cat = new Map<number, ProdutoCadastroOmie>();
  acumularProdutosDaPagina(cat, [
    { codigo_produto: 1, descricao: "Nova" },
    { codigo_produto: 2, descricao: "B", valor_unitario: 3 },
  ]);
  const plano = planejarEscritaProdutos(
    cat,
    [{ id: "u1", omie_codigo_produto: 1, descricao: "Antiga", valor_unitario: 12.5 }],
    "oben",
    NOW,
  );
  assertEquals(plano.rows.map((r) => r.omie_codigo_produto), [2]);
  assertEquals(plano.divergences, 0);
  assertEquals(plano.codigosDivergentes, []);
  assertEquals(plano.semValorUnitario, [1]);
});

// Todos sem preço = o contrato do ListarProdutos mudou. Nada é escrito de qualquer jeito; lançar
// é o que faz o run terminar `error` (o sensor sync_reprocess_saude lê status, não metadata).
Deno.test("planejar — TODOS os elegíveis sem valor_unitario: lança SemValorUnitarioError (nada escrito, run vira error)", () => {
  const cat = new Map<number, ProdutoCadastroOmie>();
  acumularProdutosDaPagina(cat, [{ codigo_produto: 1 }, { codigo_produto: 2 }]);
  let capturado: unknown = null;
  try {
    planejarEscritaProdutos(cat, [], "oben", NOW);
  } catch (e) {
    capturado = e;
  }
  assertEquals(capturado instanceof SemValorUnitarioError, true);
  assertEquals((capturado as SemValorUnitarioError).elegiveis, 2);
});

Deno.test("planejar — valor_unitario 0 PRESENTE (cadastro Omie sem preço) é dado, não ausência: grava 0", () => {
  const cat = new Map<number, ProdutoCadastroOmie>();
  acumularProdutosDaPagina(cat, [{ codigo_produto: 1, descricao: "A", valor_unitario: 0 }]);
  const plano = planejarEscritaProdutos(cat, [], "oben", NOW);
  assertEquals(plano.rows.map((r) => r.valor_unitario), [0]);
  assertEquals(plano.semValorUnitario, []);
});

Deno.test("planejar — divergência por DESCRIÇÃO diferente na linha local", () => {
  const cat = new Map<number, ProdutoCadastroOmie>();
  acumularProdutosDaPagina(cat, [{ codigo_produto: 1, descricao: "Nova", valor_unitario: 5 }]);
  const plano = planejarEscritaProdutos(
    cat,
    [{ id: "u1", omie_codigo_produto: 1, descricao: "Antiga", valor_unitario: 5 }],
    "oben",
    NOW,
  );
  assertEquals(plano.divergences, 1);
});

Deno.test("planejar — divergência por VALOR_UNITARIO diferente na linha local", () => {
  const cat = new Map<number, ProdutoCadastroOmie>();
  acumularProdutosDaPagina(cat, [{ codigo_produto: 1, descricao: "A", valor_unitario: 9.9 }]);
  const plano = planejarEscritaProdutos(
    cat,
    [{ id: "u1", omie_codigo_produto: 1, descricao: "A", valor_unitario: 5 }],
    "oben",
    NOW,
  );
  assertEquals(plano.divergences, 1);
});

Deno.test("planejar — local idêntico ao Omie NÃO diverge; produto novo (sem local) NÃO diverge", () => {
  const cat = new Map<number, ProdutoCadastroOmie>();
  acumularProdutosDaPagina(cat, [
    { codigo_produto: 1, descricao: "A", valor_unitario: 5 },
    { codigo_produto: 2, descricao: "Novo produto", valor_unitario: 1 },
  ]);
  const plano = planejarEscritaProdutos(
    cat,
    [{ id: "u1", omie_codigo_produto: 1, descricao: "A", valor_unitario: 5 }],
    "oben",
    NOW,
  );
  assertEquals(plano.divergences, 0);
  assertEquals(plano.rows.length, 2); // ausência de divergência NUNCA suprime a escrita
});

// A comparação de divergência do N+1 usa fallback "" para a descrição do Omie, mas o ROW
// grava "Sem descrição" — assimetria PRESERVADA de propósito (semântica de divergences_found
// intocada; unificar mudaria o sinal monitorado do strategic sem decisão do founder).
Deno.test("planejar — FIEL ao N+1: Omie sem descrição vs local 'Sem descrição' DIVERGE (cmp usa '')", () => {
  const cat = new Map<number, ProdutoCadastroOmie>();
  acumularProdutosDaPagina(cat, [{ codigo_produto: 1, valor_unitario: 5 }]);
  const plano = planejarEscritaProdutos(
    cat,
    [{ id: "u1", omie_codigo_produto: 1, descricao: "Sem descrição", valor_unitario: 5 }],
    "oben",
    NOW,
  );
  assertEquals(plano.divergences, 1);
});

Deno.test("planejar — valor_unitario local NULL vs Omie 0 PRESENTE DIVERGE (comparação estrita, fiel ao N+1)", () => {
  const cat = new Map<number, ProdutoCadastroOmie>();
  acumularProdutosDaPagina(cat, [{ codigo_produto: 1, descricao: "A", valor_unitario: 0 }]);
  const plano = planejarEscritaProdutos(
    cat,
    [{ id: "u1", omie_codigo_produto: 1, descricao: "A", valor_unitario: null }],
    "oben",
    NOW,
  );
  assertEquals(plano.divergences, 1); // null !== 0 — nada de coerção Number(null)===0
});

Deno.test("planejar — código AMBÍGUO (2 ids distintos) não conta divergência; row sai mesmo assim", () => {
  const cat = new Map<number, ProdutoCadastroOmie>();
  acumularProdutosDaPagina(cat, [{ codigo_produto: 1, descricao: "Nova", valor_unitario: 9 }]);
  const plano = planejarEscritaProdutos(
    cat,
    [
      { id: "u1", omie_codigo_produto: 1, descricao: "Antiga", valor_unitario: 5 },
      { id: "u2", omie_codigo_produto: 1, descricao: "Outra", valor_unitario: 7 },
    ],
    "oben",
    NOW,
  );
  // Fiel ao N+1: maybeSingle com 2 linhas → PGRST116 → existing null → sem divergência.
  // Impossível pelo UNIQUE(omie_codigo_produto,account) + filtro .eq(account) — defense-in-depth.
  assertEquals(plano.divergences, 0);
  assertEquals(plano.rows.length, 1);
});

Deno.test("planejar — MESMA linha repetida (mesmo id 2x) não é ambígua; compara normal", () => {
  const cat = new Map<number, ProdutoCadastroOmie>();
  acumularProdutosDaPagina(cat, [{ codigo_produto: 1, descricao: "Nova", valor_unitario: 5 }]);
  const plano = planejarEscritaProdutos(
    cat,
    [
      { id: "u1", omie_codigo_produto: 1, descricao: "Antiga", valor_unitario: 5 },
      { id: "u1", omie_codigo_produto: 1, descricao: "Antiga", valor_unitario: 5 },
    ],
    "oben",
    NOW,
  );
  assertEquals(plano.divergences, 1); // repetição de transporte ≠ ambiguidade de dados
});

// Codex P2 do #1353: corrections_applied=divergences mentia sob falha PARCIAL de chunk
// (contava correção de linha que nunca foi escrita). O plano expõe QUAIS códigos divergiram;
// o caller soma corrections só dos chunks que ESCREVERAM.
Deno.test("planejar — codigosDivergentes lista exatamente os códigos que contaram divergência", () => {
  const cat = new Map<number, ProdutoCadastroOmie>();
  acumularProdutosDaPagina(cat, [
    { codigo_produto: 1, descricao: "Nova", valor_unitario: 5 },
    { codigo_produto: 2, descricao: "Igual", valor_unitario: 3 },
    { codigo_produto: 3, descricao: "Preço mudou", valor_unitario: 9 },
  ]);
  const plano = planejarEscritaProdutos(
    cat,
    [
      { id: "u1", omie_codigo_produto: 1, descricao: "Antiga", valor_unitario: 5 },
      { id: "u2", omie_codigo_produto: 2, descricao: "Igual", valor_unitario: 3 },
      { id: "u3", omie_codigo_produto: 3, descricao: "Preço mudou", valor_unitario: 4 },
    ],
    "oben",
    NOW,
  );
  assertEquals(plano.codigosDivergentes, [1, 3]);
  assertEquals(plano.divergences, 2); // divergences === codigosDivergentes.length, sempre
});

// ════════ constantes ════════

Deno.test("EXCLUDED_FAMILIES e teto de páginas preservados do N+1", () => {
  assertEquals(EXCLUDED_FAMILIES.length, 5);
  assertEquals(MAX_PAGINAS_PRODUTOS, 500);
});
