import { describe, expect, it } from 'vitest';
import { diasAtendimento, diasUteis, duEntre, somarDiasUteis } from './calendario';
import type { LinhaVenda } from './tipos';

const venda = (data: string, noEscopo = true): LinhaVenda => ({ linhaId: `l-${data}`, sku: 'S1', data, quantidade: 1, valor: 1, cmcLinha: null, noEscopo });

describe('calendários (spec §5.9)', () => {
  it('sexta sem venda é dia útil', () => {
    // 2026-05-01 é sexta
    expect(diasUteis('2026-04-30', '2026-05-05')).toEqual(['2026-04-30', '2026-05-01', '2026-05-04', '2026-05-05']);
    expect(diasAtendimento({ vendas: [] })).toContain('2026-05-01');
  });

  it('sábado com venda é dia de atendimento, mas não de LT', () => {
    const vendas = [venda('2026-05-02')]; // sábado
    expect(diasUteis('2026-05-01', '2026-05-04')).not.toContain('2026-05-02');
    expect(diasAtendimento({ vendas })).toContain('2026-05-02');
    expect(somarDiasUteis('2026-05-01', 1)).toBe('2026-05-04');
    // sábado/domingo sem venda (ou venda fora do escopo) não entram
    expect(diasAtendimento({ vendas: [venda('2026-05-09', false)] })).not.toContain('2026-05-09');
    expect(diasAtendimento({ vendas: [] })).not.toContain('2026-05-09');
  });

  it('diasAtendimento é ordenado, sem repetição, e vai do início do aquecimento ao fim da avaliação', () => {
    const d = diasAtendimento({ vendas: [venda('2026-05-02'), venda('2026-05-02'), venda('2026-05-04')] });
    expect(d[0]).toBe('2025-10-21');
    expect(d[d.length - 1]).toBe('2026-10-20');
    expect(new Set(d).size).toBe(d.length);
    expect([...d].sort()).toEqual(d);
  });

  it('duEntre(sexta, segunda) = 1 e segue a convenção (exclui o inicial, inclui o final)', () => {
    expect(duEntre('2026-05-01', '2026-05-04')).toBe(1);
    expect(duEntre('2026-05-04', '2026-05-04')).toBe(0);
    expect(duEntre('2026-05-05', '2026-05-04')).toBe(0);
    expect(duEntre('2026-05-04', '2026-05-11')).toBe(5);
  });

  it('somarDiasUteis avança e retrocede; n=0 devolve a própria data', () => {
    expect(somarDiasUteis('2026-05-04', 5)).toBe('2026-05-11');
    expect(somarDiasUteis('2026-05-02', 1)).toBe('2026-05-04'); // de sábado
    expect(somarDiasUteis('2026-05-04', -1)).toBe('2026-05-01');
    expect(somarDiasUteis('2026-05-02', 0)).toBe('2026-05-02');
    expect(duEntre('2026-05-01', somarDiasUteis('2026-05-01', 7))).toBe(7);
  });
});
