import { describe, expect, it } from 'vitest';
import {
  eliminacaoPendente,
  empresasSemSnapshot,
  exibicaoConsolidado,
  paraLinhasConsolidado,
} from './consolidado-intercompany';

describe('paraLinhasConsolidado', () => {
  // Colunas REAIS da RPC (conta/total_bruto/eliminacoes/total_consolidado) — o cast antigo lia
  // dre_linha/valor_bruto/valor_liquido, que não existem, e a tela quebrava ao formatar `undefined`.
  // Forma da migration 20261021120000: receita E cmv caem pelo mesmo valor (CMV é positivo no snapshot).
  const rpc = [
    { conta: 'receita_bruta', total_bruto: 1000, eliminacoes: -200, total_consolidado: 800 },
    { conta: 'cmv', total_bruto: 600, eliminacoes: -200, total_consolidado: 400 },
    { conta: 'despesas_operacionais', total_bruto: 100, eliminacoes: 0, total_consolidado: 100 },
    { conta: 'resultado_liquido', total_bruto: 300, eliminacoes: 0, total_consolidado: 300 },
  ];

  it('lê as colunas reais da RPC, inclusive o CMV consolidado com eliminação', () => {
    const [receita, cmv, desp, res] = paraLinhasConsolidado(rpc);
    expect(receita).toEqual({ conta: 'receita_bruta', bruto: 1000, eliminacoes: -200, consolidado: 800 });
    expect(cmv).toEqual({ conta: 'cmv', bruto: 600, eliminacoes: -200, consolidado: 400 });
    expect(desp).toEqual({ conta: 'despesas_operacionais', bruto: 100, eliminacoes: 0, consolidado: 100 });
    expect(res).toEqual({ conta: 'resultado_liquido', bruto: 300, eliminacoes: 0, consolidado: 300 });
    expect(eliminacaoPendente(paraLinhasConsolidado(rpc))).toBe(false);
  });

  it('eliminação pendente (NULL nas 4 linhas): "—", nunca um número; o bruto segue', () => {
    const linhas = paraLinhasConsolidado(
      rpc.map((l) => ({ ...l, eliminacoes: null, total_consolidado: null })),
    );
    expect(linhas[1]).toEqual({ conta: 'cmv', bruto: 600, eliminacoes: null, consolidado: null });
    expect(eliminacaoPendente(linhas)).toBe(true);
  });

  it('conta sem snapshot: bruto e consolidado NULL (ausente ≠ zero); zero legítimo segue zero', () => {
    const [ausente, zero] = paraLinhasConsolidado([
      { conta: 'cmv', total_bruto: null, eliminacoes: 0, total_consolidado: null },
      { conta: 'despesas_operacionais', total_bruto: 0, eliminacoes: 0, total_consolidado: 0 },
    ]);
    expect(ausente).toEqual({ conta: 'cmv', bruto: null, eliminacoes: 0, consolidado: null });
    expect(zero).toEqual({ conta: 'despesas_operacionais', bruto: 0, eliminacoes: 0, consolidado: 0 });
  });

  it('valor que não é número finito (string numérica, NaN) lança em vez de virar número', () => {
    const texto = { conta: 'cmv', total_bruto: '600', eliminacoes: 0, total_consolidado: 600 };
    expect(() => paraLinhasConsolidado([texto])).toThrow('consolidado[0].total_bruto: esperava número');
    expect(() => paraLinhasConsolidado([{ ...rpc[0], eliminacoes: Number.NaN }])).toThrow(
      'consolidado[0].eliminacoes: esperava número',
    );
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
