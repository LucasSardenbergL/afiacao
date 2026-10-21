import { describe, expect, it } from 'vitest';
import { carregarDados } from './dados';
import { diagnosticoEstadoInicial, estoqueInicial, negativosNaAvaliacao, type DadosReconstrucao } from './reconstrucao';
import type { LinhaVenda, Sku } from './tipos';

const sku = (codigo: string, saldoHoje: number | null): Sku => ({
  sku: codigo, descricao: 'D', grupo: null, classeAbcHoje: 'C', classeForcada: null, minimoForcado: null, minimoOperacional: null,
  multiplo: null, cmc: 1, saldoHoje, ativo: true, habilitado: true, unidadeNf: 'UN', unidadeEstoque: 'UN', fatorConversao: null,
  grupoEmbalagemId: null, f0: { custoPedido: 3, custoCapitalPerc: 25 }, hoje: { es: null, pp: null, max: null },
});
const venda = (s: string, data: string, quantidade: number, noEscopo = true): LinhaVenda => ({ linhaId: `${s}-${data}-${quantidade}`, sku: s, data, quantidade, valor: 1, cmcLinha: null, noEscopo });
const rec = (s: string, data: string, quantidade: number) => ({ sku: s, data, quantidade });

function dados(extracao: string, skus: Sku[], vendas: LinhaVenda[] = [], recebimentos: ReturnType<typeof rec>[] = []): DadosReconstrucao {
  return { dataExtracao: extracao, skus: new Map(skus.map((s) => [s.sku, s])), vendas, recebimentos };
}

describe('estado inicial (spec §5.2 e §5.9)', () => {
  it('reconstrução: saldo 5, venda 3 ontem, recebe 4 anteontem => início de anteontem = 4', () => {
    // anteontem = 2025-10-21 (início do aquecimento), ontem = 22, hoje (extração) = 23
    const d = dados('2025-10-23', [sku('S1', 5)], [venda('S1', '2025-10-22', 3)], [rec('S1', '2025-10-21', 4)]);
    expect(estoqueInicial(d, 'reconstruido').get('S1')).toBe(4);
    expect(estoqueInicial(d, 'piso_zero').get('S1')).toBe(4);
  });

  it('ignora vendas fora do escopo', () => {
    const d = dados('2025-10-23', [sku('S1', 5)], [venda('S1', '2025-10-22', 3, false)]);
    expect(estoqueInicial(d, 'reconstruido').get('S1')).toBe(5);
  });

  it('piso_zero trunca o inicial negativo; reconstruido aplica o ajuste mínimo que evita negativo', () => {
    // saldo 1; venda de 4 em 03/11 e recebimento de 4 em 10/11: inicial cru = 1, mas o caminho cai a -3
    const d = dados('2026-01-10', [sku('S1', 1)], [venda('S1', '2025-11-03', 4)], [rec('S1', '2025-11-10', 4)]);
    expect(estoqueInicial(d, 'piso_zero').get('S1')).toBe(1);
    expect(estoqueInicial(d, 'reconstruido').get('S1')).toBe(4);
    // inicial cru negativo: saldo 0 e recebimento de 5 => cru -5
    const e = dados('2026-01-10', [sku('S2', 0)], [], [rec('S2', '2025-11-10', 5)]);
    expect(estoqueInicial(e, 'piso_zero').get('S2')).toBe(0);
    expect(estoqueInicial(e, 'reconstruido').get('S2')).toBe(0);
  });

  it('saldo ausente: SKU fora do estoqueInicial (nunca 0) e listado no diagnóstico com motivo', () => {
    const d = dados('2026-01-10', [sku('S1', null), sku('S2', 3)]);
    for (const c of ['reconstruido', 'piso_zero'] as const) {
      const m = estoqueInicial(d, c);
      expect(m.has('S1')).toBe(false);
      expect(m.get('S2')).toBe(3);
    }
    expect(diagnosticoEstadoInicial(d).semSaldo).toEqual([{ sku: 'S1', motivo: 'SALDO_HOJE_AUSENTE' }]);
  });

  it('ajuste ignora a avaliação: um déficit criado só em setembro não muda estoqueInicial', () => {
    const base = dados('2026-10-21', [sku('S1', 10)]);
    const comDeficit = dados('2026-10-21', [sku('S1', 10)], [venda('S1', '2026-09-05', 20)], [rec('S1', '2026-09-20', 20)]);
    for (const c of ['reconstruido', 'piso_zero'] as const) {
      expect(estoqueInicial(comDeficit, c).get('S1')).toBe(estoqueInicial(base, c).get('S1'));
    }
    // o déficit de setembro é REPORTADO, não ajustado
    expect(negativosNaAvaliacao(base)).toEqual([]);
    expect(negativosNaAvaliacao(comDeficit)).toEqual([{ sku: 'S1', data: '2026-09-05', valor: -10 }]);
  });

  it('déficit na calibração é ajustado; o negativo da avaliação é medido depois do ajuste', () => {
    const d = dados('2026-10-21', [sku('S1', 2)], [venda('S1', '2026-03-02', 6)], [rec('S1', '2026-03-20', 6)]);
    expect(estoqueInicial(d, 'piso_zero').get('S1')).toBe(2);
    expect(estoqueInicial(d, 'reconstruido').get('S1')).toBe(6); // 2 + ajuste 4
    expect(negativosNaAvaliacao(d)).toEqual([]);
    const dg = diagnosticoEstadoInicial(d);
    expect(dg.total).toBe(1);
    expect(dg.fecham).toBe(0);
    expect(dg.ajustes).toEqual([{ sku: 'S1', ajuste: 4 }]);
  });

  it('fecham: SKU sem nenhum dia negativo conta como fechado', () => {
    const d = dados('2026-01-10', [sku('S1', 5), sku('S2', null)], [venda('S1', '2025-12-01', 2)]);
    const dg = diagnosticoEstadoInicial(d);
    expect(dg.total).toBe(1);
    expect(dg.fecham).toBe(1);
    expect(dg.pctFecham).toBe(1);
  });
});

// Dado real (pula sem REPLAY_DADOS): na coorte ativa+habilitada, 80–88% dos SKUs fecham a conta sem dia negativo.
describe.skipIf(!process.env.REPLAY_DADOS)('estado inicial com dado real', () => {
  it('entre 80% e 88% dos SKUs ativos e habilitados fecham', () => {
    const d = carregarDados(process.env.REPLAY_DADOS as string);
    const coorte = { ...d, skus: new Map([...d.skus].filter(([, s]) => s.ativo && s.habilitado)) };
    const dg = diagnosticoEstadoInicial(coorte);
    expect(dg.pctFecham).not.toBeNull();
    expect(dg.pctFecham as number).toBeGreaterThanOrEqual(0.8);
    expect(dg.pctFecham as number).toBeLessThanOrEqual(0.88);
  });
});
