import { describe, expect, it } from 'vitest';
import { empresasSemSnapshot, exibicaoConsolidado, paraLinhasConsolidado } from './consolidado-intercompany';

describe('paraLinhasConsolidado', () => {
  // Colunas REAIS da RPC (conta/total_bruto/eliminacoes/total_consolidado) — o cast antigo lia
  // dre_linha/valor_bruto/valor_liquido, que não existem, e a tela quebrava ao formatar `undefined`.
  const rpc = [
    { conta: 'receita_bruta', total_bruto: 1000, eliminacoes: -200, total_consolidado: 800 },
    { conta: 'cmv', total_bruto: 600, eliminacoes: 200, total_consolidado: 800 },
    { conta: 'despesas_operacionais', total_bruto: 100, eliminacoes: 0, total_consolidado: 100 },
    { conta: 'resultado_liquido', total_bruto: 250, eliminacoes: 0, total_consolidado: 250 },
  ];

  it('lê as colunas reais da RPC', () => {
    const [receita, , desp, res] = paraLinhasConsolidado(rpc);
    expect(receita).toEqual({ conta: 'receita_bruta', bruto: 1000, eliminacoes: -200, consolidado: 800 });
    expect(desp).toEqual({ conta: 'despesas_operacionais', bruto: 100, eliminacoes: 0, consolidado: 100 });
    expect(res.consolidado).toBe(250);
  });

  it('CMV com eliminação: sinal invertido na RPC (CMV é gravado positivo) ⇒ "—", nunca o número errado', () => {
    expect(paraLinhasConsolidado(rpc)[1]).toEqual({ conta: 'cmv', bruto: 600, eliminacoes: null, consolidado: null });
  });

  it('CMV sem eliminação: o líquido é o próprio bruto e segue exibido', () => {
    const [cmv] = paraLinhasConsolidado([{ conta: 'cmv', total_bruto: 600, eliminacoes: 0, total_consolidado: 600 }]);
    expect(cmv).toEqual({ conta: 'cmv', bruto: 600, eliminacoes: 0, consolidado: 600 });
  });
});

describe('empresasSemSnapshot', () => {
  it('cobertura por empresa do mês', () => {
    const todas = ['oben', 'colacor', 'colacor_sc'] as const;
    expect(empresasSemSnapshot(todas, ['oben', 'colacor', 'colacor_sc'])).toEqual([]);
    expect(empresasSemSnapshot(todas, ['oben'])).toEqual(['colacor', 'colacor_sc']);
    expect(empresasSemSnapshot(todas, [])).toEqual(['oben', 'colacor', 'colacor_sc']);
  });
});

describe('exibicaoConsolidado', () => {
  it('cobertura DESCONHECIDA bloqueia os valores (os zeros podem ser COALESCE)', () => {
    expect(exibicaoConsolidado(4, null, 3)).toBe('indisponivel');
  });
  it('nenhuma empresa com DRE no mês ⇒ nada; parte ⇒ parcial; todas ⇒ completo', () => {
    expect(exibicaoConsolidado(4, ['oben', 'colacor', 'colacor_sc'], 3)).toBe('nada');
    expect(exibicaoConsolidado(4, ['colacor'], 3)).toBe('parcial');
    expect(exibicaoConsolidado(4, [], 3)).toBe('completo');
  });
  it('RPC sem linhas (erro tratado) ⇒ nada', () => {
    expect(exibicaoConsolidado(0, [], 3)).toBe('nada');
  });
});
