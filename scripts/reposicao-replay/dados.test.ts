import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { carregarDados } from './dados';
import { duEntre } from './du';

const H = {
  vendas: 'linha_id|sku|data|quantidade|valor|cmc_linha|no_escopo',
  recebimentos: 'tracking_id|sku|t1|t4|quantidade_pedida|quantidade_recebida',
  skus:
    'sku|descricao|grupo_codigo|classe_abc_hoje|classe_forcada|minimo_forcado|minimo_operacional|multiplo_embalagem|unidade_nf|unidade_estoque|fator_conversao|cmc|saldo_hoje|habilitado|ativo|custo_pedido_aplicado|custo_capital_perc|es_hoje|pp_hoje|max_hoje|grupo_embalagem_id',
  config_custos:
    'z_classe_a|z_classe_b|z_classe_c|selic_anual|spread_oportunidade|armazenagem_fisica|custo_pedido_manual|custo_pedido_api|modo_pedido|haircut_fallback_preco',
  classificacao_hist:
    'tipo|chave|classe_atual|classe_abc|classe_xyz|classe_pendente|meses_consecutivos|data_ultima_mudanca|valor',
  teto: 'key|value',
  equivalencias:
    'sku|sku_equivalente|fator|grupo_id|fator_para_base_sku|fator_para_base_equivalente|unidades_omie_sku|unidades_omie_equivalente',
  sugestao_hoje: 'sku|posicao|qtde_final',
} as const;

type Nome = keyof typeof H;

const skuLinha = (sku: string, un = 'UN', ue = 'UN', fator = '', extra: Partial<Record<number, string>> = {}) => {
  const c = [sku, 'DESC', 'g', 'C', '', '', '', '', un, ue, fator, '10.5', '', 't', 't', '3.00', '25.75', '1', '2', '4', ''];
  for (const [i, v] of Object.entries(extra)) c[Number(i)] = v as string;
  return c.join('|');
};

function base(): Record<Nome, string[]> {
  return {
    vendas: ['l1|S1|2026-03-02|2|20||1'],
    recebimentos: ['t1|S1|2026-01-05|2026-01-12|10|10'],
    skus: [skuLinha('S1')],
    config_custos: ['1.65|1.28|0.84|14.75|3.00|8.00|3.00|5.00|manual|0.65'],
    classificacao_hist: ['regra|meses_subir|||||||2', 'sku|S1|CZ|C|Z||0|2026-05-06|'],
    teto: [
      'reposicao_teto_cobertura_oben_ativa|true',
      'reposicao_teto_cobertura_oben_dias_b|90',
      'reposicao_teto_cobertura_oben_dias_c|60',
    ],
    equivalencias: [],
    sugestao_hoje: ['S1|2|3'],
  };
}

const dirs: string[] = [];
function monta(ov: Partial<Record<Nome, string[]>> = {}, log = 'extracao em 2026-10-21T12:57:16Z  dir=x\n'): string {
  const dir = mkdtempSync(join(tmpdir(), 'replay-dados-'));
  dirs.push(dir);
  const b = { ...base(), ...ov };
  for (const n of Object.keys(H) as Nome[]) {
    writeFileSync(join(dir, `${n}.csv`), [H[n], ...b[n], 'fim|ok'].join('\n') + '\n');
  }
  writeFileSync(join(dir, 'extracao.log'), log);
  return dir;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

describe('carregarDados — validação dos CSVs', () => {
  it('carrega o caso base', () => {
    const d = carregarDados(monta());
    expect(d.vendas).toHaveLength(1);
    expect(d.skus.get('S1')?.f0).toEqual({ custoPedido: 3, custoCapitalPerc: 25.75 });
    expect(d.zPorClasse).toEqual({ A: 1.65, B: 1.28, C: 0.84 });
    expect(d.teto).toEqual({ ativa: true, diasB: 90, diasC: 60 });
    expect(d.dataExtracao).toBe('2026-10-21');
    expect(d.equivalencias).toEqual([]);
    expect(d.hashDados).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejeita CSV sem marcador', () => {
    const dir = monta();
    const f = join(dir, 'vendas.csv');
    writeFileSync(f, readFileSync(f, 'utf8').replace('fim|ok\n', ''));
    expect(() => carregarDados(dir)).toThrow('CSV_INVALIDO:vendas.csv');
  });

  it('rejeita vendas vazia (equivalências vazia é aceita)', () => {
    expect(() => carregarDados(monta({ vendas: [] }))).toThrow('CSV_INVALIDO:vendas.csv');
    expect(() => carregarDados(monta({ equivalencias: [] }))).not.toThrow();
  });

  it('rejeita CSV ausente e número inválido', () => {
    const dir = monta();
    rmSync(join(dir, 'teto.csv'));
    expect(() => carregarDados(dir)).toThrow('CSV_INVALIDO:teto.csv');
    expect(() => carregarDados(monta({ vendas: ['l1|S1|2026-03-02|abc|20||1'] }))).toThrow('CSV_INVALIDO:vendas.csv');
  });

  it('ausente fica null, nunca 0', () => {
    const d = carregarDados(monta());
    const s = d.skus.get('S1')!;
    expect(s.saldoHoje).toBeNull();
    expect(s.minimoOperacional).toBeNull();
    expect(s.multiplo).toBeNull();
    expect(d.vendas[0].cmcLinha).toBeNull();
  });

  it('hashDados muda com o conteúdo e é estável', () => {
    const a = carregarDados(monta()).hashDados;
    expect(carregarDados(monta()).hashDados).toBe(a);
    expect(carregarDados(monta({ sugestao_hoje: ['S1|2|4'] })).hashDados).not.toBe(a);
  });
});

describe('contrato de unidade (§5.6)', () => {
  it('exclui SKU com unidade incoerente', () => {
    const dir = monta({
      skus: [skuLinha('S1'), skuLinha('S2', 'L', 'UN', '')],
      vendas: ['l1|S1|2026-03-02|2|20||1', 'l2|S2|2026-03-02|3|30||1'],
    });
    const d = carregarDados(dir);
    expect(d.excluidos).toEqual([{ sku: 'S2', motivo: 'UNIDADE_INCOERENTE' }]);
    expect(d.skus.has('S2')).toBe(false);
    expect(d.skus.has('S1')).toBe(true);
  });

  it('fator 1 com unidades diferentes também é incoerente (não se chuta)', () => {
    const d = carregarDados(monta({ skus: [skuLinha('S1', 'L', 'GL', '1')] }));
    expect(d.excluidos.map((e) => e.sku)).toEqual(['S1']);
  });

  it('converte venda fracionada (3,6 L, fator 3,6 → 1)', () => {
    const dir = monta({
      skus: [skuLinha('S1', 'L', 'GL', '3.6')],
      vendas: ['l1|S1|2026-03-02|3.6|50||1'],
    });
    const d = carregarDados(dir);
    expect(d.excluidos).toEqual([]);
    expect(d.vendas[0].quantidade).toBeCloseTo(1, 12);
    expect(d.vendas[0].valor).toBe(50);
  });

  it('unidades iguais: o fator do portal (0,2) NÃO converte a venda', () => {
    const d = carregarDados(
      monta({ skus: [skuLinha('S1', 'L', 'L', '0.2', { 7: '5' })], vendas: ['l1|S1|2026-03-02|4|40||1'] }),
    );
    expect(d.vendas[0].quantidade).toBe(4);
    expect(d.skus.get('S1')?.multiplo).toBe(5);
  });

  it('venda de SKU fora da coorte (no_escopo=0) é preservada, sem conversão', () => {
    const d = carregarDados(monta({ vendas: ['l1|S1|2026-03-02|2|20||1', 'l9|OUTRO|2026-03-02|7|70||0'] }));
    expect(d.vendas.find((v) => v.sku === 'OUTRO')).toMatchObject({ quantidade: 7, noEscopo: false });
  });

  it('venda no_escopo=1 de SKU fora de skus.csv é CSV inválido', () => {
    expect(() => carregarDados(monta({ vendas: ['l1|FANTASMA|2026-03-02|2|20||1'] }))).toThrow(
      'CSV_INVALIDO:vendas.csv',
    );
  });
});

describe('LT documental (§5.9)', () => {
  it('duEntre: seg–sex, exclui o dia inicial', () => {
    expect(duEntre('2026-01-05', '2026-01-12')).toBe(5);
    expect(duEntre('2026-01-09', '2026-01-12')).toBe(1); // sexta → segunda
    expect(duEntre('2026-01-10', '2026-01-11')).toBe(0);
    expect(duEntre('2026-01-05', '2026-01-05')).toBe(0);
  });

  it('um recebimento por documento-SKU: pedido 10, recebe 4 no du 9 → ltDu 9, fechado', () => {
    const d = carregarDados(monta({ recebimentos: ['T|S1|2026-01-05|2026-01-16|10|4'] }));
    expect(d.itensLT).toEqual([
      { trackingId: 'T', sku: 'S1', t1: '2026-01-05', t4: '2026-01-16', ltDu: 9, aberto: false },
    ]);
  });

  it('pedido aberto entra com LT conservador: aberto há 7 du → ltDu = 15', () => {
    // extração 2026-10-21 (quarta); t1 = 2026-10-12 (segunda) → 7 du
    const d = carregarDados(monta({ recebimentos: ['T|S1|2026-10-12||10|'] }));
    expect(duEntre('2026-10-12', '2026-10-21')).toBe(7);
    expect(d.itensLT).toEqual([{ trackingId: 'T', sku: 'S1', t1: '2026-10-12', t4: null, ltDu: 15, aberto: true }]);
  });

  it('faturado sem t4 há 40 du → fora da amostra, aviso SEM_T4_REGISTRADO', () => {
    // 2026-08-26 (quarta) → 2026-10-21: 40 du
    expect(duEntre('2026-08-26', '2026-10-21')).toBe(40);
    const d = carregarDados(monta({ recebimentos: ['T|S1|2026-08-26||10|'] }));
    expect(d.itensLT).toEqual([]);
    expect(d.avisos).toContainEqual({ codigo: 'SEM_T4_REGISTRADO', n: 1 });
  });

  it('sem t4 no limite (29 du) ainda é aberto', () => {
    const d = carregarDados(monta({ recebimentos: ['T|S1|2026-09-09||10|'] }));
    expect(duEntre('2026-09-09', '2026-10-21')).toBe(30);
    const d2 = carregarDados(monta({ recebimentos: ['T|S1|2026-09-10||10|'] }));
    expect(duEntre('2026-09-10', '2026-10-21')).toBe(29);
    expect(d.itensLT).toEqual([]);
    expect(d2.itensLT[0]).toMatchObject({ aberto: true, ltDu: 29 });
  });

  it('dedup preserva documentos distintos: mesmo (sku, t1, qtd), 2 tracking_id → 2 itens', () => {
    const d = carregarDados(
      monta({ recebimentos: ['A|S1|2026-01-05|2026-01-12|10|10', 'B|S1|2026-01-05|2026-01-12|10|10'] }),
    );
    expect(d.itensLT).toHaveLength(2);
  });

  it('t4 < t1 é excluído e contado em avisos (T4_ANTES_DE_T1)', () => {
    const d = carregarDados(
      monta({ recebimentos: ['A|S1|2026-01-12|2026-01-05|10|10', 'B|S1|2026-01-05|2026-01-12|10|10'] }),
    );
    expect(d.itensLT.map((i) => i.trackingId)).toEqual(['B']);
    expect(d.avisos).toContainEqual({ codigo: 'T4_ANTES_DE_T1', n: 1 });
  });
});
