// Testa a apuração PURA do reprocessOrders (sync-reprocess) no runtime real (Deno).
// Roda com: deno test supabase/functions/sync-reprocess/apuracao-pedidos_test.ts
//
// Achado P2 do Codex (2026-09-27): quando TODOS os pedidos de uma página com ≥2 pedidos falham na
// RPC, a run aborta — e o catch gravava o log com `metadata: {}`. A `falhas_amostra` da página que
// abortou (e todo contador já apurado) se perdia exatamente na run que mais precisava dela.
// Estes testes EXECUTAM a sequência do index — montar (contador da página) → consolidar →
// `reconciliarPagina` com a RPC simulada → catch monta o metadata da run abortada — e fixam:
// (1) a página que aborta chega ao metadata; (2) fase não apurada vai `null`, nunca `0`/`[]`;
// (3) os números cobrem exatamente as páginas do denominador; (4) a decisão de abortar é a de
// antes; (5) o metadata da run completa não mudou de forma.
import {
  type ApuracaoPedidos,
  type ChamarRpcReconciliar,
  consolidarMontagem,
  contagensDoLog,
  metadataPedidos,
  novaApuracaoPedidos,
  novaMontagemPagina,
  paginaInteiraFalhou,
  reconciliarPagina,
  registrarDescontoIlegivel,
  registrarItemSemCodigo,
  somarRespostaRpc,
} from "./apuracao-pedidos.ts";
import { removerComentarios } from "../_shared/limpeza-fonte.ts";

// Asserts locais (o `test:edges` roda com `--no-remote`), no padrão de ./products-lote_test.ts.
function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(msg ?? `assertEquals falhou: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  }
}
function assert(cond: boolean, msg?: string) {
  if (!cond) throw new Error(msg ?? "assert falhou");
}
/** Exige que `fn` rejeite com a MARCA do ramo — "lançou algo" não prova qual guard disparou. */
async function lancaCom(fn: () => Promise<unknown>, marca: string, msg: string) {
  let erro: unknown = null;
  try {
    await fn();
  } catch (e) {
    erro = e;
  }
  assert(erro instanceof Error, `${msg}: não lançou`);
  assert((erro as Error).message.includes(marca), `${msg}: lançou outra coisa: ${(erro as Error).message}`);
}

/** Exige que `fn` NÃO lance — com marca, para o vermelho de uma regressão ser deste assert. */
async function naoLanca(fn: () => Promise<unknown>, marca: string) {
  try {
    await fn();
  } catch (e) {
    throw new Error(`${marca} lançou sem dever: ${e instanceof Error ? e.message : JSON.stringify(e)}`);
  }
}

const falha = (id: number) => ({ omie_pedido_id: id, sqlstate: "23514", erro: `viola check ${id}` });
const rpcOk = (data: unknown): ChamarRpcReconciliar => () => Promise.resolve({ data, error: null });
const rpcErro = (message: string): ChamarRpcReconciliar => () => Promise.resolve({ data: null, error: { message } });
const silenciar = async (fn: () => Promise<void>) => {
  const [e, w, l] = [console.error, console.warn, console.log];
  console.error = console.warn = console.log = () => {};
  try {
    await fn();
  } finally {
    [console.error, console.warn, console.log] = [e, w, l];
  }
};

/** Página montada inteira: o que o index faz entre o laço de pedidos e a RPC. */
function montar(ap: ApuracaoPedidos, pagina: number, total: number, itens: number, semCodigo: number[] = [], descIlegivel: number[] = []) {
  ap.paginaEmCurso = pagina;
  ap.totalPaginasDeclarado = total;
  const pg = novaMontagemPagina();
  pg.itensLidos += itens;
  for (const c of semCodigo) registrarItemSemCodigo(pg, c);
  for (const c of descIlegivel) registrarDescontoIlegivel(pg, c);
  consolidarMontagem(ap, pg);
}

Deno.test("cenário do Codex, EXECUTADO: pág 2 com 2 pedidos, os 2 falham → lança E a amostra da pág 2 chega ao metadata", async () => {
  const ap = novaApuracaoPedidos();
  await silenciar(async () => {
    montar(ap, 1, 2, 3, [901]);
    await naoLanca(() => reconciliarPagina(ap, 5, rpcOk({ upserts: 5, corrections: 1, divergences: 2, desconto_apurado: 4, desconto_corrigido: 1, falhas: [] }), "oben", 1), "[NAO-ABORTA-SEM-PAGINA-INTEIRA]");
    montar(ap, 2, 2, 2);
    await lancaCom(
      () => reconciliarPagina(ap, 2, rpcOk({ upserts: 0, desconto_apurado: 0, desconto_corrigido: 0, falhas: [falha(11), falha(12)] }), "oben", 2),
      "TODOS os 2 pedidos da pág 2",
      "[ABORTA-PAGINA-INTEIRA]",
    );
  });

  const m = metadataPedidos(ap, 7, { tipo: "abortada" });
  assertEquals(m.falhas_amostra, [
    { omie_pedido_id: 11, sqlstate: "23514", erro: "viola check 11" },
    { omie_pedido_id: 12, sqlstate: "23514", erro: "viola check 12" },
  ], "[AMOSTRA-DA-PAGINA-QUE-ABORTA]");
  assertEquals(m.falhas, 2);
  assertEquals(m.item_sem_codigo, 1);
  assertEquals(m.item_sem_codigo_amostra, [901]);
  assertEquals(m.itens_lidos, 5);
  assertEquals(m.desconto_apurado, 4);
  assertEquals(m.desconto_corrigido, 1);
  assertEquals(m.pages, 2);
  assertEquals(m.window_days, 7);
  assertEquals(m.abortada, true);
  assertEquals(m.pagina_abortada, 2);
  assertEquals(m.paginas_montadas, 2);
  assertEquals(m.paginas_reconciliadas, 2);
  assertEquals(contagensDoLog(ap, { tipo: "abortada" }), { upserts_count: 5, divergences_found: 2, corrections_applied: 1 });
});

Deno.test("EXECUTADO: erro da RPC na 1ª página LANÇA e a fase 2 fica null (não houve resposta para somar)", async () => {
  const ap = novaApuracaoPedidos();
  montar(ap, 1, 1, 4, [], [77]);
  await lancaCom(() => reconciliarPagina(ap, 3, rpcErro("function does not exist"), "colacor", 1), "RPC reconciliar_pedidos_omie falhou pág 1: function does not exist", "[RPC-ERRO-LANCA]");
  assertEquals(ap.paginasReconciliadas, 0, "[RPC-ERRO-NAO-RECONCILIA] página sem resposta não pode contar como reconciliada");
  const m = metadataPedidos(ap, 3, { tipo: "abortada" });
  assertEquals(m.itens_lidos, 4);
  assertEquals(m.desconto_ilegivel, 1);
  assertEquals(m.desconto_ilegivel_amostra, [77]);
  assertEquals(m.item_sem_codigo, 0, "fase 1 apurada: 0 aqui é medido, não fabricado");
  assertEquals(m.falhas, null, "[NAO-APURADO] falhas");
  assertEquals(m.falhas_amostra, null);
  assertEquals(m.desconto_apurado, null);
  assertEquals(contagensDoLog(ap, { tipo: "abortada" }), { upserts_count: null, divergences_found: null, corrections_applied: null });
});

Deno.test("EXECUTADO: erro da RPC na pág 2 → fase 1 cobre 2 páginas, fase 2 cobre 1 (denominadores dizem isso)", async () => {
  const ap = novaApuracaoPedidos();
  await silenciar(async () => {
    montar(ap, 1, 2, 3);
    await naoLanca(() => reconciliarPagina(ap, 3, rpcOk({ upserts: 3, desconto_apurado: 0, desconto_corrigido: 0 }), "oben", 1), "[NAO-ABORTA-SEM-PAGINA-INTEIRA]");
    montar(ap, 2, 2, 5);
    await lancaCom(() => reconciliarPagina(ap, 4, rpcErro("timeout"), "oben", 2), "falhou pág 2", "[RPC-ERRO-LANCA]");
  });
  const m = metadataPedidos(ap, 7, { tipo: "abortada" });
  assertEquals([m.paginas_montadas, m.paginas_reconciliadas, m.itens_lidos, m.falhas], [2, 1, 8, 0], "[DENOMINADORES-POR-FASE]");
  assertEquals(contagensDoLog(ap, { tipo: "abortada" }).upserts_count, 3);
});

Deno.test("EXECUTADO: página sem pedido elegível NÃO chama a RPC e conta como reconciliada (0 medido)", async () => {
  const ap = novaApuracaoPedidos();
  let chamadas = 0;
  montar(ap, 1, 1, 0);
  await reconciliarPagina(ap, 0, () => {
    chamadas++;
    return Promise.resolve({ data: {}, error: null });
  }, "oben", 1);
  assertEquals(chamadas, 0, "[SEM-PEDIDO-NAO-CHAMA-RPC]");
  const m = metadataPedidos(ap, 7, { tipo: "abortada" });
  assertEquals(m.falhas, 0, "[SEM-PEDIDO-CONTA-RECONCILIADA]");
  assertEquals(m.falhas_amostra, []);
  assertEquals(m.desconto_apurado, 0);
});

Deno.test("EXECUTADO: decisão de abortar inalterada — 1 pedido que falha sozinho e falha parcial NÃO lançam", async () => {
  const ap = novaApuracaoPedidos();
  await silenciar(async () => {
    const m = "[NAO-ABORTA-SEM-PAGINA-INTEIRA]";
    await naoLanca(() => reconciliarPagina(ap, 1, rpcOk({ falhas: [falha(1)], desconto_apurado: 0, desconto_corrigido: 0 }), "oben", 1), m);
    await naoLanca(() => reconciliarPagina(ap, 3, rpcOk({ falhas: [falha(2), falha(3)], desconto_apurado: 0, desconto_corrigido: 0 }), "oben", 2), m);
    await naoLanca(() => reconciliarPagina(ap, 3, rpcOk({ upserts: 3, desconto_apurado: 0, desconto_corrigido: 0 }), "oben", 3), m);
  });
  assertEquals([ap.falhas, ap.falhasAmostra.length, ap.paginasReconciliadas], [3, 3, 3], "[NAO-ABORTA-SEM-PAGINA-INTEIRA]");
  assertEquals(paginaInteiraFalhou(0, 0), false);
  assertEquals(paginaInteiraFalhou(2, 2), true);
  assertEquals(paginaInteiraFalhou(100, 100), true);
});

Deno.test("montagem que QUEBRA no meio da página não deixa parcela nos números (Codex, challenge desta entrega)", () => {
  // Pág 1: a montagem quebra depois de registrar 1 sem-código, 1 desconto ilegível e 1 item lido
  // (no index: `itens.filter is not a function` num `det` malformado). Nada consolidado.
  const ap = novaApuracaoPedidos();
  ap.paginaEmCurso = 1;
  ap.totalPaginasDeclarado = 1;
  const pg1 = novaMontagemPagina();
  pg1.itensLidos++;
  registrarItemSemCodigo(pg1, 1);
  registrarDescontoIlegivel(pg1, 2);
  const m1 = metadataPedidos(ap, 7, { tipo: "abortada" });
  assertEquals([m1.paginas_montadas, m1.itens_lidos, m1.item_sem_codigo, m1.desconto_ilegivel_amostra], [0, null, null, null], "[MONTAGEM-PARCIAL-VAZA]");

  // Pág 1 inteira (1 item), pág 2 quebra no meio: os números descrevem SÓ a pág 1.
  const ap2 = novaApuracaoPedidos();
  montar(ap2, 1, 2, 1);
  ap2.paginaEmCurso = 2;
  const pg2 = novaMontagemPagina();
  pg2.itensLidos++;
  registrarItemSemCodigo(pg2, 3);
  registrarDescontoIlegivel(pg2, 4);
  const m2 = metadataPedidos(ap2, 7, { tipo: "abortada" });
  assertEquals([m2.paginas_montadas, m2.itens_lidos, m2.item_sem_codigo, m2.item_sem_codigo_amostra, m2.desconto_ilegivel], [1, 1, 0, [], 0], "[MONTAGEM-PARCIAL-VAZA]");
});

Deno.test("abort ANTES de qualquer página (ex.: productMap falhou) → toda fase vai null, nunca 0 nem []", () => {
  const ap = novaApuracaoPedidos();
  const m = metadataPedidos(ap, 7, { tipo: "abortada" });
  for (const k of [
    "pages", "falhas", "sku_repetido", "ambiguos", "stale", "itens_lidos", "itens_com_codigo_item",
    "identidade_adotada", "identidade_usada", "desconto_ilegivel", "desconto_ilegivel_amostra",
    "item_sem_codigo", "item_sem_codigo_amostra", "falhas_amostra", "desconto_apurado", "desconto_corrigido",
    "pagina_abortada",
  ]) {
    assertEquals(m[k], null, `[NAO-APURADO] ${k} não foi apurado e não pode virar 0/[]`);
  }
  assertEquals(m.window_days, 7);
  assertEquals(m.paginas_montadas, 0);
  assertEquals(m.paginas_reconciliadas, 0);
  assertEquals(contagensDoLog(ap, { tipo: "abortada" }), { upserts_count: null, divergences_found: null, corrections_applied: null });
});

Deno.test("amostras têm teto 20 (também somando páginas) e a mensagem da falha é cortada em 160", () => {
  const ap = novaApuracaoPedidos();
  const muitas = Array.from({ length: 25 }, (_, i) => ({ omie_pedido_id: i, sqlstate: null, erro: "x".repeat(300) }));
  somarRespostaRpc(ap, { falhas: muitas, desconto_apurado: 0, desconto_corrigido: 0 });
  assertEquals(ap.falhas, 25);
  assertEquals(ap.falhasAmostra.length, 20);
  assertEquals((ap.falhasAmostra[0].erro as string).length, 160);
  montar(ap, 1, 2, 0, Array.from({ length: 15 }, (_, i) => i));
  montar(ap, 2, 2, 0, Array.from({ length: 15 }, (_, i) => 100 + i));
  assertEquals(ap.itemSemCodigo, 30);
  assertEquals(ap.itemSemCodigoAmostra.length, 20);
  assertEquals(ap.itemSemCodigoAmostra[15], 100, "a amostra guarda as PRIMEIRAS 20, como antes");
});

Deno.test("sensor do desconto: página SEM a chave torna o total null para o resto da run", () => {
  const ap = novaApuracaoPedidos();
  somarRespostaRpc(ap, { desconto_apurado: 3, desconto_corrigido: 1 });
  somarRespostaRpc(ap, {});
  somarRespostaRpc(ap, { desconto_apurado: 9, desconto_corrigido: 9 });
  assertEquals(ap.descontoApurado, null);
  assertEquals(ap.descontoCorrigido, null);
});

Deno.test("run COMPLETA: metadata com as MESMAS chaves e na MESMA ordem de antes (sem campos de abort)", () => {
  const ap = novaApuracaoPedidos();
  ap.totalPaginasDeclarado = 3;
  const m = metadataPedidos(ap, 7, { tipo: "completa" });
  assertEquals(Object.keys(m), [
    "pages", "window_days", "falhas", "sku_repetido", "ambiguos", "stale",
    "itens_lidos", "itens_com_codigo_item", "identidade_adotada", "identidade_usada",
    "desconto_ilegivel", "desconto_ilegivel_amostra", "item_sem_codigo", "item_sem_codigo_amostra",
    "falhas_amostra", "desconto_apurado", "desconto_corrigido",
  ]);
  // Janela sem pedido: na run completa, 0 é medido (o denominador `itens_lidos = 0` diz "sem dado").
  assertEquals(m.falhas, 0);
  assertEquals(m.itens_lidos, 0);
  assertEquals(m.falhas_amostra, []);
  assertEquals(m.pages, 3);
  assert(!("abortada" in m));
  assertEquals(contagensDoLog(ap, { tipo: "completa" }), { upserts_count: 0, divergences_found: 0, corrections_applied: 0 });
});

// ── PIN ESTRUTURAL do index: os testes acima EXECUTAM o módulo; o que sobra no index é fiação
//    (quem é chamado, em que ordem, e o catch). Sem este pin, voltar o catch para
//    `completeReprocessLog(...)` sem metadata ficaria VERDE. Lê o fonte SEM comentários pelo
//    stripper compartilhado (nunca regex local), e o alarme tem os dois lados: âncora de código
//    presente (sobre-limpeza apagaria) e frase de comentário ausente (sub-limpeza a deixaria).
Deno.test("PIN: o index monta por página, reconcilia pelo módulo e o catch grava o metadata da run abortada", async () => {
  const bruto = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const fonte = removerComentarios(bruto);
  assert(bruto.includes("A decisão de abortar não muda"), "controle: a frase-sentinela existe no comentário do catch");
  assert(!fonte.includes("A decisão de abortar não muda"), "sub-limpeza: o stripper deixou comentário no fonte medido");

  const ini = fonte.indexOf("async function reprocessOrders(");
  const fim = fonte.indexOf("async function reprocessProducts(");
  assert(ini >= 0 && fim > ini, "não achei o reprocessOrders no index (sobre-limpeza ou rename)");
  const corpo = fonte.slice(ini, fim);

  const iAp = corpo.indexOf("const ap = novaApuracaoPedidos();");
  const iTry = corpo.indexOf("try {");
  assert(iAp >= 0 && iAp < iTry, "[PIN-AP-FORA-DO-TRY] a apuração tem de nascer FORA do try — o catch a lê");

  // Fase 1: contador da PÁGINA, consolidado depois do laço de pedidos e antes da RPC; nenhum
  // contador de fase é mexido direto na apuração (isso reabriria a parcela sem denominador).
  const iPg = corpo.indexOf("const pg = novaMontagemPagina();");
  const iLaco = corpo.indexOf("for (const pedido of pedidos)");
  const iConsolida = corpo.indexOf("consolidarMontagem(ap, pg);");
  const iReconcilia = corpo.indexOf("await reconciliarPagina(ap, pedidosRpc.length,");
  assert(iPg >= 0 && iPg < iLaco, "[PIN-PG-POR-PAGINA] o contador da página tem de nascer antes do laço de pedidos");
  assert(iConsolida > iLaco && iConsolida < iReconcilia, "[PIN-CONSOLIDA-ANTES-DA-RPC] a montagem é consolidada depois do laço e antes da RPC");
  for (const campo of ["itensLidos", "itensComIdentidade", "descontoIlegivel", "itemSemCodigo", "paginasMontadas", "paginasReconciliadas"]) {
    assert(!corpo.includes(`ap.${campo}`), `[PIN-FASE-DIRETA] o index mexe em ap.${campo} por fora do módulo`);
  }
  assert(corpo.includes("registrarItemSemCodigo(pg, codigoPedido)") && corpo.includes("registrarDescontoIlegivel(pg, codigoPedido)"), "[PIN-REGISTRA-NA-PAGINA]");
  assert(corpo.slice(iReconcilia, iReconcilia + 300).includes('db.rpc("reconciliar_pedidos_omie"'), "[PIN-RPC-PELO-MODULO] a RPC é chamada dentro de reconciliarPagina");
  assert(corpo.includes("ap.totalPaginasDeclarado = totalPaginas"), "o teto lido não chega à apuração");
  assert(corpo.includes("ap.paginaEmCurso = pagina"), "a página em curso não chega à apuração");

  const iCatch = corpo.lastIndexOf("} catch (error) {");
  assert(iCatch > iReconcilia, "não achei o catch da run");
  const catchBloco = corpo.slice(iCatch);
  assert(catchBloco.includes('metadata: metadataPedidos(ap, windowDays, { tipo: "abortada" })'), "[PIN-CATCH-METADATA] o catch não grava o metadata da run abortada");
  assert(catchBloco.includes('...contagensDoLog(ap, { tipo: "abortada" })'), "[PIN-CATCH-CONTAGENS] o catch não grava as contagens com null no não apurado");
  assert(corpo.slice(0, iCatch).includes('metadata: metadataPedidos(ap, windowDays, { tipo: "completa" })'), "a run completa não usa o mesmo montador");
});
