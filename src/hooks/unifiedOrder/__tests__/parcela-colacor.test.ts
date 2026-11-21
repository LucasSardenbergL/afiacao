import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { codigoParaParcelaColacor } from '../parcela-colacor';

// Cenário do bug (achado do Codex no PR #4042): o cliente tem 101 na Oben e 202 na Colacor.
// A sugestão de prazo da Colacor consultava o 101 — que na Colacor é OUTRO comprador.
// (A assinatura do helper nem recebe o código Oben: ausente ≠ código Oben.)
const COLACOR = 202;

describe('codigoParaParcelaColacor — só o código da PRÓPRIA Colacor', () => {
  it('lookup por documento resolvido → usa o código Colacor do lookup', () => {
    expect(codigoParaParcelaColacor({ cliente: { codigo_cliente: COLACOR } }, null)).toBe(COLACOR);
  });

  it('lookup vence o código Colacor que o cadastro já trazia', () => {
    expect(codigoParaParcelaColacor({ cliente: { codigo_cliente: COLACOR } }, 999)).toBe(COLACOR);
  });

  it('lookup sem cliente → cai no código Colacor conhecido', () => {
    expect(codigoParaParcelaColacor({ cliente: null }, COLACOR)).toBe(COLACOR);
    expect(codigoParaParcelaColacor(null, COLACOR)).toBe(COLACOR);
  });

  it('sem código Colacor nenhum → null (não consulta; prazo fica no padrão)', () => {
    expect(codigoParaParcelaColacor(null, null)).toBeNull();
    expect(codigoParaParcelaColacor(undefined, undefined)).toBeNull();
    expect(codigoParaParcelaColacor({}, null)).toBeNull();
  });

  it('código inválido (0, negativo, NaN, fracionário) não conta como resolvido', () => {
    for (const ruim of [0, -5, Number.NaN, 1.5]) {
      expect(codigoParaParcelaColacor({ cliente: { codigo_cliente: ruim } }, null)).toBeNull();
      expect(codigoParaParcelaColacor(null, ruim)).toBeNull();
    }
  });
});

// O hook é grande demais para renderizar aqui (precedente: useUnifiedOrder.envioRobusto.test.ts):
// prova-se que a seleção USA o helper e nunca manda o código Oben para a Colacor.
const selecao = readFileSync(
  resolve(__dirname, '../useCustomerSelection.ts'),
  'utf8',
);

describe('useCustomerSelection — fiação do prazo Colacor', () => {
  it('nenhuma chamada Colacor de buscar_ultima_parcela usa cust.codigo_cliente (código Oben)', () => {
    const chamadas = selecao.match(/action: 'buscar_ultima_parcela'[^}]*/g) ?? [];
    expect(chamadas.length).toBe(2);
    const colacor = chamadas.filter((c) => c.includes("account: 'colacor'"));
    expect(colacor).toHaveLength(1);
    expect(colacor[0]).toContain('codigo_cliente: codigoParcelaColacor,');
    expect(colacor[0]).not.toMatch(/codigo_cliente: cust\.codigo_cliente\b/);
  });

  it('o código vem do helper, alimentado pelo lookup Colacor e pelo código Colacor conhecido', () => {
    expect(selecao).toContain(
      'const codigoParcelaColacor = codigoParaParcelaColacor(lookup, cust.codigo_cliente_colacor);',
    );
    expect(selecao).toContain('if (codigoParcelaColacor === null) return { data: null };');
  });

  it('o lookup que fornece o código é o da CONTA Colacor e não engole a rejeição (tri-state do slot 3)', () => {
    // Forma exata: account 'colacor' (trocar p/ 'oben' reabre o bug) e SEM .catch no promise
    // compartilhado (um .catch transformaria falha em "cliente ausente" → auto-cadastro às cegas).
    expect(selecao).toContain(
      [
        'const lookupClienteColacor = cust.cnpj_cpf',
        "        ? supabase.functions.invoke('omie-vendas-sync', {",
        "            body: { action: 'buscar_cliente', document: cust.cnpj_cpf, account: 'colacor' },",
        '          })',
        '        : Promise.resolve({ data: null });',
      ].join('\n'),
    );
    expect(selecao).not.toMatch(/lookupClienteColacor\s*\.catch/);
  });

  it('seleção trocada durante o lookup não dispara a consulta de prazo', () => {
    expect(selecao).toMatch(
      /const lookup = await lookupClienteColacor\.then\([\s\S]*?\);\n[^\n]*\n\s+if \(isStale\(\)\) return \{ data: null \};\n\s+const codigoParcelaColacor/,
    );
  });

  it('o lookup Colacor é o MESMO promise do slot 3 e a parcela Colacor espera por ele', () => {
    expect(selecao).toContain('const lookup = await lookupClienteColacor.then(');
    expect(selecao).toMatch(/parcelaColacorPromise,\n\s+localUserId\n[\s\S]*?\n\s+lookupClienteColacor,\n/);
  });

  it('A7 preservado: a sugestão Colacor ainda passa por podeSugerirParcela', () => {
    expect(selecao).toContain(
      'parcelaColacor.data?.ultima_parcela && podeSugerirParcela(parcelaManualRef.current.colacor, myToken)',
    );
  });
});
