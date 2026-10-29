import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { carregarDados, eventosDeRecebimento } from './dados';
import { duEntre } from './calendario';

const H = {
  vendas: 'linha_id|sku|data|quantidade|valor|cmc_linha|no_escopo',
  recebimentos: 'tracking_id|sku|t1|t4|quantidade_pedida|quantidade_recebida|t2|doc_md5|unidade_nfe|encerrado_omie|status_tracking',
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
  demanda_insumo: 'sku|share_insumo',
  parametros_view: 'sku|es|pp|max|status',
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
    demanda_insumo: [],
    parametros_view: ['S1|1|2|4|OK'],
  };
}

const dirs: string[] = [];
function monta(ov: Partial<Record<Nome, string[]>> = {}, log = 'extracao em 2026-10-21T12:57:16Z  dir=x\n'): string {
  const dir = mkdtempSync(join(tmpdir(), 'replay-dados-'));
  dirs.push(dir);
  const b = { ...base(), ...ov };
  // linha de recebimento sem a 7ª coluna (t2) ganha t2 vazio: os testes antigos não dependem dela
  b.recebimentos = b.recebimentos.map((l) => (l.split('|').length === 6 ? `${l}|` : l));
  // linha sem as 4 colunas documentais ganha: documento = o próprio tracking, unidade da NF = UN (a do skuLinha), não encerrado
  b.recebimentos = b.recebimentos.map((l) => (l.split('|').length === 7 ? `${l}|tracking:${l.split('|')[0]}|UN|f|FATURADO` : l));
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

  // Achado 4 do Codex (contraprova): pedido de 100, recebimento de 10 depois de 2 du NÃO fecha o item (§5.9: ≥ 95%).
  it('recebimento parcial (100 pedidos, 10 recebidos) deixa o item ABERTO: ltDu = max(du até a extração, 15)', () => {
    const d = carregarDados(monta({ recebimentos: ['T|S1|2026-01-05|2026-01-07|100|10'] }));
    expect(d.itensLT).toEqual([
      { trackingId: 'T', sku: 'S1', t1: '2026-01-05', t2: null, t4: null, ltDu: duEntre('2026-01-05', '2026-10-21'), aberto: true },
    ]);
    expect(d.avisos).toContainEqual({ codigo: 'RECEBIMENTO_PARCIAL', n: 1 });
  });

  it('fronteira dos 95%: 95 de 100 fecha; 94 de 100 fica aberto', () => {
    const fecha = carregarDados(monta({ recebimentos: ['T|S1|2026-01-05|2026-01-16|100|95'] }));
    expect(fecha.itensLT[0]).toMatchObject({ aberto: false, t4: '2026-01-16', ltDu: 9 });
    const abre = carregarDados(monta({ recebimentos: ['T|S1|2026-01-05|2026-01-16|100|94'] }));
    expect(abre.itensLT[0]).toMatchObject({ aberto: true, t4: null });
  });

  it('acumula recebimentos documentais: o LT é o t4 do documento que leva o acumulado a ≥ 95%', () => {
    const d = carregarDados(
      monta({ recebimentos: ['T|S1|2026-01-05|2026-01-09|50|30||docA|UN|f|FATURADO', 'T|S1|2026-01-05|2026-01-16|40|66||docB|UN|f|FATURADO', 'T|S1|2026-01-05|2026-01-23|10|4||docC|UN|f|FATURADO'] }),
    );
    expect(d.itensLT).toEqual([{ trackingId: 'T', sku: 'S1', t1: '2026-01-05', t2: null, t4: '2026-01-16', ltDu: 9, aberto: false }]);
  });

  it('converte o pedido para a unidade de estoque: NF em L, estoque em UN, fator documental do SKU (0,9 L/UN)', () => {
    // 3 documentos completos (2,7 L → 3 UN) dão o fator 3/2,7; o 4º (2,7 L → 1 UN) é parcial e fica aberto
    const r = (t: string, t4: string, q: string) => `${t}|S1|2026-01-05|${t4}|2.7|${q}||doc${t}|L|f|FATURADO`;
    const d = carregarDados(monta({ recebimentos: [r('A', '2026-01-09', '3'), r('B', '2026-01-12', '3'), r('C', '2026-01-13', '3'), r('D', '2026-01-14', '1')] }));
    expect(d.itensLT.filter((i) => !i.aberto).map((i) => i.trackingId)).toEqual(['A', 'B', 'C']);
    expect(d.itensLT.find((i) => i.trackingId === 'D')).toMatchObject({ aberto: true, t4: null });
  });

  it('sem fator documental confiável (NF ≠ estoque e < 3 documentos): CONVERSAO_INDETERMINADA, item aberto (fail-closed)', () => {
    const d = carregarDados(monta({ recebimentos: ['A|S1|2026-01-05|2026-01-09|2.7|3||docA|L|f|FATURADO'] }));
    expect(d.itensLT[0]).toMatchObject({ aberto: true, t4: null });
    expect(d.avisos).toContainEqual({ codigo: 'CONVERSAO_INDETERMINADA', n: 1 });
  });

  it('pedido aberto entra com LT conservador: aberto há 7 du → ltDu = 15', () => {
    // extração 2026-10-21 (quarta); t1 = 2026-10-12 (segunda) → 7 du
    const d = carregarDados(monta({ recebimentos: ['T|S1|2026-10-12||10|'] }));
    expect(duEntre('2026-10-12', '2026-10-21')).toBe(7);
    expect(d.itensLT).toEqual([{ trackingId: 'T', sku: 'S1', t1: '2026-10-12', t2: null, t4: null, ltDu: 15, aberto: true }]);
  });

  // Achado 5 do Codex: o aberto há 40 du representa um LT de 40 du, nunca sai da amostra por ser atrasado.
  it('sem t4 há 40 du continua na amostra como aberto (ltDu = 40); sem corte de 29 du', () => {
    expect(duEntre('2026-08-26', '2026-10-21')).toBe(40);
    const d = carregarDados(monta({ recebimentos: ['T|S1|2026-08-26||10|'] }));
    expect(d.itensLT).toEqual([{ trackingId: 'T', sku: 'S1', t1: '2026-08-26', t2: null, t4: null, ltDu: 40, aberto: true }]);
  });

  it('exclusão só com evidência documental: encerrado no Omie ou status RECEBIDO sem t4, com aviso contado', () => {
    const d = carregarDados(
      monta({ recebimentos: ['A|S1|2026-08-26||10|||docA|UN|t|CRIADO', 'B|S1|2026-08-26||10|||docB|UN|f|RECEBIDO', 'C|S1|2026-08-26||10|||docC|UN|f|FATURADO'] }),
    );
    expect(d.itensLT.map((i) => i.trackingId)).toEqual(['C']);
    expect(d.avisos).toContainEqual({ codigo: 'SEM_T4_ENCERRADO_OMIE', n: 1 });
    expect(d.avisos).toContainEqual({ codigo: 'SEM_T4_STATUS_RECEBIDO', n: 1 });
  });

  it('parcial encerrado no Omie fecha no último t4 (o saldo não vem mais), com aviso', () => {
    const d = carregarDados(monta({ recebimentos: ['T|S1|2026-01-05|2026-01-07|100|10||docA|UN|t|CRIADO'] }));
    expect(d.itensLT[0]).toMatchObject({ aberto: false, t4: '2026-01-07', ltDu: 2 });
    expect(d.avisos).toContainEqual({ codigo: 'PARCIAL_ENCERRADO_OMIE', n: 1 });
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

describe('eventosDeRecebimento (estoque físico)', () => {
  const l = (trackingId: string, sku: string, t1: string, t4: string | null, recebida: number | null, docId = `tracking:${trackingId}`) => ({
    trackingId, sku, t1, t2: null, t4, pedida: 99, recebida, docId, unidadeNfe: 'UN', encerrado: false, status: 'FATURADO',
  });
  const div = new Map([['S1', 1]]);
  // Achado 6 do Codex (contraprova): dois documentos distintos, 10 cada no mesmo dia → DOIS eventos.
  it('dois documentos distintos com a mesma quantidade no mesmo dia são dois eventos', () => {
    const { eventos } = eventosDeRecebimento([l('a', 'S1', '2026-01-05', '2026-01-12', 10, 'nfe1'), l('b', 'S1', '2026-01-06', '2026-01-12', 10, 'nfe2')], div);
    expect(eventos).toEqual([{ sku: 'S1', data: '2026-01-12', quantidade: 10 }, { sku: 'S1', data: '2026-01-12', quantidade: 10 }]);
  });
  it('o mesmo documento sob vários tracking_id (cópias idênticas) é UM evento', () => {
    const { eventos, avisos } = eventosDeRecebimento([l('a', 'S1', '2026-01-05', '2026-01-12', 10, 'nfe1'), l('b', 'S1', '2026-01-06', '2026-01-12', 10, 'nfe1'), l('c', 'S1', '2026-01-05', '2026-01-12', 10, 'nfe1')], div);
    expect(eventos).toEqual([{ sku: 'S1', data: '2026-01-12', quantidade: 10 }]);
    expect(avisos).toContainEqual({ codigo: 'COPIAS_DO_DOCUMENTO_FUNDIDAS', n: 2 });
  });
  it('o mesmo documento com quantidades diferentes por pedido soma as linhas (cada pedido é uma linha da NF)', () => {
    const { eventos, avisos } = eventosDeRecebimento([l('a', 'S1', '2026-01-05', '2026-01-12', 3, 'nfe1'), l('b', 'S1', '2026-01-06', '2026-01-12', 1, 'nfe1')], div);
    expect(eventos).toEqual([{ sku: 'S1', data: '2026-01-12', quantidade: 4 }]);
    expect(avisos).toContainEqual({ codigo: 'DOCUMENTO_COM_LINHAS_DIVERGENTES', n: 1 });
  });
  it('o mesmo documento com t4 divergente entre cópias entra no 1º t4, com aviso', () => {
    const { eventos, avisos } = eventosDeRecebimento([l('a', 'S1', '2026-01-05', '2026-01-14', 10, 'nfe1'), l('b', 'S1', '2026-01-05', '2026-01-12', 10, 'nfe1')], div);
    expect(eventos).toEqual([{ sku: 'S1', data: '2026-01-12', quantidade: 10 }]);
    expect(avisos).toContainEqual({ codigo: 'T4_DIVERGENTE_NO_DOCUMENTO', n: 1 });
  });
  it('sem t4, quantidade vazia/<=0, t4 antes de t1 ou SKU fora do contrato de unidade não viram evento', () => {
    const { eventos } = eventosDeRecebimento([l('a', 'S1', '2026-01-05', null, 3), l('b', 'S1', '2026-01-05', '2026-01-12', null), l('c', 'S1', '2026-01-05', '2026-01-12', 0), l('d', 'S1', '2026-01-20', '2026-01-12', 5), l('e', 'S9', '2026-01-05', '2026-01-12', 5)], div);
    expect(eventos).toEqual([]);
  });

  it('R17: t1 fabricado (t2 presente e t1 = t2) sai do LT com aviso, mas segue como recebimento físico', () => {
    // produção: lt_bruto_dias_uteis fica NULL quando o t1 é o fallback t2 (pedidoCasado?.t1 ?? nfe.t2), docs/agent/reposicao.md
    const d = carregarDados(
      monta({ recebimentos: ['A|S1|2026-01-05|2026-01-12|10|10|2026-01-05', 'B|S1|2026-01-06|2026-01-14|10|7|2026-01-08', 'C|S1|2026-01-07|2026-01-15|10|5|'] }),
    );
    expect(d.itensLT.map((i) => i.trackingId).sort()).toEqual(['B', 'C']);
    expect(d.avisos).toContainEqual({ codigo: 'T1_FABRICADO', n: 1 });
    expect(d.recebimentos.map((r) => r.data).sort()).toEqual(['2026-01-12', '2026-01-14', '2026-01-15']);
  });

  it('R16: demanda_insumo.csv vira o mapa shareInsumo (vazio é válido; fora de [0,1] reprova)', () => {
    expect(carregarDados(monta()).shareInsumo.size).toBe(0);
    const d = carregarDados(monta({ demanda_insumo: ['S1|0.82', 'S9|1'] }));
    expect(d.shareInsumo.get('S1')).toBeCloseTo(0.82, 12);
    expect(d.shareInsumo.get('S9')).toBe(1);
    expect(() => carregarDados(monta({ demanda_insumo: ['S1|1.5'] }))).toThrow(/CSV_INVALIDO:demanda_insumo\.csv/);
    expect(() => carregarDados(monta({ demanda_insumo: ['S1|'] }))).toThrow(/CSV_INVALIDO:demanda_insumo\.csv/);
  });

  it('R19: parametros_view.csv vira o mapa da view de produção (status OK exige os 3 parâmetros)', () => {
    const d = carregarDados(monta({ parametros_view: ['S1|1|2|4|OK', 'S2||||AGUARDANDO_SEGUNDA_ORDEM', 'S3||||SEM_PRECO'] }));
    expect(d.parametrosView.get('S1')).toEqual({ es: 1, pp: 2, max: 4, status: 'OK' });
    expect(d.parametrosView.get('S3')).toEqual({ es: null, pp: null, max: null, status: 'SEM_PRECO' });
    expect(() => carregarDados(monta({ parametros_view: ['S1|1||4|OK'] }))).toThrow(/CSV_INVALIDO:parametros_view\.csv/);
    expect(() => carregarDados(monta({ parametros_view: ['S1|1|2|4|'] }))).toThrow(/CSV_INVALIDO:parametros_view\.csv/);
  });
});
