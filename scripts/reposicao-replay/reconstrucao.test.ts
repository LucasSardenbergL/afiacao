import { describe, expect, it } from 'vitest';
import { carregarDados } from './dados';
import { conferirPosicao, diagnosticoEstadoInicial, estoqueInicial, negativosNaAvaliacao, type DadosReconstrucao } from './reconstrucao';
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

// Achado 1 do Codex: com a âncora DATADA do Omie (posição no fim da véspera do aquecimento), a abertura não pode depender de
// nada posterior a 30/04. O teste perturba vendas e recebimentos da avaliação SEM compensar `saldoHoje` (a R10 compensava).
describe('estado inicial ancorado na posição do Omie (§5.9, achado 1)', () => {
  const comAncora = (d: DadosReconstrucao, pos: Record<string, number>): DadosReconstrucao => ({ ...d, posicaoAbertura: new Map(Object.entries(pos)) });

  it('abertura = posição do Omie na véspera; o caminho é reconstruído para a frente', () => {
    // posição 7 no fim de 20/10; recebe 4 em 21/10 e vende 3 em 22/10 => fim de 22/10 = 8
    const d = comAncora(dados('2025-10-23', [sku('S1', 999)], [venda('S1', '2025-10-22', 3)], [rec('S1', '2025-10-21', 4)]), { S1: 7 });
    expect(estoqueInicial(d, 'reconstruido').get('S1')).toBe(7);
    expect(diagnosticoEstadoInicial(d).ancora).toBe('posicao_omie');
  });

  it('invariância: multiplicar as vendas e somar recebimentos depois de 30/04, saldoHoje FIXO, não muda a abertura', () => {
    const vendas = [venda('S1', '2026-03-02', 2), venda('S1', '2026-05-04', 3), venda('S1', '2026-09-01', 1)];
    const base = comAncora(dados('2026-10-21', [sku('S1', 4), sku('S2', 0)], vendas, [rec('S1', '2026-02-10', 5)]), { S1: 6, S2: 1 });
    const perturbado = comAncora(
      dados(
        '2026-10-21',
        [sku('S1', 4), sku('S2', 0)],
        vendas.map((v) => (v.data > '2026-04-30' ? { ...v, quantidade: v.quantidade * 10 } : v)).concat([venda('S2', '2026-06-01', 50)]),
        [rec('S1', '2026-02-10', 5), rec('S1', '2026-07-01', 80), rec('S2', '2026-05-02', 9)],
      ),
      { S1: 6, S2: 1 },
    );
    for (const c of ['reconstruido', 'piso_zero'] as const) {
      expect(estoqueInicial(perturbado, c)).toEqual(estoqueInicial(base, c));
    }
  });

  it('SKU sem posição do Omie fica FORA (nunca 0, nunca cai para o saldo de hoje), com motivo', () => {
    const d = comAncora(dados('2026-01-10', [sku('S1', 5), sku('S2', 3)]), { S1: 2 });
    expect([...estoqueInicial(d, 'reconstruido')]).toEqual([['S1', 2]]);
    expect(diagnosticoEstadoInicial(d).semSaldo).toEqual([{ sku: 'S2', motivo: 'POSICAO_OMIE_AUSENTE' }]);
  });

  // R31 (revisão I1): o recebimento histórico só começa em 28/01/26; reconstruir out–jan para a frente só desconta venda e o
  // "ajuste mínimo" FABRICARIA estoque. No modo âncora a abertura é a posição medida, sem ajuste.
  it('modo âncora: abertura = nSaldo medido, SEM ajuste mínimo, mesmo com o caminho negativo antes dos recebimentos', () => {
    const d = comAncora(dados('2026-10-21', [sku('S1', 50)], [venda('S1', '2025-11-03', 6)], [rec('S1', '2026-02-10', 6)]), { S1: 2 });
    expect(estoqueInicial(d, 'reconstruido').get('S1')).toBe(2);
    expect(estoqueInicial(d, 'piso_zero').get('S1')).toBe(2);
    expect(diagnosticoEstadoInicial(d).ajustes).toEqual([]);
    // posição medida negativa: 'reconstruido' fica com a medição, 'piso_zero' trunca
    const n = comAncora(dados('2026-10-21', [sku('S1', 0)]), { S1: -3 });
    expect(estoqueInicial(n, 'reconstruido').get('S1')).toBe(-3);
    expect(estoqueInicial(n, 'piso_zero').get('S1')).toBe(0);
  });

  it('conferência (R31): posição de 31/01 + eventos de 01/02 a 30/04 contra a posição de 30/04', () => {
    // S1: 6 em 31/01 + 5 (10/02) − 2 (02/03) = 9 → bate; a venda de 20/01 e a de 05/05 ficam FORA do intervalo
    // S2: 1 em 31/01, nenhum evento → 1 ≠ 4 (diverge); S3 sem posição em 30/04 (fora do denominador)
    const d = dados(
      '2026-10-21',
      [sku('S1', 0), sku('S2', 0), sku('S3', 0)],
      [venda('S1', '2026-01-20', 7), venda('S1', '2026-03-02', 2), venda('S1', '2026-05-05', 4)],
      [rec('S1', '2026-02-10', 5)],
    );
    const c = conferirPosicao(d, new Map([['S1', 6], ['S2', 1], ['S3', 0]]), new Map([['S1', 9], ['S2', 4]]));
    expect(c).toEqual({ de: '2026-01-31', ate: '2026-04-30', total: 2, batem: 1, pctBatem: 0.5, divergentes: [{ sku: 'S2', reconstruido: 1, omie: 4 }] });
  });

  it('diagnóstico traz a âncora e a conferência quando as duas posições existem; sem elas, conferência null', () => {
    const base = dados('2026-10-21', [sku('S1', 0)], [venda('S1', '2026-03-02', 2)]);
    const com = { ...comAncora(base, { S1: 4 }), posicaoAquecimentoFim: new Map([['S1', 4]]), posicaoConferencia: new Map([['S1', 2]]) };
    const dg = diagnosticoEstadoInicial(com);
    expect(dg.ancora).toBe('posicao_omie');
    expect(dg.conferencia).toMatchObject({ total: 1, batem: 1, pctBatem: 1 });
    expect(diagnosticoEstadoInicial(base).conferencia).toBeNull();
    expect(diagnosticoEstadoInicial(base).ancora).toBe('saldo_hoje');
  });
});

// Dado real (pula sem REPLAY_DADOS). Modo legado (saldo de hoje): 80–88% dos SKUs ativos e habilitados fecham a conta sem
// dia negativo — número calibrado NESSE modo. No modo âncora (R31) o caminho out–jan não tem recebimento (o histórico começa
// em 28/01/26), então "fecha" não mede nada: o que vale é a conferência 31/01 → 30/04 (revisão M6).
describe.skipIf(!process.env.REPLAY_DADOS)('estado inicial com dado real', () => {
  it('legado: 80–88% fecham; âncora: âncora declarada e conferência calculada', () => {
    const d = carregarDados(process.env.REPLAY_DADOS as string);
    const coorte = { ...d, skus: new Map([...d.skus].filter(([, s]) => s.ativo && s.habilitado)) };
    const dg = diagnosticoEstadoInicial(coorte);
    if (d.posicaoAbertura === null) {
      expect(dg.ancora).toBe('saldo_hoje');
      expect(dg.pctFecham).not.toBeNull();
      expect(dg.pctFecham as number).toBeGreaterThanOrEqual(0.8);
      expect(dg.pctFecham as number).toBeLessThanOrEqual(0.88);
    } else {
      expect(dg.ancora).toBe('posicao_omie');
      expect(dg.ajustes).toEqual([]);
      if (d.posicaoAquecimentoFim && d.posicaoConferencia) expect(dg.conferencia?.total ?? 0).toBeGreaterThan(0);
    }
  });
});
