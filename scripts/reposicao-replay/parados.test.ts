import { describe, expect, it } from 'vitest';
import { addDias } from '../../src/lib/reposicao/orcamento-compra/datas';
import { coorte, coorteTodosAtivos, padraoSB } from './parados';
import type { DadosClasse } from './classe';
import type { LinhaVenda, Sku } from './tipos';

const REGRAS: Record<string, string> = {
  abc_base_valor: 'valor_total_90d', abc_corte_a_acumulado: '0.80', abc_corte_b_acumulado: '0.95', meses_descer: '3', meses_subir: '2',
  ordem_prioridade: 'AX AY AZ BX BY BZ CX CY CZ', xyz_corte_x_cv: '0.4', xyz_corte_y_cv: '0.8', xyz_min_ordens: '2',
};
const sku = (codigo: string, extra: Partial<Sku> = {}): Sku => ({
  sku: codigo, descricao: 'D', grupo: null, classeAbcHoje: 'C', classeForcada: null, minimoForcado: null, minimoOperacional: null,
  multiplo: null, cmc: 2, saldoHoje: 5, ativo: true, habilitado: true, unidadeNf: 'UN', unidadeEstoque: 'UN', fatorConversao: null,
  grupoEmbalagemId: null, f0: { custoPedido: 3, custoCapitalPerc: 25 }, hoje: { es: null, pp: null, max: null }, ...extra,
});
let seq = 0;
const venda = (s: string, data: string, quantidade: number): LinhaVenda => ({ linhaId: `L${seq++}`, sku: s, data, quantidade, valor: quantidade, cmcLinha: null, noEscopo: true });
const dados = (skus: Sku[], vendas: LinhaVenda[], recebimentos: { sku: string; data: string; quantidade: number }[] = []): DadosClasse => ({
  vendas, skus: new Map(skus.map((s) => [s.sku, s])), recebimentos, dataExtracao: '2026-10-21', classificacaoHist: { regras: REGRAS, porSku: new Map() },
});

// d = 2025-12-23: 9 blocos de 7 dias alinhados em d (k=1 é o mais recente); o bloco k cobre [d-7k, d-7k+7).
const D = '2025-12-23';
const noBloco = (k: number) => addDias(D, -7 * k + 1);
const serie = (s: string, ks: number[], qtds: number[]) => ks.map((k, i) => venda(s, noBloco(k), qtds[i]));

describe('padrão Syntetos-Boylan (semanal, dados < d)', () => {
  it('suave, errático, intermitente, lumpy e sem_dado', () => {
    const todas = [1, 2, 3, 4, 5, 6, 7, 8, 9];
    const v = [
      ...serie('SUAVE', todas, todas.map(() => 10)), // ADI 1, CV² 0
      ...serie('ERRATICO', todas, [1, 20, 2, 30, 1, 25, 3, 40, 2]), // ADI 1, CV² alto
      ...serie('INTERM', [1, 4, 7], [10, 10, 10]), // ADI 3, CV² 0
      ...serie('LUMPY', [1, 4, 7], [1, 10, 100]), // ADI 3, CV² alto
      ...serie('POUCO', [3], [10]),
    ];
    const d = dados([], v);
    expect(padraoSB(d, D, 'SUAVE')).toBe('suave');
    expect(padraoSB(d, D, 'ERRATICO')).toBe('erratico');
    expect(padraoSB(d, D, 'INTERM')).toBe('intermitente');
    expect(padraoSB(d, D, 'LUMPY')).toBe('lumpy');
    expect(padraoSB(d, D, 'POUCO')).toBe('sem_dado');
    expect(padraoSB(d, D, 'NUNCA_VENDEU')).toBe('sem_dado');
  });

  it('SB intermitente vs lumpy: o limite é ADI > 1,32 e CV² > 0,49 (estrito)', () => {
    // 9 blocos; 7 com venda => ADI = 9/7 = 1,2857 (<= 1,32 => não é intermitente); 6 => 1,5 (> 1,32)
    const v = [...serie('A7', [1, 2, 3, 4, 5, 6, 7], [10, 10, 10, 10, 10, 10, 10]), ...serie('A6', [1, 2, 3, 4, 5, 6], [10, 10, 10, 10, 10, 10])];
    const d = dados([], v);
    expect(padraoSB(d, D, 'A7')).toBe('suave');
    expect(padraoSB(d, D, 'A6')).toBe('intermitente');
  });

  it('não usa o dia d nem o futuro', () => {
    const base = serie('X', [1, 4, 7], [10, 10, 10]);
    const ruido = [venda('X', D, 1e6), venda('X', addDias(D, 3), 1e6), venda('X', addDias(D, 30), 1)];
    expect(padraoSB(dados([], [...base, ...ruido]), D, 'X')).toBe(padraoSB(dados([], base), D, 'X'));
  });
});

describe('coorte (tudo calculado com dados < 2026-05-01)', () => {
  // corte 2026-05-01: 27 blocos alinhados em 05-01, o mais antigo começa em 2025-10-24 (>= início do histórico)
  const CORTE = '2026-05-01';
  const bloco = (k: number) => addDias(CORTE, -7 * k + 1);
  const ativos = () => [
    sku('SUAVE'), sku('INTERM'), sku('PARADO'), sku('NUNCA'), sku('DESLIG', { habilitado: false }), sku('INATIVO', { ativo: false }),
    sku('PARADO_COMPRADO', { cmc: null }),
  ];
  const vendasCorte = () => {
    const todos = Array.from({ length: 27 }, (_, i) => i + 1);
    return [
      ...todos.map((k) => venda('SUAVE', bloco(k), 10)),
      ...[1, 5, 9, 14].map((k) => venda('INTERM', bloco(k), 10)),
      venda('PARADO', bloco(3), 4), venda('PARADO', addDias(bloco(3), 1), 4), // 2 linhas na MESMA semana = 1 semana
      ...todos.map((k) => venda('DESLIG', bloco(k), 10)),
      ...todos.map((k) => venda('INATIVO', bloco(k), 10)),
      venda('PARADO_COMPRADO', bloco(20), 1),
    ];
  };
  const recs = [{ sku: 'PARADO_COMPRADO', data: '2026-03-15', quantidade: 3 }, { sku: 'PARADO', data: '2025-12-10', quantidade: 3 }];

  it('população, alterados e parados', () => {
    const c = coorte(dados(ativos(), vendasCorte(), recs));
    expect([...c.populacao].sort()).toEqual(['INTERM', 'SUAVE']); // ativo + habilitado + não parado
    expect([...c.alterados]).toEqual(['INTERM']);
    expect(c.parados.map((p) => p.sku).sort()).toEqual(['NUNCA', 'PARADO', 'PARADO_COMPRADO']); // inativo fica fora; desligado (habilitado=false) não é parado aqui
    const p = c.parados.find((x) => x.sku === 'PARADO')!;
    expect(p).toMatchObject({ semanasComVenda: 1, ultimaVenda: addDias(bloco(3), 1), ultimaCompra: '2025-12-10', compradoUltimos90d: false, estoqueCmc: 10, habilitado: true });
    const pc = c.parados.find((x) => x.sku === 'PARADO_COMPRADO')!;
    expect(pc).toMatchObject({ ultimaCompra: '2026-03-15', compradoUltimos90d: true, estoqueCmc: null }); // cmc ausente => null, não 0
    const n = c.parados.find((x) => x.sku === 'NUNCA')!;
    expect(n).toMatchObject({ semanasComVenda: 0, ultimaVenda: null, ultimaCompra: null });
  });

  it('todos os ativos: sensibilidade sem o filtro de reposição automática', () => {
    const c = coorteTodosAtivos(dados(ativos(), vendasCorte(), recs));
    expect([...c.populacao].sort()).toEqual(['DESLIG', 'INTERM', 'SUAVE']);
  });

  it('coorte não muda se a avaliação mudar', () => {
    const a = coorte(dados(ativos(), vendasCorte(), recs));
    const futuro = [venda('SUAVE', '2026-05-01', 1e6), venda('PARADO', '2026-06-10', 5), venda('NUNCA', '2026-07-01', 9), venda('INTERM', '2026-08-01', 3)];
    const recFut = [...recs, { sku: 'NUNCA', data: '2026-06-01', quantidade: 9 }];
    const b = coorte(dados(ativos().map((s) => ({ ...s, saldoHoje: s.saldoHoje })), [...vendasCorte(), ...futuro], recFut));
    expect([...b.populacao]).toEqual([...a.populacao]);
    expect([...b.alterados]).toEqual([...a.alterados]);
    expect(b.parados).toEqual(a.parados);
  });
});
