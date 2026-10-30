import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { amostraDoSorteio, itensLtPermitidos } from './aleatorio';
import { carregarDados, consolidarLtMotor, eventosDeRecebimento, precosCompraPorDocumento, precoValeEm, type RecebLinha } from './dados';
import { duEntre } from './calendario';
import { ErroDadosReplay } from './tipos';

const H = {
  vendas: 'linha_id|sku|data|quantidade|valor|cmc_linha|no_escopo',
  recebimentos: 'tracking_id|sku|t1|t4|quantidade_pedida|quantidade_recebida|t2|doc_md5|unidade_nfe|encerrado_omie_em|status_tracking|valor_total|pedido_qtd|pedido_unidade|origem_compra',
  skus:
    'sku|descricao|grupo_codigo|classe_abc_hoje|classe_forcada|minimo_forcado|minimo_operacional|multiplo_embalagem|unidade_nf|unidade_estoque|fator_conversao|cmc|saldo_hoje|habilitado|ativo|custo_pedido_aplicado|custo_capital_perc|es_hoje|pp_hoje|max_hoje|grupo_embalagem_id',
  config_custos:
    'z_classe_a|z_classe_b|z_classe_c|selic_anual|spread_oportunidade|armazenagem_fisica|custo_pedido_manual|custo_pedido_api|modo_pedido|haircut_fallback_preco',
  classificacao_hist:
    'tipo|chave|classe_atual|classe_abc|classe_xyz|classe_pendente|meses_consecutivos|data_ultima_mudanca|valor',
  teto: 'key|value',
  equivalencias:
    'sku|sku_equivalente|fator|grupo_id|fator_para_base_sku|fator_para_base_equivalente|unidades_omie_sku|unidades_omie_equivalente',
  sugestao_hoje: 'sku|posicao|qtde_final|ajustado_humano|teto_aplicado|promocao|qtde_sem_teto',
  demanda_insumo: 'sku|share_insumo',
  parametros_view: 'sku|es|pp|max|status',
  precos_app: 'grupo_id|sku|fator_para_base|capturado_em|preco|elegivel_catalogo|stale_dias',
  motor: 'horario_geracao|ultima_passada',
  lt_motor: "doc|sku|fornecedor|t1|t2|t4|lt",
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
    sugestao_hoje: ['S1|2|3|f|f|f|3'],
    demanda_insumo: [],
    parametros_view: ['S1|1|2|4|OK'],
    precos_app: [],
    // execução do motor às 07:00 de SP, depois da passada das 01:16 de SP, no MESMO dia da extração (09:57 de SP)
    motor: ['2026-10-21T10:00:00Z|2026-10-21T04:16:00Z'],
    lt_motor: ["d1|S1|77|2026-01-05|2026-01-06 10:00:00|2026-01-12 09:00:00|5"],
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
  b.recebimentos = b.recebimentos.map((l) => (l.split('|').length === 7 ? `${l}|tracking:${l.split('|')[0]}|UN||FATURADO` : l));
  // valor_total (achado 2) vazio quando o teste não o informa: sem valor, sem preço de compra
  b.recebimentos = b.recebimentos.map((l) => (l.split('|').length === 11 ? `${l}|` : l));
  // sem as 2 colunas do pedido (R32): pedido não casado => fallback para a quantidade da NF
  b.recebimentos = b.recebimentos.map((l) => (l.split('|').length === 12 ? `${l}||` : l));
  // origem_compra (R38): normal quando o teste não informa
  b.recebimentos = b.recebimentos.map((l) => (l.split('|').length === 14 ? `${l}|normal` : l));
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
    expect(carregarDados(monta({ sugestao_hoje: ['S1|2|4|f|f|f|4'] })).hashDados).not.toBe(a);
  });
});

describe('leva E: sugestao_hoje compara a decisão do motor, não a edição humana', () => {
  const qtde = (linha: string) => carregarDados(monta({ sugestao_hoje: [linha] })).sugestaoHoje.get('S1')?.qtdeFinal;
  const avisoHumano = (linha: string) =>
    carregarDados(monta({ sugestao_hoje: [linha] })).avisos.find((x) => x.codigo === 'AJUSTE_HUMANO_COMPARADO_COM_O_MOTOR')?.n;
  const erro = (linha: string): string => {
    try {
      carregarDados(monta({ sugestao_hoje: [linha] }));
    } catch (e) {
      if (e instanceof ErroDadosReplay) return e.message;
      throw e;
    }
    return 'NAO_LANCOU';
  };

  it('sem ajuste humano => qtde_final, mesmo com qtde_sem_teto diferente ou vazia; sem aviso', () => {
    expect(qtde('S1|3|40|f|f|f|36')).toBe(40);
    expect(qtde('S1|3|18|f|t|f|')).toBe(18);
    expect(avisoHumano('S1|3|18|f|f|f|18')).toBeUndefined();
  });

  it('ajuste humano sem teto nem promoção => qtde_sem_teto (o caso 8689771455 de 29/10: 8, não 18) e conta no aviso', () => {
    expect(qtde('S1|3|18|t|f|f|8')).toBe(8);
    expect(avisoHumano('S1|3|18|t|f|f|8')).toBe(1);
  });

  it('ajuste humano com teto, promoção ou qtde_sem_teto vazia => para (nunca tira a linha do denominador)', () => {
    expect(erro('S1|3|18|t|t|f|8')).toContain('AJUSTE_HUMANO_SEM_DECISAO_DO_MOTOR: sku S1 (teto true');
    expect(erro('S1|3|18|t|f|t|8')).toContain('AJUSTE_HUMANO_SEM_DECISAO_DO_MOTOR: sku S1 (teto false, promoção true');
    expect(erro('S1|3|18|t|f|f|')).toContain('AJUSTE_HUMANO_SEM_DECISAO_DO_MOTOR: sku S1 (teto false, promoção false, qtde_sem_teto vazio)');
  });
});

describe('posição datada do Omie (âncora do estado inicial, §5.9)', () => {
  it('ausente => null; presente => mapa SKU → nSaldo (vazio fica fora, nunca 0), e entra no hash', () => {
    const dir = monta();
    const sem = carregarDados(dir);
    expect(sem.posicaoAbertura).toBeNull();
    expect(sem.posicaoConferencia).toBeNull();
    writeFileSync(join(dir, 'posicao_omie_2025-10-20.csv'), 'nCodProd|cCodigo|nSaldo|nCMC\n11|A|3.5|\n12|"B|x"||\n13|C|0|\nfim|ok\n');
    const com = carregarDados(dir);
    expect([...(com.posicaoAbertura ?? [])]).toEqual([['11', 3.5], ['13', 0]]);
    expect(com.posicaoConferencia).toBeNull();
    expect(com.hashDados).not.toBe(sem.hashDados);
    writeFileSync(join(dir, 'posicao_omie_2026-04-30.csv'), 'nCodProd|cCodigo|nSaldo|nCMC\n11|A|1|\nfim|ok\n');
    expect([...(carregarDados(dir).posicaoConferencia ?? [])]).toEqual([['11', 1]]);
    expect(carregarDados(dir).posicaoAquecimentoFim).toBeNull();
    writeFileSync(join(dir, 'posicao_omie_2026-01-31.csv'), 'nCodProd|cCodigo|nSaldo|nCMC\n11|A|2|\nfim|ok\n');
    const tres = carregarDados(dir);
    expect([...(tres.posicaoAquecimentoFim ?? [])]).toEqual([['11', 2]]);
    expect(tres.hashDados).not.toBe(com.hashDados);
  });
  it('posição sem marcador ou com nCodProd duplicado é CSV inválido', () => {
    const dir = monta();
    writeFileSync(join(dir, 'posicao_omie_2025-10-20.csv'), 'nCodProd|cCodigo|nSaldo|nCMC\n11|A|3|\n');
    expect(() => carregarDados(dir)).toThrow(/CSV_INVALIDO:posicao_omie_2025-10-20\.csv/);
    writeFileSync(join(dir, 'posicao_omie_2025-10-20.csv'), 'nCodProd|cCodigo|nSaldo|nCMC\n11|A|3|\n11|A|4|\nfim|ok\n');
    expect(() => carregarDados(dir)).toThrow(/nCodProd duplicado/);
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
      { trackingId: 'T', sku: 'S1', t1: '2026-01-05', t2: null, t4: null, ltDu: duEntre('2026-01-05', '2026-10-21'), aberto: true, pedidaDaNf: true },
    ]);
    expect(d.avisos).toContainEqual({ codigo: 'RECEBIMENTO_PARCIAL', n: 1 });
  });

  it('fronteira dos 95%: 95 de 100 fecha; 94 de 100 fica aberto', () => {
    const fecha = carregarDados(monta({ recebimentos: ['T|S1|2026-01-05|2026-01-16|100|95'] }));
    expect(fecha.itensLT[0]).toMatchObject({ aberto: false, t4: '2026-01-16', ltDu: 9 });
    const abre = carregarDados(monta({ recebimentos: ['T|S1|2026-01-05|2026-01-16|100|94'] }));
    expect(abre.itensLT[0]).toMatchObject({ aberto: true, t4: null });
  });

  // R32 (revisão I3): a quantidade PEDIDA vem do pedido de compra (raw_data.produtos_consulta[].nQtde casado por nCodProd).
  // Contraprova do Codex num formato que o dado real produz: pedido de 100 UN faturado e recebido em 10 → aberto.
  it('pedido de 100 UN faturado e recebido com 10 (NF = recebida) fica ABERTO pela quantidade do pedido', () => {
    const d = carregarDados(monta({ recebimentos: ['T|S1|2026-01-05|2026-01-07|10|10||docA|UN||FATURADO||100|UN'] }));
    expect(d.itensLT[0]).toMatchObject({ aberto: true, t4: null });
    expect(d.avisos).toContainEqual({ codigo: 'RECEBIMENTO_PARCIAL', n: 1 });
    expect(d.avisos.find((a) => a.codigo === 'PEDIDA_DA_NF')).toBeUndefined();
  });

  it('pedido de 100 UN com 96 recebidos fecha no t4 desse recebimento', () => {
    const d = carregarDados(monta({ recebimentos: ['T|S1|2026-01-05|2026-01-16|96|96||docA|UN||FATURADO||100|UN'] }));
    expect(d.itensLT[0]).toMatchObject({ aberto: false, t4: '2026-01-16', ltDu: 9 });
  });

  it('pedido não casado (sem nQtde) cai na quantidade da NF, com aviso PEDIDA_DA_NF contado', () => {
    const d = carregarDados(monta({ recebimentos: ['A|S1|2026-01-05|2026-01-16|10|10', 'B|S1|2026-01-05|2026-01-16|10|10'] }));
    expect(d.itensLT.every((i) => !i.aberto)).toBe(true);
    expect(d.avisos).toContainEqual({ codigo: 'PEDIDA_DA_NF', n: 2 });
  });

  it('pedido em unidade que não é a de estoque nem a da NF: CONVERSAO_INDETERMINADA (aberto)', () => {
    const d = carregarDados(monta({ recebimentos: ['T|S1|2026-01-05|2026-01-16|10|10||docA|UN||FATURADO||10|KG'] }));
    expect(d.itensLT[0]).toMatchObject({ aberto: true });
    expect(d.avisos).toContainEqual({ codigo: 'CONVERSAO_INDETERMINADA', n: 1 });
  });

  it('pedido na unidade da NF (L) com estoque em UN usa o fator documental NF→estoque', () => {
    // fator 3/2,7 de 3 documentos; o pedido E é de 5,4 L (= 6 UN) e só 3 UN chegaram → aberto
    const r = (t: string, t4: string, q: string, ped: string) => `${t}|S1|2026-01-05|${t4}|2.7|${q}||doc${t}|L||FATURADO||${ped}|L`;
    const d = carregarDados(monta({ recebimentos: [r('A', '2026-01-09', '3', '2.7'), r('B', '2026-01-12', '3', '2.7'), r('C', '2026-01-13', '3', '2.7'), r('E', '2026-01-14', '3', '5.4')] }));
    expect(d.itensLT.filter((i) => !i.aberto).map((i) => i.trackingId)).toEqual(['A', 'B', 'C']);
    expect(d.itensLT.find((i) => i.trackingId === 'E')).toMatchObject({ aberto: true });
  });

  // R33 (revisão I4): o fator modal só usa documentos com t4 <= 30/04; a avaliação não muda a calibração.
  it('fator documental ignora documentos com t4 > 30/04 (invariância da calibração)', () => {
    const r = (t: string, t4: string, q: string) => `${t}|S1|2026-01-05|${t4}|2.7|${q}||doc${t}|L||FATURADO|||`;
    const calib = [r('A', '2026-01-09', '3'), r('B', '2026-01-12', '3'), r('C', '2026-01-13', '3'), r('D', '2026-01-14', '1')];
    // na avaliação, 5 documentos com razão 1/2,7: se contassem, a moda viraria 0,37 e o D (1 UN) passaria a fechar
    const aval = ['F', 'G', 'H', 'I', 'J'].map((t, i) => r(t, `2026-06-0${i + 1}`, '1'));
    const so = carregarDados(monta({ recebimentos: calib }));
    const com = carregarDados(monta({ recebimentos: [...calib, ...aval] }));
    const doc = (x: typeof so, t: string) => x.itensLT.find((i) => i.trackingId === t);
    expect(doc(com, 'D')).toEqual(doc(so, 'D'));
    expect(doc(so, 'D')).toMatchObject({ aberto: true });
    // e só 2 documentos até 30/04 => indeterminado, por mais documentos que a avaliação traga
    const dois = carregarDados(monta({ recebimentos: [r('A', '2026-01-09', '3'), r('B', '2026-01-12', '3'), ...aval] }));
    expect(doc(dois, 'A')).toMatchObject({ aberto: true });
  });

  it('converte o pedido para a unidade de estoque: NF em L, estoque em UN, fator documental do SKU (0,9 L/UN)', () => {
    // 3 documentos completos (2,7 L → 3 UN) dão o fator 3/2,7; o 4º (2,7 L → 1 UN) é parcial e fica aberto
    const r = (t: string, t4: string, q: string) => `${t}|S1|2026-01-05|${t4}|2.7|${q}||doc${t}|L||FATURADO`;
    const d = carregarDados(monta({ recebimentos: [r('A', '2026-01-09', '3'), r('B', '2026-01-12', '3'), r('C', '2026-01-13', '3'), r('D', '2026-01-14', '1')] }));
    expect(d.itensLT.filter((i) => !i.aberto).map((i) => i.trackingId)).toEqual(['A', 'B', 'C']);
    expect(d.itensLT.find((i) => i.trackingId === 'D')).toMatchObject({ aberto: true, t4: null });
  });

  it('sem fator documental confiável (NF ≠ estoque e < 3 documentos): CONVERSAO_INDETERMINADA, item aberto (fail-closed)', () => {
    const d = carregarDados(monta({ recebimentos: ['A|S1|2026-01-05|2026-01-09|2.7|3||docA|L||FATURADO'] }));
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

  // R47: só o encerramento DATADO exclui o sem-t4; status RECEBIDO (estado de hoje, sem data) não prova recebimento.
  it('exclusão só com o encerramento datado no Omie; status RECEBIDO sem t4 fica aberto, com aviso contado', () => {
    const d = carregarDados(
      monta({ recebimentos: ['A|S1|2026-08-26||10|||docA|UN|2026-09-01|CRIADO', 'B|S1|2026-08-26||10|||docB|UN||RECEBIDO', 'C|S1|2026-08-26||10|||docC|UN||FATURADO'] }),
    );
    expect(d.itensLT.map((i) => i.trackingId)).toEqual(['B', 'C']);
    expect(d.itensLT.every((i) => i.aberto)).toBe(true);
    expect(d.avisos).toContainEqual({ codigo: 'SEM_T4_ENCERRADO_OMIE', n: 1 });
    expect(d.avisos).toContainEqual({ codigo: 'SEM_T4_STATUS_RECEBIDO', n: 1 });
  });

  it('parcial encerrado no Omie fecha no último t4, conhecido só a partir do encerramento datado (R47), com aviso', () => {
    const d = carregarDados(monta({ recebimentos: ['T|S1|2026-01-05|2026-01-07|100|10||docA|UN|2026-03-10|CRIADO||100|UN'] }));
    expect(d.itensLT[0]).toMatchObject({ aberto: false, t4: '2026-01-07', ltDu: 2, conhecidoEm: '2026-03-10' });
    expect(d.avisos).toContainEqual({ codigo: 'PARCIAL_ENCERRADO_OMIE', n: 1 });
    // encerrado antes do último t4: conhecido no próprio t4 (sem campo)
    const e = carregarDados(monta({ recebimentos: ['T|S1|2026-01-05|2026-01-07|100|10||docA|UN|2026-01-06|CRIADO||100|UN'] }));
    expect(e.itensLT[0]).toEqual({ trackingId: 'T', sku: 'S1', t1: '2026-01-05', t2: null, t4: '2026-01-07', ltDu: 2, aberto: false });
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
    trackingId, sku, t1, t2: null, t4, pedida: 99, recebida, docId, unidadeNfe: 'UN', encerradoEm: null, status: 'FATURADO',
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
  it('o mesmo documento com quantidades diferentes no mesmo dia: cada pedido é uma linha da NF (eventos distintos)', () => {
    const { eventos, avisos } = eventosDeRecebimento([l('a', 'S1', '2026-01-05', '2026-01-12', 3, 'nfe1'), l('b', 'S1', '2026-01-06', '2026-01-12', 1, 'nfe1')], div);
    expect(eventos).toEqual([{ sku: 'S1', data: '2026-01-12', quantidade: 1 }, { sku: 'S1', data: '2026-01-12', quantidade: 3 }]);
    expect(avisos).toContainEqual({ codigo: 'DOCUMENTO_COM_LINHAS_DIVERGENTES', n: 1 });
  });
  // R52 (I3, contraprova do revisor): a MESMA NF com a MESMA quantidade sob tracking_id distintos e t4 diferente é UMA
  // entrada física (atraso de registro) — fica a de menor t4, nunca duas.
  it('R52: cópias da mesma quantidade com t4 diferente (tracking_id distintos) são UMA entrada, no menor t4, com aviso', () => {
    const { eventos, avisos } = eventosDeRecebimento([l('a', 'S1', '2026-01-05', '2026-01-14', 10, 'nfe1'), l('b', 'S1', '2026-01-05', '2026-01-12', 10, 'nfe1')], div);
    expect(eventos).toEqual([{ sku: 'S1', data: '2026-01-12', quantidade: 10 }]);
    expect(avisos).toContainEqual({ codigo: 'T4_DIVERGENTE_NO_DOCUMENTO', n: 1 });
    expect(avisos).toContainEqual({ codigo: 'COPIAS_DO_DOCUMENTO_FUNDIDAS', n: 1 });
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

describe('preços point-in-time (achados 2 e 9 do Codex)', () => {
  const l = (trackingId: string, t4: string | null, recebida: number | null, valor: number | null, docId: string): RecebLinha => ({
    trackingId, sku: 'S1', t1: '2026-01-05', t2: null, t4, pedida: 10, recebida, docId, unidadeNfe: 'UN', encerradoEm: null, status: 'FATURADO', valor,
  });
  it('preco_compra_real por documento: valor ÷ recebida; cópias divergentes, sem valor ou sem t4 não dão preço', () => {
    const p = precosCompraPorDocumento([
      l('a', '2026-01-12', 10, 50, 'nfe1'), l('b', '2026-01-14', 10, 50, 'nfe1'), // cópias coerentes: desde = maior t4
      l('c', '2026-01-20', 4, 20, 'nfe2'), l('d', '2026-01-20', 4, 22, 'nfe2'), // valor divergente: a view anula
      l('e', '2026-01-21', 5, null, 'nfe3'), // sem valor: ausente, nunca 0
      l('f', null, 5, 30, 'nfe4'), // sem t4
      l('g', '2026-01-22', 0, 30, 'nfe5'), // recebida 0: fora do FILTER da produção
    ]);
    // R51: as duas cópias de nfe1 existem desde 05/01; entre 12/01 e 14/01 a de 14/01 ainda não tem t4 (count(t4) ≠
    // count(*)): o preço só vale depois de 14/01. A cópia sem t4 (nfe4) nunca dá preço.
    expect(p).toEqual([{ sku: 'S1', desde: '2026-01-14', preco: 5 }]);
  });
  it('carrega valor_total e precos_app (stale, elegibilidade e capturas ordenadas)', () => {
    const d = carregarDados(
      monta({
        recebimentos: ['T|S1|2026-01-05|2026-01-12|10|10||docA|UN||FATURADO|35'],
        precos_app: ['G|S1|1|2026-06-10|12|t|45', 'G|S1|1|2026-06-05|11|t|45', 'G|S2|4|||f|45'],
      }),
    );
    expect(d.precosCompra).toEqual([{ sku: 'S1', desde: '2026-01-12', preco: 3.5 }]);
    expect(d.precosEmbalagem?.staleDias).toBe(45);
    expect(d.precosEmbalagem?.capturas.get('S1')).toEqual([{ data: '2026-06-05', instante: '2026-06-05', preco: 11 }, { data: '2026-06-10', instante: '2026-06-10', preco: 12 }]);
    expect(d.precosEmbalagem?.capturas.has('S2')).toBe(false);
    expect([...(d.precosEmbalagem?.elegivel ?? [])]).toEqual([['S1', true], ['S2', false]]);
    expect(carregarDados(monta()).precosEmbalagem).toBeNull();
    expect(() => carregarDados(monta({ precos_app: ['G|S1|1|2026-06-10||t|45'] }))).toThrow(/CSV_INVALIDO:precos_app\.csv: captura incompleta/);
    expect(() => carregarDados(monta({ precos_app: ['G|S1|1|2026-06-10|0|t|45'] }))).toThrow(/CSV_INVALIDO:precos_app\.csv: preco <= 0/);
  });
});

describe('Fix Codex leva C — R38 (origem_compra)', () => {
  it('LT e preço só com origem_compra = normal: outra origem, vazia ou coluna ausente param a carga (fail-closed)', () => {
    const rec = (origem: string) => [`T9|S1|2026-03-02|2026-03-09|5|5||tracking:T9|UN||FATURADO|50|||${origem}`];
    expect(() => carregarDados(monta({ recebimentos: rec('normal') }))).not.toThrow();
    expect(() => carregarDados(monta({ recebimentos: rec('oportunidade_promo') }))).toThrow(/^ORIGEM_COMPRA_NAO_NORMAL:/);
    expect(() => carregarDados(monta({ recebimentos: rec('') }))).toThrow(/^ORIGEM_COMPRA_NAO_NORMAL:/);
    expect(() => carregarDados(monta({ recebimentos: rec('oportunidade_promo') }))).toThrow(ErroDadosReplay);
  });
});

describe('Fix Codex leva C round 1 — R40 (data de SP e passada do motor) e R43 (LT do F0 da view)', () => {
  it('R40: a data da extração é a de São Paulo, não a de UTC', () => {
    // 02:12Z de 29/10 = 23:12 de 28/10 em SP; motor às 21:57Z de 28 e passada às 04:16Z de 28
    const d = carregarDados(monta({ motor: ['2026-10-28T21:57:00Z|2026-10-28T04:16:00Z'] }, 'extracao em 2026-10-29T02:12:28Z  dir=x\n'));
    expect(d.dataExtracao).toBe('2026-10-28');
    expect(d.motor).toEqual({ horarioGeracao: '2026-10-28T21:57:00Z', ultimaPassada: '2026-10-28T04:16:00Z' });
  });
  it('R40: passada do motor entre a execução gravada e a extração para a carga', () => {
    const log = 'extracao em 2026-10-29T12:00:00Z  dir=x\n';
    expect(() => carregarDados(monta({ motor: ['2026-10-29T09:00:00Z|2026-10-29T10:16:00Z'] }, log))).toThrow(/^PASSADA_ENTRE_MOTOR_E_EXTRACAO/);
    expect(() => carregarDados(monta({ motor: ['2026-10-29T09:00:00Z|2026-10-29T04:16:00Z'] }, log))).not.toThrow();
  });
  it('R40: execução do motor de outro dia (SP) que o da extração para a carga', () => {
    // motor às 20:00 de SP de 28/10 e extração às 00:30 de SP de 29/10, sem passada no meio: a decisão é de outro dia
    const log = 'extracao em 2026-10-29T03:30:00Z  dir=x\n';
    expect(() => carregarDados(monta({ motor: ['2026-10-28T23:00:00Z|2026-10-28T04:16:00Z'] }, log))).toThrow(/^MOTOR_DE_OUTRO_DIA/);
  });
  it('R40: motor.csv sem linha ou com mais de uma para a carga (fail-closed)', () => {
    expect(() => carregarDados(monta({ motor: [] }))).toThrow(/motor\.csv/);
    expect(() => carregarDados(monta({ motor: ['2026-10-21T10:00:00Z|2026-10-21T04:16:00Z', '2026-10-21T11:00:00Z|2026-10-21T04:16:00Z'] }))).toThrow(/motor\.csv/);
  });
  it('R43: lt_motor.csv (cópias cruas da view normal) vira a amostra do LT do F0, consolidada por documento, com fornecedor', () => {
    const d = carregarDados(
      monta({ lt_motor: ['d1|S1|77|2026-01-05|2026-01-06 10:00:00|2026-01-12 09:00:00|5', 'd2|S9|77|2026-02-02|2026-02-02 08:00:00|2026-02-09 08:00:00|7', 'd3|S1|||2026-03-02 08:00:00|2026-03-05 08:00:00|3'] }),
    );
    expect(d.ltMotor).toEqual([
      { sku: 'S1', fornecedor: 77, t2: '2026-01-06', t4: '2026-01-12', lt: 5, desde: '2026-01-12' },
      { sku: 'S9', fornecedor: 77, t2: '2026-02-02', t4: '2026-02-09', lt: 7, desde: '2026-02-09' },
      { sku: 'S1', fornecedor: null, t2: '2026-03-02', t4: '2026-03-05', lt: 3, desde: '2026-03-05' },
    ]);
    expect(() => carregarDados(monta({ lt_motor: ['d1|S1|77|2026-01-05|2026-01-06|2026-01-12 09:00:00|5'] }))).toThrow(/lt_motor\.csv/); // instante sem hora: inválido
  });
});

describe('Fix Codex leva C round 3 — R45 (nCMC da posição datada do Omie)', () => {
  it('R45: o nCMC de cada posição datada vira cmcOmie (por data, crescente); vazio fica fora (nunca 0)', () => {
    const dir = monta();
    expect(carregarDados(dir).cmcOmie).toEqual([]);
    writeFileSync(join(dir, 'posicao_omie_2026-04-30.csv'), 'nCodProd|cCodigo|nSaldo|nCMC\n11|A|1|7.5\n12|B|2|\nfim|ok\n');
    writeFileSync(join(dir, 'posicao_omie_2026-01-31.csv'), 'nCodProd|cCodigo|nSaldo|nCMC\n11|A|2|6\nfim|ok\n');
    const d = carregarDados(dir);
    expect(d.cmcOmie!.map((x) => [x.data, [...x.cmc]])).toEqual([
      ['2026-01-31', [['11', 6]]],
      ['2026-04-30', [['11', 7.5]]],
    ]);
    writeFileSync(join(dir, 'posicao_omie_2026-01-31.csv'), 'nCodProd|cCodigo|nSaldo|nCMC\n11|A|2|0\nfim|ok\n');
    expect(() => carregarDados(dir)).toThrow(/nCMC ≤ 0/); // o extrator grava vazio; 0 no arquivo é fabricação
  });
});

describe('Fix Codex leva D — N1 (R46/R47), N3, P2a e P2b', () => {
  // Contraprova N1 do Codex: pedido de 100, NF/recebimento de 10 em 2 du. Só o encerramento DATADO fecha, e só a partir dele.
  it('N1/R47: parcial com encerramento depois do fim da calibração não entra na amostra da calibração; sem data fica aberto', () => {
    const rec = (enc: string) => [`T|S1|2026-02-02|2026-02-04|10|10||docA|UN|${enc}|CRIADO||100|UN`];
    const tarde = carregarDados(monta({ recebimentos: rec('2026-06-15') }));
    expect(tarde.itensLT[0]).toMatchObject({ aberto: false, t4: '2026-02-04', ltDu: 2, conhecidoEm: '2026-06-15' });
    expect(itensLtPermitidos(tarde.itensLT, true, tarde.dataExtracao)).toEqual([]); // em 30/04 o item ainda estava aberto
    expect(itensLtPermitidos(tarde.itensLT, false, tarde.dataExtracao)).toHaveLength(1);
    const cedo = carregarDados(monta({ recebimentos: rec('2026-03-01') }));
    expect(itensLtPermitidos(cedo.itensLT, true, cedo.dataExtracao)).toHaveLength(1);
    const sem = carregarDados(monta({ recebimentos: rec('') }));
    expect(sem.itensLT[0]).toMatchObject({ aberto: true, t4: null });
  });

  it('N1/R46: item sem a quantidade do pedido (PEDIDA_DA_NF) é marcado e sai da amostra do sorteio; com pedido, fica', () => {
    const d = carregarDados(monta({ recebimentos: ['A|S1|2026-02-02|2026-02-04|10|10', 'B|S1|2026-02-02|2026-02-05|10|10||docB|UN||FATURADO||10|UN'] }));
    expect(d.itensLT.find((i) => i.trackingId === 'A')).toMatchObject({ aberto: false, pedidaDaNf: true });
    expect(d.itensLT.find((i) => i.trackingId === 'B')?.pedidaDaNf).toBeUndefined();
    expect(amostraDoSorteio(d.itensLT).map((i) => i.trackingId)).toEqual(['B']);
    expect(d.avisos).toContainEqual({ codigo: 'PEDIDA_DA_NF', n: 1 });
  });

  // Contraprova N3 do Codex (preço) + R51 (I2/M4): a cópia que ainda NÃO EXISTIA em d (t1 ≥ d) não apaga o preço de d; a
  // que já existia em d sem t4 < d (inclusive sem t4 nenhum) anula o documento em d, como o count(t4) = count(*) da view.
  it('N3/R51: no corte d, a cópia criada depois de d não muda o preço; a existente sem t4 < d anula o documento', () => {
    const l = (tr: string, t4: string | null, valor: number, t1 = '2026-01-05'): RecebLinha => ({
      trackingId: tr, sku: 'S1', t1, t2: null, t4, pedida: 10, recebida: t4 === null ? null : 10, docId: 'nfe1', unidadeNfe: 'UN', encerradoEm: null, status: 'FATURADO', valor,
    });
    const em = (ps: ReturnType<typeof precosCompraPorDocumento>, d: string) => ps.filter((p) => precoValeEm(p, d)).map((p) => p.preco);
    const so = precosCompraPorDocumento([l('a', '2026-01-12', 10)]);
    expect(em(so, '2026-02-10')).toEqual([1]);
    // cópia criada em 20/04 (outro pedido) e recebida em 10/05: fevereiro intacto; de 21/04 a 10/05 anulado; depois, de volta
    const tarde = precosCompraPorDocumento([l('a', '2026-01-12', 10), l('b', '2026-05-10', 10, '2026-04-20')]);
    expect([em(tarde, '2026-02-10'), em(tarde, '2026-04-20'), em(tarde, '2026-04-21'), em(tarde, '2026-05-10'), em(tarde, '2026-05-11')]).toEqual([[1], [1], [], [], [1]]);
    // a mesma cópia já existindo em fevereiro (t1 de janeiro) sem t4 < d: anulado em fevereiro (a view no corte)
    expect(em(precosCompraPorDocumento([l('a', '2026-01-12', 10), l('b', '2026-05-10', 10)]), '2026-02-10')).toEqual([]);
    // contraprova do revisor (M4): cópia SEM t4 nenhum anula o documento sempre
    const semT4 = precosCompraPorDocumento([l('a', '2026-01-12', 10), l('b', null, 10)]);
    expect(semT4).toEqual([]);
    // cópia futura DIVERGENTE: anula a partir do dia em que existe
    const div = precosCompraPorDocumento([l('a', '2026-01-12', 10), l('b', '2026-05-10', 12, '2026-04-20')]);
    expect([em(div, '2026-02-10'), em(div, '2026-05-11')]).toEqual([[1], []]);
  });

  // Contraprova N3 do Codex (LT do F0): a cópia de maio mudava o LT de fevereiro de 40 para 10 du. R51/I2 (contraprova do
  // revisor): a cópia SEM t4 (tracking de outro pedido da mesma NF, existente desde o t1) anula a observação, como a view.
  it('N3/R51: a consolidação da view é refeita no corte, ao pé da letra (count(t4) = count(*))', () => {
    const jan = { doc: 'D', sku: 'S1', fornecedor: 77, t1: '2026-01-02', t2: '2026-01-02 10:00:00', t4: '2026-01-20 09:00:00', lt: 40 };
    const mai = { doc: 'D', sku: 'S1', fornecedor: 77, t1: '2026-04-25', t2: '2026-05-01 10:00:00', t4: '2026-05-12 09:00:00', lt: 10 };
    const obsJan = { sku: 'S1', fornecedor: 77, t2: '2026-01-02', t4: '2026-01-20', lt: 40 };
    expect(consolidarLtMotor([jan])).toEqual([{ ...obsJan, desde: '2026-01-20' }]);
    // a cópia de maio (criada em 25/04) não toca fevereiro; existe sem t4 de 26/04 em diante e, com t4, diverge: some
    expect(consolidarLtMotor([jan, mai])).toEqual([{ ...obsJan, desde: '2026-01-20', ate: '2026-04-25' }]);
    // cópia sem t4 existente desde o t1: o documento nunca dá observação (a view anula hoje e anulava em d)
    expect(consolidarLtMotor([jan, { ...jan, t4: null, lt: null }])).toEqual([]);
    // cópia sem t4 criada só em junho: fevereiro a maio valem; depois, anulado
    expect(consolidarLtMotor([jan, { ...jan, t1: '2026-06-01', t4: null, lt: null }])).toEqual([{ ...obsJan, desde: '2026-01-20', ate: '2026-06-01' }]);
    // cópias divergentes no MESMO dia, ou instante diferente no mesmo dia: a view anula
    expect(consolidarLtMotor([jan, { ...jan, lt: 41 }])).toEqual([]);
    expect(consolidarLtMotor([jan, { ...jan, t4: '2026-01-20 15:00:00' }])).toEqual([]);
  });

  // P2a do re-Codex: no mesmo documento, 10 em 03/04 e 20 em 06/04 viravam 30 em 03/04.
  it('P2a: recebimentos do mesmo documento em datas diferentes entram cada um na sua data', () => {
    const l = (tr: string, t4: string, recebida: number): RecebLinha => ({
      trackingId: tr, sku: 'S1', t1: '2026-03-30', t2: null, t4, pedida: 30, recebida, docId: 'nfe1', unidadeNfe: 'UN', encerradoEm: null, status: 'FATURADO',
    });
    const { eventos } = eventosDeRecebimento([l('a', '2026-04-03', 10), l('b', '2026-04-06', 20), l('c', '2026-04-03', 10)], new Map([['S1', 1]]));
    expect(eventos).toEqual([{ sku: 'S1', data: '2026-04-03', quantidade: 10 }, { sku: 'S1', data: '2026-04-06', quantidade: 20 }]);
    // R52: a cópia de 10 registrada de novo em 08/04 sob outro tracking continua sendo a mesma entrada (fica 03/04)
    const r = eventosDeRecebimento([l('a', '2026-04-03', 10), l('b', '2026-04-06', 20), l('d', '2026-04-08', 10)], new Map([['S1', 1]]));
    expect(r.eventos).toEqual(eventos);
  });

  // P2b do re-Codex: o extrator ordenava por preço dentro do dia; a carga ordena pelo instante.
  it('P2b: capturas do mesmo dia ficam na ordem da hora, não do preço', () => {
    const d = carregarDados(monta({ precos_app: ['G|S1|1|2026-06-10T15:00:00|20|t|45', 'G|S1|1|2026-06-10T09:00:00|100|t|45'] }));
    expect(d.precosEmbalagem?.capturas.get('S1')?.map((c) => c.preco)).toEqual([100, 20]);
    expect(() => carregarDados(monta({ precos_app: ['G|S1|1|2026-06-10 15h|20|t|45'] }))).toThrow(/capturado_em inválido/);
  });
});
