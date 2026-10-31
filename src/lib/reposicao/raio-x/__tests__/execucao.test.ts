import { describe, expect, it } from 'vitest';
import {
  alertaPiso,
  concluidoVigente,
  custoEsperarMensal,
  pisoVigente,
  resumoExecucao,
  situacaoPlano,
} from '../execucao';
import { decisao } from './fixtures';

const HOJE = '2026-11-10';
const decidido = { decidido_em: '2026-11-01T12:00:00Z' };

describe('custoEsperarMensal', () => {
  it('valor × taxa anual / 12', () => {
    expect(custoEsperarMensal(5041.47, 0.1775)).toBeCloseTo(74.57, 2);
  });
  it('ausente ≠ zero: sem valor, sem taxa ou não-finito → null (nunca 0)', () => {
    expect(custoEsperarMensal(null, 0.1775)).toBeNull();
    expect(custoEsperarMensal(1000, null)).toBeNull();
    expect(custoEsperarMensal(Number.NaN, 0.1)).toBeNull();
    expect(custoEsperarMensal(1000, Number.POSITIVE_INFINITY)).toBeNull();
    expect(custoEsperarMensal(0, 0.1)).toBeNull();
    expect(custoEsperarMensal(1000, 0)).toBeNull();
  });
});

describe('concluidoVigente', () => {
  it('executado depois da decisão vigente conta', () => {
    expect(concluidoVigente({ concluido_em: '2026-11-05T00:00:00Z', decidido_em: '2026-11-01T00:00:00Z' })).toBe(true);
  });
  it('executado ANTES do decidido_em vigente (destino mudou depois) não conta', () => {
    expect(concluidoVigente({ concluido_em: '2026-11-01T00:00:00Z', decidido_em: '2026-11-03T00:00:00Z' })).toBe(false);
  });
  it('sem concluido_em → false; sem decidido_em → vale o executado', () => {
    expect(concluidoVigente({ concluido_em: null, decidido_em: '2026-11-01T00:00:00Z' })).toBe(false);
    expect(concluidoVigente({ concluido_em: '2026-11-01T00:00:00Z', decidido_em: null })).toBe(true);
  });
});

describe('situacaoPlano', () => {
  it('sem decisão ou destino sem execução → null', () => {
    expect(situacaoPlano(undefined, HOJE)).toBeNull();
    expect(situacaoPlano(decisao(1), HOJE)).toBeNull();
    expect(situacaoPlano(decisao(1, { destino: 'estrategico', ...decidido }), HOJE)).toBeNull();
    expect(situacaoPlano(decisao(1, { destino: 'manter_suspender_recompra', ...decidido }), HOJE)).toBeNull();
  });
  it('vencido conta os dias e vence "sem responsável"', () => {
    expect(situacaoPlano(decisao(1, { destino: 'liquidar', prazo: '2026-11-07', ...decidido }), HOJE)).toEqual({ tipo: 'vencido', dias: 3 });
  });
  it('vence no dia seguinte ao prazo, não no próprio dia', () => {
    expect(situacaoPlano(decisao(1, { destino: 'trocar', responsavel: 'u', prazo: HOJE, ...decidido }), HOJE)).toEqual({ tipo: 'no_prazo', dias: 0 });
  });
  it('sem responsável / sem prazo / no prazo', () => {
    expect(situacaoPlano(decisao(1, { destino: 'trocar', prazo: '2026-11-20', ...decidido }), HOJE)).toEqual({ tipo: 'sem_responsavel' });
    expect(situacaoPlano(decisao(1, { destino: 'trocar', responsavel: 'u', ...decidido }), HOJE)).toEqual({ tipo: 'sem_prazo' });
    expect(situacaoPlano(decisao(1, { destino: 'venda_dirigida', responsavel: 'u', prazo: '2026-11-20', ...decidido }), HOJE)).toEqual({ tipo: 'no_prazo', dias: 10 });
  });
  it('concluído vence tudo; concluído antes de re-decidir volta a valer o prazo', () => {
    expect(situacaoPlano(decisao(1, { destino: 'liquidar', prazo: '2026-11-01', concluido_em: '2026-11-02T00:00:00Z', ...decidido }), HOJE)).toEqual({ tipo: 'concluido' });
    expect(situacaoPlano(decisao(1, { destino: 'liquidar', prazo: '2026-11-01', concluido_em: '2026-10-30T00:00:00Z', ...decidido }), HOJE)).toEqual({ tipo: 'vencido', dias: 9 });
  });
});

describe('resumoExecucao', () => {
  it('conta só destinos executáveis; vencida e sem responsável podem sobrepor; concluída sai das duas', () => {
    const r = resumoExecucao([
      decisao(1, { destino: 'liquidar', prazo: '2026-11-01', ...decidido }), // vencida + sem responsável
      decisao(2, { destino: 'trocar', responsavel: 'u', prazo: '2026-11-20', ...decidido }), // no prazo
      decisao(3, { destino: 'venda_dirigida', prazo: '2026-11-01', concluido_em: '2026-11-05T00:00:00Z', ...decidido }), // concluída
      decisao(4, { destino: 'estrategico', ...decidido }), // fora
      decisao(5), // sem destino
    ], HOJE);
    expect(r).toEqual({ executaveis: 3, concluidas: 1, vencidas: 1, semResponsavel: 1 });
  });
});

describe('pisoVigente', () => {
  it('só com destino liquidar (re-decidir não apaga o piso no banco)', () => {
    expect(pisoVigente(decisao(1, { destino: 'liquidar', preco_piso: 10 }))).toBe(10);
    expect(pisoVigente(decisao(1, { destino: 'venda_dirigida', preco_piso: 10 }))).toBeNull();
    expect(pisoVigente(undefined)).toBeNull();
  });
});

describe('alertaPiso', () => {
  const liq = decisao(7, { destino: 'liquidar', preco_piso: 10 });
  const linha = { sku_codigo_omie: 7, destino: 'liquidar' as const, qtd_vendida: 4, receita: 32 };
  it('preço do período abaixo do piso', () => {
    expect(alertaPiso(linha, liq, ['UN'])).toEqual({ sku_codigo_omie: 7, preco: 8, piso: 10, abaixo: true });
  });
  it('no piso ou acima: abaixo = false', () => {
    expect(alertaPiso({ ...linha, receita: 40 }, liq, ['UN'])?.abaixo).toBe(false);
  });
  it('sem comparação honesta → null', () => {
    expect(alertaPiso(linha, liq, ['UN', 'CX'])).toBeNull(); // duas unidades de venda
    expect(alertaPiso(linha, liq, null)).toBeNull(); // SKU fora dos fatos
    expect(alertaPiso(linha, liq, [])).toBeNull();
    expect(alertaPiso({ ...linha, qtd_vendida: 0 }, liq, ['UN'])).toBeNull();
    expect(alertaPiso({ ...linha, qtd_vendida: null }, liq, ['UN'])).toBeNull(); // Colacor / sem foto
    expect(alertaPiso({ ...linha, receita: null }, liq, ['UN'])).toBeNull();
    expect(alertaPiso({ ...linha, receita: 0 }, liq, ['UN'])).toBeNull(); // NF sem valor_total vira 0 na medição
    expect(alertaPiso(linha, decisao(7, { destino: 'liquidar' }), ['UN'])).toBeNull(); // sem piso
    expect(alertaPiso({ ...linha, destino: 'trocar' }, liq, ['UN'])).toBeNull();
  });
  it('unidade repetida conta como uma só', () => {
    expect(alertaPiso(linha, liq, ['UN', 'UN'])?.abaixo).toBe(true);
  });
});
