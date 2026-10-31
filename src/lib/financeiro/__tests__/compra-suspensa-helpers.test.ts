import { describe, expect, it } from 'vitest';
import {
  emRiscoDeFalta, normalizarCandidato, normalizarRun, normalizarSuspensa, ordenarPorRisco, resumirCandidatos, resumirSuspensas,
  somaHonesta, somarDias, type RunMotor, type SuspensaAtiva,
} from '@/lib/financeiro/compra-suspensa-helpers';

const linha = (o: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'a1', sku_codigo_omie: 9003, descricao: 'B PARCIAL', fornecedor_nome: 'Sayerlack', motivo: 'cobertura', origem: 'ciclo_ui',
  lote_id: null, suspenso_em: '2026-11-01T10:00:00Z', revisar_em: '2027-01-30', suspenso_por: 'u1', suspenso_por_texto: null,
  foto_valor: 20, foto_cobertura_dias: 300, foto_cobertura_90d_dias: 250, foto_no_motor: true, foto_valor_vendido_90d: 500,
  saldo_atual: 2, valor_atual: 22, cobertura_90d_atual: 40, cobertura_365d_atual: 290, no_motor_atual: true,
  evitado_ultimo_run: 180, qtde_ultimo_run: 18, ...o,
});
const run = (o: Partial<RunMotor> = {}): RunMotor => ({
  runId: 'r1', criadoEm: '2026-11-02T10:00:00Z', dataCiclo: '2026-11-02', seguradasN: 2, skusIncluidos: 5, valorEvitado: 180, linhasSemPreco: 1, ...o,
});

describe('compra-suspensa-helpers', () => {
  it('normaliza a ativa e descarta linha sem chave/motivo (nunca default fabricado)', () => {
    const a = normalizarSuspensa(linha()) as SuspensaAtiva;
    expect(a.sku).toBe(9003);
    expect(a.cobertura90Atual).toBe(40);
    expect(a.evitadoUltimoRun).toBe(180);
    expect(normalizarSuspensa(linha({ motivo: '' }))).toBeNull();
    expect(normalizarSuspensa(linha({ sku_codigo_omie: null }))).toBeNull();
    expect(normalizarSuspensa(linha({ revisar_em: null }))).toBeNull();
    // origem desconhecida cai no default do app (ciclo_ui), nunca derruba a linha
    expect((normalizarSuspensa(linha({ origem: 'x' })) as SuspensaAtiva).origem).toBe('ciclo_ui');
  });

  it('normaliza run e candidato; valor ausente fica null', () => {
    const r = normalizarRun({ run_id: 'r', criado_em: 't', data_ciclo: 'd', suspensas_compra_n: 0, skus_incluidos: 3, valor_evitado: null, linhas_sem_preco: 0 });
    expect(r?.valorEvitado).toBeNull();
    expect(normalizarRun({ run_id: 'r' })).toBeNull();
    const c = normalizarCandidato({ sku_codigo_omie: 1, saldo: 10, valor: null, no_motor: true, corante: false, dias_365: 400, dias_90: null });
    expect(c?.valor).toBeNull();
    expect(c?.dias90).toBeNull();
    expect(normalizarCandidato({ sku_codigo_omie: 1, saldo: 10 })).toBeNull();
  });

  it('somaHonesta: nenhum termo conhecido → null, nunca 0', () => {
    expect(somaHonesta([null, null])).toEqual({ total: null, desconhecidos: 2 });
    expect(somaHonesta([10, null, 5])).toEqual({ total: 15, desconhecidos: 1 });
    expect(somaHonesta([])).toEqual({ total: null, desconhecidos: 0 });
  });

  it('resumo: foto × atual separados, último run pela data, Σ rotulado parcial com NULL, revisão vencida', () => {
    const a1 = normalizarSuspensa(linha()) as SuspensaAtiva;
    const a2 = normalizarSuspensa(linha({ id: 'a2', sku_codigo_omie: 9004, foto_valor: null, valor_atual: null, no_motor_atual: false, revisar_em: '2026-10-01', evitado_ultimo_run: null, qtde_ultimo_run: 7 })) as SuspensaAtiva;
    const r = resumirSuspensas([a1, a2], [run({ runId: 'velho', criadoEm: '2026-11-01T10:00:00Z', seguradasN: 0, valorEvitado: null, linhasSemPreco: 0 }), run()], '2026-11-02');
    expect(r.ativasN).toBe(2);
    expect(r.noMotorN).toBe(1);
    expect(r.fotoValor).toBe(20);
    expect(r.fotoSemCusto).toBe(1);
    expect(r.valorAtual).toBe(22);
    expect(r.ultimoRun).toEqual({ em: '2026-11-02T10:00:00Z', seguradasN: 2, evitado: 180, semPreco: 1 });
    expect(r.runsN).toBe(2);
    expect(r.runsComSupressaoN).toBe(1);
    expect(r.evitadoRunsSoma).toBe(180);
    expect(r.revisaoVencidaN).toBe(1);
  });

  it('resumo sem run e sem ativa: tudo null/0 honesto', () => {
    const r = resumirSuspensas([], [], '2026-11-02');
    expect(r.ultimoRun).toBeNull();
    expect(r.fotoValor).toBeNull();
    expect(r.evitadoRunsSoma).toBeNull();
    expect(r.ativasN).toBe(0);
  });

  it('ordem de revisão: venda 90d desc, depois R$ atual; risco de falta < 60d pela venda recente', () => {
    const a = normalizarSuspensa(linha({ id: 'a', sku_codigo_omie: 1, foto_valor_vendido_90d: 10, valor_atual: 1 })) as SuspensaAtiva;
    const b = normalizarSuspensa(linha({ id: 'b', sku_codigo_omie: 2, foto_valor_vendido_90d: null, valor_atual: 999 })) as SuspensaAtiva;
    const c = normalizarSuspensa(linha({ id: 'c', sku_codigo_omie: 3, foto_valor_vendido_90d: 10, valor_atual: 50, cobertura_90d_atual: null })) as SuspensaAtiva;
    expect(ordenarPorRisco([b, a, c]).map((x) => x.sku)).toEqual([3, 1, 2]);
    expect(emRiscoDeFalta(a)).toBe(true);
    expect(emRiscoDeFalta(c)).toBe(false); // cobertura desconhecida não vira risco (ausente ≠ zero)
  });

  it('somarDias trabalha na data civil (sem fuso) e resumirCandidatos separa sem custo', () => {
    expect(somarDias('2026-10-31', 90)).toBe('2027-01-29');
    expect(somarDias('2026-02-27', 2)).toBe('2026-03-01');
    const rc = resumirCandidatos([
      { sku: 1, descricao: null, fornecedor: null, saldo: 1, valor: 10, dias365: 200, dias90: null, noMotor: true, venda90: 5, corante: false },
      { sku: 2, descricao: null, fornecedor: null, saldo: 1, valor: null, dias365: 200, dias90: 300, noMotor: false, venda90: null, corante: false },
    ]);
    expect(rc).toEqual({ n: 2, valor: 10, semCusto: 1, noMotorN: 1, comVenda90N: 1 });
  });
});
