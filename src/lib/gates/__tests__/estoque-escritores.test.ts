import { describe, it, expect } from 'vitest';
import { analisarEscritorEstoque } from '@/lib/gates/estoque-escritores';

// Calibração do detector do gate `estoque-escritores` (src/__tests__/estoque-escritores-gate.test.ts):
// a assinatura TEM de casar a forma real dos writers e NÃO casar o que não escreve espelho de estoque.

describe('analisarEscritorEstoque — tabelas escritas', () => {
  it('upsert/update/insert em inventory_position, com a cadeia quebrada em linhas', () => {
    const fonte = `const { error } = await db\n  .from("inventory_position")\n  .upsert(chunk, { onConflict: "omie_codigo_produto,account" });`;
    expect(analisarEscritorEstoque(fonte).tabelas).toEqual(['inventory_position']);
    expect(analisarEscritorEstoque(`db.from('inventory_position').update({ saldo })`).tabelas).toEqual(['inventory_position']);
    expect(analisarEscritorEstoque('db.from(`inventory_position`).insert(rows)').tabelas).toEqual(['inventory_position']);
  });

  it('LEITURA de inventory_position não é escrita', () => {
    expect(analisarEscritorEstoque(`db.from("inventory_position").select("saldo").eq("account", a)`).tabelas).toEqual([]);
  });

  it('omie_products só conta quando o arquivo carrega a chave `estoque` num literal', () => {
    const comEstoque = `rows.push({ codigo, estoque: p.saldo });\nawait db.from("omie_products").upsert(rows);`;
    const semEstoque = `await db.from("omie_products").update({ ativo: false }).eq("id", id);`;
    expect(analisarEscritorEstoque(comEstoque).tabelas).toEqual(['omie_products']);
    expect(analisarEscritorEstoque(semEstoque).tabelas).toEqual([]);
  });

  it('escrita COMENTADA não conta (o detector lê a fonte sem comentários)', () => {
    const fonte = `// await db.from("inventory_position").upsert(rows);\n/* db.from("omie_products").update({ estoque: 0 }) */`;
    expect(analisarEscritorEstoque(fonte).tabelas).toEqual([]);
  });
});

describe('analisarEscritorEstoque — o zero confirmado', () => {
  it('a CHAMADA conta; o import e a definição, não', () => {
    expect(analisarEscritorEstoque(`zeramento = await zerarConfirmadosForaDaLista({ account });`).chamaZeroConfirmado).toBe(true);
    expect(analisarEscritorEstoque(`import { zerarConfirmadosForaDaLista } from "../_shared/zeramento-estoque-io.ts";`).chamaZeroConfirmado).toBe(false);
    expect(analisarEscritorEstoque(`export async function zerarConfirmadosForaDaLista(d: D) {}`).chamaZeroConfirmado).toBe(false);
  });

  it('chamada só em comentário não conta', () => {
    expect(analisarEscritorEstoque(`// zerarConfirmadosForaDaLista({ account })`).chamaZeroConfirmado).toBe(false);
  });
});

describe('analisarEscritorEstoque — zero literal de estoque', () => {
  it('conta `saldo: 0` e `estoque: 0` em literal (inclusive de tipo); não conta 0.5, 0x1 nem variável', () => {
    const fonte = `a = { saldo: 0 }; b = { x, estoque: 0, y }; type T = { saldo: 0; c?: number };\nc = { saldo: 0.5 }; d = { estoque: 0x1 }; e = { estoque: zero };`;
    expect(analisarEscritorEstoque(fonte).zerosLiterais).toBe(3);
  });

  it('o `|| 0` do catálogo (a forma que o PR-2 remove) não é zero literal', () => {
    expect(analisarEscritorEstoque(`rows.push({ estoque: p.quantidade_estoque || 0 })`).zerosLiterais).toBe(0);
  });
});
