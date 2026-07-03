import { describe, expect, it } from 'vitest';
import { resumirIceberg, type IniciativaIceberg } from '../useIniciativasIceberg';

const ini = (over: Partial<IniciativaIceberg>): IniciativaIceberg => ({
  id: crypto.randomUUID(),
  empresa: 'colacor',
  titulo: 'iniciativa',
  descricao: null,
  alavanca: 'outro',
  dono_id: null,
  ganho_esperado_mensal: null,
  ganho_recorrente_mensal: null,
  status: 'ideia',
  inicio_em: null,
  recorrente_desde: null,
  evidencia: null,
  created_by: null,
  created_at: '2026-07-01T00:00:00Z',
  updated_at: '2026-07-01T00:00:00Z',
  ...over,
});

describe('resumirIceberg', () => {
  it('soma recorrente comprovado só de recorrentes COM valor; sem valor conta à parte (ausente ≠ zero)', () => {
    const r = resumirIceberg([
      ini({ status: 'recorrente', ganho_recorrente_mensal: 5000, evidencia: 'relatório' }),
      ini({ status: 'recorrente', ganho_recorrente_mensal: 1500.5, evidencia: 'query' }),
      ini({ status: 'recorrente', ganho_recorrente_mensal: null, evidencia: 'case' }),
    ]);
    expect(r.recorrenteMensal).toBeCloseTo(6500.5);
    expect(r.recorrentesSemValor).toBe(1);
    expect(r.porStatus.recorrente).toBe(3);
  });

  it('pipeline soma esperado de ideia/em execução/maturando; sem estimativa conta à parte', () => {
    const r = resumirIceberg([
      ini({ status: 'ideia', ganho_esperado_mensal: 1000 }),
      ini({ status: 'em_execucao', ganho_esperado_mensal: 2000 }),
      ini({ status: 'maturando', ganho_esperado_mensal: 3000 }),
      ini({ status: 'maturando', ganho_esperado_mensal: null }),
    ]);
    expect(r.pipelineMensal).toBe(6000);
    expect(r.pipelineSemEstimativa).toBe(1);
  });

  it('pausada e cancelada não entram em nenhuma soma', () => {
    const r = resumirIceberg([
      ini({ status: 'pausada', ganho_esperado_mensal: 9999 }),
      ini({ status: 'cancelada', ganho_esperado_mensal: 9999, ganho_recorrente_mensal: 9999 }),
    ]);
    expect(r.pipelineMensal).toBe(0);
    expect(r.recorrenteMensal).toBe(0);
    expect(r.porStatus.pausada).toBe(1);
    expect(r.porStatus.cancelada).toBe(1);
  });

  it('recorrente não dobra no pipeline (o esperado dela fica fora da soma de pipeline)', () => {
    const r = resumirIceberg([
      ini({
        status: 'recorrente',
        ganho_esperado_mensal: 4000,
        ganho_recorrente_mensal: 3500,
        evidencia: 'dre',
      }),
    ]);
    expect(r.pipelineMensal).toBe(0);
    expect(r.recorrenteMensal).toBe(3500);
  });

  it('status fora do vocabulário não fabrica contagem nem soma, mas entra no total', () => {
    const r = resumirIceberg([
      ini({ status: 'zumbi', ganho_esperado_mensal: 1234 }),
      ini({ status: 'ideia', ganho_esperado_mensal: 100 }),
    ]);
    expect(r.pipelineMensal).toBe(100);
    expect(r.total).toBe(2);
    expect(Object.values(r.porStatus).reduce((a, b) => a + b, 0)).toBe(1);
  });

  it('portfólio NÃO-vazio com todos os valores null → null, não R$0 fabricado (achado Codex P1)', () => {
    const r = resumirIceberg([
      ini({ status: 'recorrente', ganho_recorrente_mensal: null, evidencia: 'case' }),
      ini({ status: 'recorrente', ganho_recorrente_mensal: null, evidencia: 'case' }),
      ini({ status: 'maturando', ganho_esperado_mensal: null }),
    ]);
    expect(r.recorrenteMensal).toBeNull();
    expect(r.pipelineMensal).toBeNull();
    expect(r.recorrentesSemValor).toBe(2);
    expect(r.pipelineSemEstimativa).toBe(1);
  });

  it('soma parcial continua numérica quando pelo menos 1 valor existe', () => {
    const r = resumirIceberg([
      ini({ status: 'recorrente', ganho_recorrente_mensal: 100, evidencia: 'dre' }),
      ini({ status: 'recorrente', ganho_recorrente_mensal: null, evidencia: 'case' }),
    ]);
    expect(r.recorrenteMensal).toBe(100);
    expect(r.recorrentesSemValor).toBe(1);
  });

  it('lista vazia → somas zero (zero legítimo de conjunto vazio) e contagens zeradas', () => {
    const r = resumirIceberg([]);
    expect(r.recorrenteMensal).toBe(0);
    expect(r.pipelineMensal).toBe(0);
    expect(r.recorrentesSemValor).toBe(0);
    expect(r.pipelineSemEstimativa).toBe(0);
    expect(r.total).toBe(0);
  });
});
