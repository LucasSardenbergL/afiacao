import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  LIMIAR_COBERTURA_ALVO_DIAS, LIMIAR_GIRO_MORTO_DIAS_FIN, LIMIAR_SEGURAR_COMPRA_DIAS,
  MANUAL_VALIDADE_DIAS, normalizarGiro, overrideManualVigente, resumirGiro, separarListas, type GiroSku,
} from '@/lib/financeiro/ciclo-giro-helpers';

const linha = (o: Partial<GiroSku>): GiroSku => ({
  omieCodigoProduto: 1, codigo: 'P1', descricao: 'X', tipoProduto: '00', familia: 'LIXAS', classe: 'giro',
  divergenciaCadastro: false, saldo: 1, cmc: 1, valorParado: 1, consumoQtd365d: 0, diasCobertura: null,
  ultimaSaida: null, diasSemSaida: null, valorExcedente: null, acao: null, motivoAcao: null, motivoConsumo: null, ...o,
});

describe('resumirGiro — ausente nunca vira 0', () => {
  it('soma só termos conhecidos; sem custo conta à parte', () => {
    const r = resumirGiro([
      linha({ valorParado: 1000, acao: 'liquidar' }),
      linha({ valorParado: null, cmc: 0, acao: 'liquidar' }),
      linha({ valorParado: 400, valorExcedente: 310, acao: 'segurar_compra' }),
      linha({ classe: 'fora_giro', valorParado: 1000, motivoConsumo: 'fora_do_giro' }),
      linha({ classe: 'sem_classificacao', valorParado: 9, motivoConsumo: 'fora_do_giro' }),
    ]);
    expect(r).toEqual({
      valorGiro: 1400, skusSemCusto: 1, valorLiquidar: 1000, valorExcedenteSegurar: 310,
      valorForaGiro: 1000, valorSemClassificacao: 9, temFonteConsumo: true,
    });
  });

  it('nenhum termo conhecido → null, não 0', () => {
    const r = resumirGiro([linha({ valorParado: null, cmc: 0 })]);
    expect(r.valorGiro).toBeNull();
    expect(r.valorLiquidar).toBeNull();
    expect(r.valorExcedenteSegurar).toBeNull();
    expect(r.valorForaGiro).toBeNull();
    expect(r.valorSemClassificacao).toBeNull();
  });

  it('sem fonte de consumo em nenhuma linha de giro → temFonteConsumo false', () => {
    const r = resumirGiro([
      linha({ motivoConsumo: 'sem_consumo_por_sku' }),
      linha({ classe: 'fora_giro', motivoConsumo: 'fora_do_giro' }),
    ]);
    expect(r.temFonteConsumo).toBe(false);
  });

  it('lista vazia → tudo null e sem fonte', () => {
    expect(resumirGiro([])).toEqual({
      valorGiro: null, skusSemCusto: 0, valorLiquidar: null, valorExcedenteSegurar: null,
      valorForaGiro: null, valorSemClassificacao: null, temFonteConsumo: false,
    });
  });
});

describe('separarListas', () => {
  it('fora do giro e sem classificação vão para a lista de acompanhamento', () => {
    const { giro, foraGiro } = separarListas([
      linha({ omieCodigoProduto: 1 }), linha({ omieCodigoProduto: 2, classe: 'fora_giro' }),
      linha({ omieCodigoProduto: 3, classe: 'sem_classificacao' }),
    ]);
    expect(giro.map((l) => l.omieCodigoProduto)).toEqual([1]);
    expect(foraGiro.map((l) => l.omieCodigoProduto)).toEqual([2, 3]);
  });
});

describe('normalizarGiro', () => {
  it('numeric do PostgREST (string) vira number; null continua null', () => {
    const n = normalizarGiro({
      omie_codigo_produto: 1001, codigo: 'P', descricao: null, tipo_produto: '00', familia: null, classe: 'giro',
      divergencia_cadastro: false, saldo: '100', cmc: '10', valor_parado: '1000', consumo_qtd_365d: null,
      dias_cobertura: null, ultima_saida: null, dias_sem_saida: null, valor_excedente: null, acao: null,
      motivo_acao: null, motivo_consumo: 'sem_consumo_por_sku',
    });
    expect([n?.saldo, n?.valorParado, n?.consumoQtd365d, n?.motivoConsumo]).toEqual([100, 1000, null, 'sem_consumo_por_sku']);
  });

  it('linha sem código ou com classe desconhecida é descartada (null)', () => {
    expect(normalizarGiro({ omie_codigo_produto: null, classe: 'giro', saldo: 1 })).toBeNull();
    expect(normalizarGiro({ omie_codigo_produto: 1, classe: 'outra', saldo: 1 })).toBeNull();
  });
});

describe('overrideManualVigente — mesma janela do motor', () => {
  it('só manual, de hoje−45 até hoje; futuro e vencido ficam fora', () => {
    const h = '2026-10-18', ini = '2026-09-03';
    expect(overrideManualVigente('2026-10-18', 'manual', h, ini)).toBe(true);
    expect(overrideManualVigente('2026-09-03', 'manual', h, ini)).toBe(true);
    expect(overrideManualVigente('2026-09-02', 'manual', h, ini)).toBe(false);
    expect(overrideManualVigente('2026-10-19', 'manual', h, ini)).toBe(false);
    expect(overrideManualVigente('2026-10-18', 'omie', h, ini)).toBe(false);
  });

  it('janela TS = edge', () => {
    const edge = readFileSync('supabase/functions/fin-cashflow-engine/estoque-pme.ts', 'utf8');
    expect(edge).toContain(`MANUAL_VALIDADE_DIAS = ${MANUAL_VALIDADE_DIAS}`);
  });
});

describe('limiares TS = SQL (uma regra, dois lugares travados)', () => {
  it('constantes da migration batem com as do helper', () => {
    const sql = readFileSync('supabase/migrations/20261018200000_fin_ciclo_giro_sku.sql', 'utf8');
    expect(sql).toContain(`c_cobertura_alvo_dias CONSTANT int := ${LIMIAR_COBERTURA_ALVO_DIAS};`);
    expect(sql).toContain(`c_segurar_compra_dias CONSTANT int := ${LIMIAR_SEGURAR_COMPRA_DIAS};`);
    expect(sql).toContain(`c_giro_morto_dias CONSTANT int := ${LIMIAR_GIRO_MORTO_DIAS_FIN};`);
    expect([LIMIAR_COBERTURA_ALVO_DIAS, LIMIAR_SEGURAR_COMPRA_DIAS, LIMIAR_GIRO_MORTO_DIAS_FIN]).toEqual([90, 180, 270]);
  });
});
