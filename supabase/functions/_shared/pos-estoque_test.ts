// Testa o CÓDIGO REAL de pos-estoque.ts (não uma cópia) no runtime real (Deno).
// Roda com: deno test supabase/functions/_shared/pos-estoque_test.ts
//
// Normalização do ListarPosEstoque compartilhada por sync-reprocess e omie-analytics-sync.
// Casos movidos verbatim de sync-reprocess/inventory-lote_test.ts (#1341) quando a função
// subiu p/ _shared/ (o canônico ganhou a mesma validação de finitude + dedupe last-wins).
import { acumularPosicoesDaPagina, numeroExplicito, type PosicaoEstoque } from "./pos-estoque.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(msg ?? `assertEquals falhou: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  }
}

Deno.test("acumular — posição válida entra normalizada; retorna quantos válidos", () => {
  const pos = new Map<number, PosicaoEstoque>();
  const n = acumularPosicoesDaPagina(pos, [
    { nCodProd: 10, nSaldo: 5, nCMC: 2.5, nPrecoMedio: 3 },
  ]);
  assertEquals(n, 1);
  assertEquals(pos.get(10), { saldo: 5, cmc: 2.5, precoMedio: 3 });
});

Deno.test("acumular — nCodProd string numérica normaliza para chave number", () => {
  const pos = new Map<number, PosicaoEstoque>();
  acumularPosicoesDaPagina(pos, [{ nCodProd: "77", nSaldo: 1, nCMC: 1, nPrecoMedio: 1 }]);
  assertEquals(pos.has(77), true);
  assertEquals(pos.size, 1);
});

Deno.test("acumular — código inválido (0/negativo/fracional/não-numérico/ausente) é descartado", () => {
  const pos = new Map<number, PosicaoEstoque>();
  const n = acumularPosicoesDaPagina(pos, [
    { nCodProd: 0, nSaldo: 1 },
    { nCodProd: -2, nSaldo: 1 },
    { nCodProd: 1.5, nSaldo: 1 },
    { nCodProd: "abc", nSaldo: 1 },
    { nSaldo: 1 },
  ]);
  assertEquals(n, 0);
  assertEquals(pos.size, 0); // Number(undefined)=NaN / Number("")=0 nunca viram entrada
});

// O SALDO tem de vir explícito (2026-10-05, Codex P1 no desenho do estoque com dono): `nSaldo`
// ausente virava 0 e o item contava como válido — um zero fabricado que ia direto ao espelho, sem
// passar por teto nenhum. Agora o item sai do retrato; o código dele fica fora de `posicoes`, e
// quem tem saldo local ≠ 0 vira candidato à CONFIRMAÇÃO explícita (_shared/zeramento-estoque.ts).
Deno.test("acumular — nSaldo ausente/null/vazio/branco descarta o ITEM (ausente ≠ zero)", () => {
  const pos = new Map<number, PosicaoEstoque>();
  const n = acumularPosicoesDaPagina(pos, [
    { nCodProd: 5 },
    { nCodProd: 6, nSaldo: null as unknown as number },
    { nCodProd: 7, nSaldo: "" as unknown as number },
    { nCodProd: 8, nSaldo: "  " as unknown as number },
    { nCodProd: 9, nSaldo: true as unknown as number },
  ]);
  assertEquals(n, 0);
  assertEquals(pos.size, 0);
});

Deno.test("acumular — nSaldo 0 EXPLÍCITO é observação válida", () => {
  const pos = new Map<number, PosicaoEstoque>();
  const n = acumularPosicoesDaPagina(pos, [{ nCodProd: 5, nSaldo: 0, nCMC: 4, nPrecoMedio: 6 }]);
  assertEquals(n, 1);
  assertEquals(pos.get(5), { saldo: 0, cmc: 4, precoMedio: 6 });
});

// nCMC/nPrecoMedio ausentes seguem `?? 0` (comportamento do N+1, fora deste escopo): o gate
// money-path do custo está adiante — cmc<=0 NÃO vira candidato a product_costs.
Deno.test("acumular — nCMC/nPrecoMedio ausentes com nSaldo explícito seguem 0", () => {
  const pos = new Map<number, PosicaoEstoque>();
  acumularPosicoesDaPagina(pos, [{ nCodProd: 5, nSaldo: 3 }]);
  assertEquals(pos.get(5), { saldo: 3, cmc: 0, precoMedio: 0 });
});

Deno.test("numeroExplicito — número finito ou string numérica; o resto é null", () => {
  assertEquals(numeroExplicito(0), 0);
  assertEquals(numeroExplicito(-2.5), -2.5);
  assertEquals(numeroExplicito("5.5"), 5.5);
  assertEquals(numeroExplicito(" 7 "), 7);
  for (const v of [undefined, null, "", "  ", "abc", true, false, {}, [], Number.NaN, Number.POSITIVE_INFINITY]) {
    assertEquals(numeroExplicito(v), null, `numeroExplicito(${String(v)}) deveria ser null`);
  }
});

Deno.test("acumular — mesmo código em páginas sucessivas: last-wins (dedupe p/ upsert em lote)", () => {
  const pos = new Map<number, PosicaoEstoque>();
  acumularPosicoesDaPagina(pos, [{ nCodProd: 9, nSaldo: 1, nCMC: 1, nPrecoMedio: 1 }]);
  acumularPosicoesDaPagina(pos, [{ nCodProd: 9, nSaldo: 4, nCMC: 2, nPrecoMedio: 2 }]);
  assertEquals(pos.get(9), { saldo: 4, cmc: 2, precoMedio: 2 });
  assertEquals(pos.size, 1); // duplicata no MESMO statement de upsert quebraria (21000)
});

// Drift de contrato (Codex P2 #1341): um único valor não-numérico (NaN/±Inf/lixo) derrubaria
// o chunk INTEIRO de 500 no Postgres; no N+1 o dano era restrito àquele produto. Descarta o
// ITEM (fiel em efeito: produto não atualizado neste ciclo), nunca fabrica 0 de lixo.
Deno.test("acumular — nSaldo/nCMC/nPrecoMedio não-finito descarta o ITEM, não o lote", () => {
  const pos = new Map<number, PosicaoEstoque>();
  const n = acumularPosicoesDaPagina(pos, [
    { nCodProd: 1, nSaldo: Number.NaN },
    { nCodProd: 2, nSaldo: 1, nCMC: Number.POSITIVE_INFINITY },
    { nCodProd: 3, nSaldo: "lixo" as unknown as number },
    { nCodProd: 4, nSaldo: "5.5" as unknown as number }, // string numérica coage normal
  ]);
  assertEquals(n, 1);
  assertEquals(pos.has(1), false);
  assertEquals(pos.has(2), false);
  assertEquals(pos.has(3), false);
  assertEquals(pos.get(4), { saldo: 5.5, cmc: 0, precoMedio: 0 });
});

Deno.test("acumular — nCodProd não-escalar (array, boolean, objeto) é descartado, não coagido", () => {
  const pos = new Map<number, PosicaoEstoque>();
  const n = acumularPosicoesDaPagina(pos, [
    { nCodProd: [7] as unknown as number, nSaldo: 1 },
    { nCodProd: true as unknown as number, nSaldo: 1 },
    { nCodProd: { v: 7 } as unknown as number, nSaldo: 1 },
    { nCodProd: " 8 ", nSaldo: 1 },
  ]);
  assertEquals(n, 1);
  assertEquals([...pos.keys()], [8]);
});
