// Testa a apuração PURA do reprocessOrders (sync-reprocess) no runtime real (Deno).
// Roda com: deno test supabase/functions/sync-reprocess/apuracao-pedidos_test.ts
//
// Achado P2 do Codex (2026-09-27): quando TODOS os pedidos de uma página com ≥2 pedidos falham na
// RPC, a run aborta — e o catch gravava o log com `metadata: {}`. A `falhas_amostra` da página que
// abortou (e todo contador já apurado) se perdia exatamente na run que mais precisava dela.
// Estes testes reproduzem a sequência do index (montar → somar resposta → decidir abortar →
// metadata da run abortada) e fixam: (1) a página que aborta chega ao metadata; (2) fase não
// apurada vai `null`, nunca `0`/`[]`; (3) a decisão de abortar é a de antes; (4) o metadata da run
// completa não mudou de forma.
import {
  contagensDoLog,
  metadataPedidos,
  novaApuracaoPedidos,
  paginaInteiraFalhou,
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

const falha = (id: number) => ({ omie_pedido_id: id, sqlstate: "23514", erro: `viola check ${id}` });

Deno.test("cenário do Codex: página com 2 pedidos, os 2 falham → aborta E a amostra da página chega ao metadata", () => {
  const ap = novaApuracaoPedidos();
  // Página 1 saudável.
  ap.paginaEmCurso = 1;
  ap.totalPaginasDeclarado = 2;
  ap.itensLidos += 3;
  registrarItemSemCodigo(ap, 901);
  ap.paginasMontadas++;
  const f1 = somarRespostaRpc(ap, { upserts: 5, corrections: 1, divergences: 2, desconto_apurado: 4, desconto_corrigido: 1, falhas: [] });
  assertEquals(paginaInteiraFalhou(f1.length, 5), false);
  // Página 2: os 2 pedidos falham.
  ap.paginaEmCurso = 2;
  ap.itensLidos += 2;
  ap.paginasMontadas++;
  const f2 = somarRespostaRpc(ap, { upserts: 0, desconto_apurado: 0, desconto_corrigido: 0, falhas: [falha(11), falha(12)] });
  assertEquals(paginaInteiraFalhou(f2.length, 2), true, "a decisão de abortar é a de antes");

  const m = metadataPedidos(ap, 7, { tipo: "abortada" });
  assertEquals(m.falhas_amostra, [
    { omie_pedido_id: 11, sqlstate: "23514", erro: "viola check 11" },
    { omie_pedido_id: 12, sqlstate: "23514", erro: "viola check 12" },
  ]);
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

Deno.test("abort por ERRO da RPC na 1ª página → fase 1 apurada (números), fase 2 não (null)", () => {
  const ap = novaApuracaoPedidos();
  ap.paginaEmCurso = 1;
  ap.totalPaginasDeclarado = 1;
  ap.itensLidos += 4;
  ap.itensComIdentidade += 1;
  registrarDescontoIlegivel(ap, 77);
  ap.paginasMontadas++;
  // rpcErr → o index lança antes de somar: nenhuma resposta, paginasReconciliadas segue 0.
  const m = metadataPedidos(ap, 3, { tipo: "abortada" });
  assertEquals(m.itens_lidos, 4);
  assertEquals(m.itens_com_codigo_item, 1);
  assertEquals(m.desconto_ilegivel, 1);
  assertEquals(m.desconto_ilegivel_amostra, [77]);
  assertEquals(m.item_sem_codigo, 0, "fase 1 apurada: 0 aqui é medido, não fabricado");
  assertEquals(m.falhas, null);
  assertEquals(m.falhas_amostra, null);
  assertEquals(m.desconto_apurado, null);
  assertEquals(m.upserts_count, undefined);
  assertEquals(contagensDoLog(ap, { tipo: "abortada" }).upserts_count, null);
});

Deno.test("página sem nada a reconciliar conta como reconciliada (0 medido) — o index incrementa no else", () => {
  const ap = novaApuracaoPedidos();
  ap.paginaEmCurso = 1;
  ap.totalPaginasDeclarado = 1;
  ap.paginasMontadas++;
  ap.paginasReconciliadas++;
  const m = metadataPedidos(ap, 7, { tipo: "abortada" });
  assertEquals(m.falhas, 0);
  assertEquals(m.falhas_amostra, []);
  assertEquals(m.desconto_apurado, 0);
});

Deno.test("decisão de abortar inalterada: 1 pedido que falha não aborta; parcial não aborta; 0 falhas não aborta", () => {
  assertEquals(paginaInteiraFalhou(1, 1), false);
  assertEquals(paginaInteiraFalhou(1, 2), false);
  assertEquals(paginaInteiraFalhou(0, 0), false);
  assertEquals(paginaInteiraFalhou(0, 5), false);
  assertEquals(paginaInteiraFalhou(2, 2), true);
  assertEquals(paginaInteiraFalhou(100, 100), true);
});

Deno.test("amostras têm teto 20 e a mensagem da falha é cortada em 160", () => {
  const ap = novaApuracaoPedidos();
  const muitas = Array.from({ length: 25 }, (_, i) => ({ omie_pedido_id: i, sqlstate: null, erro: "x".repeat(300) }));
  somarRespostaRpc(ap, { falhas: muitas, desconto_apurado: 0, desconto_corrigido: 0 });
  assertEquals(ap.falhas, 25);
  assertEquals(ap.falhasAmostra.length, 20);
  assertEquals((ap.falhasAmostra[0].erro as string).length, 160);
  for (let i = 0; i < 25; i++) registrarItemSemCodigo(ap, i);
  assertEquals(ap.itemSemCodigo, 25);
  assertEquals(ap.itemSemCodigoAmostra.length, 20);
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

// ── PIN ESTRUTURAL do index: os testes acima provam o módulo, não que o `reprocessOrders` o usa.
//    Sem este pin, voltar o catch para `completeReprocessLog(...)` sem metadata ficaria VERDE.
//    Lê o fonte SEM comentários pelo stripper compartilhado (nunca regex local), e o alarme tem os
//    dois lados: âncora de código presente (sobre-limpeza apagaria) e frase de comentário ausente
//    (sub-limpeza a deixaria, e o pin passaria a medir prosa).
Deno.test("PIN: o catch do reprocessOrders grava o metadata da run abortada, e a soma precede a decisão de abortar", async () => {
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
  assert(iAp >= 0 && iAp < iTry, "a apuração tem de nascer FORA do try — o catch a lê");

  const iSoma = corpo.indexOf("somarRespostaRpc(ap, r)");
  const iDecide = corpo.indexOf("paginaInteiraFalhou(fails.length, pedidosRpc.length)");
  assert(iSoma >= 0 && iDecide > iSoma, "a resposta da página tem de ser somada ANTES da decisão de abortar");

  assert(corpo.includes("ap.paginasMontadas++"), "denominador da fase 1 não é incrementado");
  assert(corpo.includes("ap.paginasReconciliadas++"), "[PIN-DENOM-RPC] página sem nada a reconciliar não conta como reconciliada");
  assert(corpo.includes("ap.totalPaginasDeclarado = totalPaginas"), "o teto lido não chega à apuração");
  assert(corpo.includes("ap.paginaEmCurso = pagina"), "a página em curso não chega à apuração");

  const iCatch = corpo.lastIndexOf("} catch (error) {");
  assert(iCatch > iDecide, "não achei o catch da run");
  const catchBloco = corpo.slice(iCatch);
  assert(catchBloco.includes('metadata: metadataPedidos(ap, windowDays, { tipo: "abortada" })'), "[PIN-CATCH-METADATA] o catch não grava o metadata da run abortada");
  assert(catchBloco.includes('...contagensDoLog(ap, { tipo: "abortada" })'), "[PIN-CATCH-CONTAGENS] o catch não grava as contagens com null no não apurado");
  assert(corpo.slice(0, iCatch).includes('metadata: metadataPedidos(ap, windowDays, { tipo: "completa" })'), "a run completa não usa o mesmo montador");
});
