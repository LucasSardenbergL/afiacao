// Testa o CÓDIGO REAL de pos-estoque.ts (não uma cópia) no runtime real (Deno).
// Roda com: deno test supabase/functions/_shared/pos-estoque_test.ts
//
// Normalização do ListarPosEstoque compartilhada por sync-reprocess e omie-analytics-sync.
// Casos movidos verbatim de sync-reprocess/inventory-lote_test.ts (#1341) quando a função
// subiu p/ _shared/ (o canônico ganhou a mesma validação de finitude + dedupe last-wins).
import { acumularPosicoesDaPagina, type PosicaoEstoque } from "./pos-estoque.ts";

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

// ⚠️ Fabricação CONSCIENTE (não é violação do "ausente ≠ zero"): o N+1 histórico já fazia
// nSaldo/nCMC/nPrecoMedio `?? 0` — no ListarPosEstoque a posição VEIO na resposta; campo
// ausente = posição zerada no Omie, não "dado indisponível". O gate money-path real está
// adiante: cmc<=0 NÃO vira candidato a product_costs (nunca fabrica custo zero).
Deno.test("acumular — campos ausentes viram 0 (comportamento preservado do N+1, deliberado)", () => {
  const pos = new Map<number, PosicaoEstoque>();
  acumularPosicoesDaPagina(pos, [{ nCodProd: 5 }]);
  assertEquals(pos.get(5), { saldo: 0, cmc: 0, precoMedio: 0 });
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
    { nCodProd: 2, nCMC: Number.POSITIVE_INFINITY },
    { nCodProd: 3, nSaldo: "lixo" as unknown as number },
    { nCodProd: 4, nSaldo: "5.5" as unknown as number }, // string numérica coage normal
  ]);
  assertEquals(n, 1);
  assertEquals(pos.has(1), false);
  assertEquals(pos.has(2), false);
  assertEquals(pos.has(3), false);
  assertEquals(pos.get(4), { saldo: 5.5, cmc: 0, precoMedio: 0 });
});
