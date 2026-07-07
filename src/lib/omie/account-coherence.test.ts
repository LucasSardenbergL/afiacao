import { describe, it, expect } from 'vitest';
import { codeBelongsToWrongAccount } from './account-coherence';

// Guard money-path (coerência conta×código, PROVA POSITIVA): usado no edge omie-vendas-sync como
// rede de segurança na fronteira comum. Só acusa quando há EVIDÊNCIA de que o código é de OUTRA
// conta Omie do mesmo cliente — nunca por ausência (oben/colacor_sc resolvem o código via API e
// podem não estar no espelho local `omie_clientes`; acusar ausência rejeitaria pedido legítimo).

const colacor111 = { omie_codigo_cliente: 111, empresa_omie: 'colacor' };
const oben222 = { omie_codigo_cliente: 222, empresa_omie: 'oben' };

describe('codeBelongsToWrongAccount (coerência conta×código por prova positiva)', () => {
  it('código Colacor mandado como Oben → true (o bug: PV no cliente errado)', () => {
    expect(codeBelongsToWrongAccount([colacor111], 111, 'oben')).toBe(true);
  });

  it('mesmo cliente com código por conta: manda o Colacor como Oben → true (devia mandar o 222)', () => {
    expect(codeBelongsToWrongAccount([colacor111, oben222], 111, 'oben')).toBe(true);
  });

  it('código legítimo da conta alvo → false (Colacor 111 como Colacor)', () => {
    expect(codeBelongsToWrongAccount([colacor111], 111, 'colacor')).toBe(false);
  });

  it('código legítimo da conta alvo quando há várias linhas → false (Oben 222 como Oben)', () => {
    expect(codeBelongsToWrongAccount([colacor111, oben222], 222, 'oben')).toBe(false);
  });

  it('Oben resolvido via API, fora do espelho → false (NÃO acusa por ausência)', () => {
    // O cliente só tem espelho Colacor; o código Oben 999 veio da API do Omie. Sem evidência de
    // conta errada → deve PASSAR (senão rejeitaria todo pedido oben, que não vive no espelho).
    expect(codeBelongsToWrongAccount([colacor111], 999, 'oben')).toBe(false);
  });

  it('sem linhas para o cliente → false (nada a provar)', () => {
    expect(codeBelongsToWrongAccount([], 111, 'oben')).toBe(false);
  });

  it('código inválido (0/NaN) → false (é outro guard, não "conta errada")', () => {
    expect(codeBelongsToWrongAccount([colacor111], 0, 'oben')).toBe(false);
    expect(codeBelongsToWrongAccount([colacor111], Number.NaN, 'oben')).toBe(false);
  });

  it('compara numericamente (string vs number no espelho não engana)', () => {
    const strRow = { omie_codigo_cliente: '111' as unknown as number, empresa_omie: 'colacor' };
    expect(codeBelongsToWrongAccount([strRow], 111, 'oben')).toBe(true);
  });

  it('código não-representável (> 2^53) → false (fail-safe; o edge fail-closa a montante)', () => {
    expect(codeBelongsToWrongAccount([colacor111], Number.MAX_SAFE_INTEGER + 1, 'oben')).toBe(false);
  });
});
