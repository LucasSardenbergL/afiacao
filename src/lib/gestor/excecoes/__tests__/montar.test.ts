import { describe, it, expect } from 'vitest';
import { idadeHoras, frescorCarteira, frescorTexto, detectarDadosQuebrados, detectarClientesRisco, detectarConfirmacoesPendentes, montarExcecoes } from '../montar';
import { EXCECOES_CFG_DEFAULT } from '../types';
import type { SaudeCheckInput, DecisaoRiscoInput, TarefaGapInput, ExcecoesInput } from '../types';

const gap = (over: Partial<TarefaGapInput>): TarefaGapInput => ({
  tarefaId: 't1', descricao: 'Ligar p/ oferecer linha nova', clienteUserId: 'c1',
  donoNome: 'Regina', effectiveDue: '2026-06-02', candidatoId: 'cand1', ...over,
});

const saude = (over: Partial<SaudeCheckInput>): SaudeCheckInput => ({
  source: 'vendas_pedidos', domain: 'vendas', status: 'broken', severity: 'critical',
  message: 'Sync de vendas parado', ageSeconds: 3600, ...over,
});

const cfg = EXCECOES_CFG_DEFAULT;
const AGORA = '2026-06-04T12:00:00.000Z';

describe('idadeHoras', () => {
  it('calcula horas inteiras entre dois ISO', () => {
    expect(idadeHoras('2026-06-04T06:00:00.000Z', AGORA)).toBe(6);
    expect(idadeHoras(null, AGORA)).toBeNull();
    expect(idadeHoras('lixo', AGORA)).toBeNull();
  });
});

describe('frescorCarteira', () => {
  it('classifica por idade do max(created_at)', () => {
    expect(frescorCarteira('2026-06-04T00:00:00.000Z', AGORA, cfg)).toBe('fresh'); // 12h
    expect(frescorCarteira('2026-06-03T06:00:00.000Z', AGORA, cfg)).toBe('stale'); // 30h
    expect(frescorCarteira('2026-06-01T12:00:00.000Z', AGORA, cfg)).toBe('desatualizada'); // 72h
    expect(frescorCarteira(null, AGORA, cfg)).toBe('desatualizada'); // sem dado = desatualizada
  });
});

describe('frescorTexto', () => {
  it('horas até 48h, dias acima', () => {
    expect(frescorTexto(6)).toBe('há 6h');
    expect(frescorTexto(30)).toBe('há 30h');
    expect(frescorTexto(72)).toBe('há 3d');
    expect(frescorTexto(null)).toBeNull();
  });
});

const dec = (over: Partial<DecisaoRiscoInput>): DecisaoRiscoInput => ({
  id: 'd1', clienteUserId: 'c1', clienteNome: 'Cliente 1', donoNome: 'Regina',
  primaryReason: 'Esfriou', confidence: 'alta', atrasoRelativo: 2.5,
  faturamento90d: 1000, faturamentoPrev90d: 1000, ...over,
});

describe('detectarClientesRisco', () => {
  it('FRESH: filtra pelo predicado de risco + confidence!=baixa, cap 5', () => {
    const decs = [
      dec({ id: 'd1', clienteUserId: 'c1', atrasoRelativo: 2.5 }),        // dispara (atraso)
      dec({ id: 'd2', clienteUserId: 'c2', atrasoRelativo: 1.0, faturamento90d: 100, faturamentoPrev90d: 1000 }), // dispara (queda >50%)
      dec({ id: 'd3', clienteUserId: 'c3', atrasoRelativo: 1.0, faturamento90d: 900, faturamentoPrev90d: 1000 }), // NÃO (sem risco)
      dec({ id: 'd4', clienteUserId: 'c4', atrasoRelativo: 5, confidence: 'baixa' }),  // NÃO (confidence baixa)
    ];
    const r = detectarClientesRisco(decs, '2026-06-04T11:00:00.000Z', '2026-06-04T12:00:00.000Z', EXCECOES_CFG_DEFAULT);
    expect(r.map(l => l.id).sort()).toEqual(['risco:c1', 'risco:c2']);
    expect(r[0].donoNome).toBe('Regina');
    expect(r[0].grupo).toBe('clientes_risco');
  });

  it('STALE (24-48h): mesmas linhas, com selo de frescor', () => {
    const r = detectarClientesRisco([dec({})], '2026-06-03T06:00:00.000Z', '2026-06-04T12:00:00.000Z', EXCECOES_CFG_DEFAULT);
    expect(r).toHaveLength(1);
    expect(r[0].reciboFrescor).toBe('há 30h');
  });

  it('DESATUALIZADA (>48h): UMA meta-exceção, sem linhas de cliente', () => {
    const r = detectarClientesRisco([dec({})], '2026-06-01T00:00:00.000Z', '2026-06-04T12:00:00.000Z', EXCECOES_CFG_DEFAULT);
    expect(r).toHaveLength(1);
    expect(r[0].id).toBe('risco:meta_desatualizada');
    expect(r[0].acao).toEqual({ tipo: 'rodar_agente' });
    expect(r[0].titulo.toLowerCase()).toContain('desatualizada');
  });

  it('sem decisões → vazio (não fabrica)', () => {
    expect(detectarClientesRisco([], '2026-06-04T11:00:00.000Z', '2026-06-04T12:00:00.000Z', EXCECOES_CFG_DEFAULT)).toHaveLength(0);
  });
});

describe('detectarConfirmacoesPendentes', () => {
  it('só vencidas em dia anterior a hoje (>=1 dia); mais antiga primeiro; cap 3', () => {
    const hoje = '2026-06-04';
    const r = detectarConfirmacoesPendentes([
      gap({ tarefaId: 't1', effectiveDue: '2026-06-01' }),
      gap({ tarefaId: 't2', effectiveDue: '2026-06-03' }),
      gap({ tarefaId: 't3', effectiveDue: '2026-06-04' }), // vence HOJE → excluída (não é >=1 dia)
      gap({ tarefaId: 't4', effectiveDue: '2026-05-30' }),
      gap({ tarefaId: 't5', effectiveDue: '2026-05-31' }),
    ], hoje, EXCECOES_CFG_DEFAULT);
    expect(r.map(l => l.id)).toEqual(['conf:t4', 'conf:t5', 'conf:t1']); // 3 mais antigas, ordenadas
    expect(r[0].grupo).toBe('confirmacoes_pendentes');
    expect(r[0].acao).toEqual({ tipo: 'tarefa', tarefaId: 't4', clienteUserId: 'c1', candidatoId: 'cand1' });
    expect(r[0].titulo.toLowerCase()).not.toContain('engan'); // copy NUNCA acusatória
  });

  it('vazio quando nada vencido há >=1 dia', () => {
    expect(detectarConfirmacoesPendentes([gap({ effectiveDue: '2026-06-04' })], '2026-06-04', EXCECOES_CFG_DEFAULT)).toHaveLength(0);
  });
});

describe('detectarDadosQuebrados', () => {
  it('inclui todos os critical e capWarnSaude warnings; ignora ok', () => {
    const linhas = detectarDadosQuebrados([
      saude({ source: 'a', severity: 'critical', status: 'broken' }),
      saude({ source: 'b', severity: 'critical', status: 'broken' }),
      saude({ source: 'w1', severity: 'warning', status: 'stale' }),
      saude({ source: 'w2', severity: 'warning', status: 'stale' }),
      saude({ source: 'w3', severity: 'warning', status: 'stale' }),
      saude({ source: 'w4', severity: 'warning', status: 'stale' }),
      saude({ source: 'ok1', severity: 'info', status: 'ok' }),
    ], EXCECOES_CFG_DEFAULT);
    const crit = linhas.filter(l => l.severidade === 'critico');
    const warn = linhas.filter(l => l.severidade === 'aviso');
    expect(crit).toHaveLength(2);     // todos os critical
    expect(warn).toHaveLength(3);     // cap de 3 warnings
    expect(linhas.every(l => l.grupo === 'dados_quebrados')).toBe(true);
    expect(linhas[0].reciboFonte).toBe('data_health');
  });

  it('lista vazia quando tudo ok', () => {
    expect(detectarDadosQuebrados([saude({ status: 'ok', severity: 'info' })], EXCECOES_CFG_DEFAULT)).toHaveLength(0);
  });
});

const baseInput = (over: Partial<ExcecoesInput>): ExcecoesInput => ({
  decisoes: [], decisoesMaxCreatedAtIso: '2026-06-04T11:00:00.000Z',
  saude: [], tarefas: [], hojeSp: '2026-06-04', agoraIso: '2026-06-04T12:00:00.000Z', ...over,
});

describe('montarExcecoes (composer)', () => {
  it('grupos só não-vazios, em ordem de dependência', () => {
    const c = montarExcecoes(baseInput({
      decisoes: [dec({ clienteUserId: 'c1' })],
      saude: [saude({ source: 'a', severity: 'critical', status: 'broken' })],
      tarefas: [gap({ tarefaId: 't1', clienteUserId: 'c9', effectiveDue: '2026-06-01' })],
    }));
    expect(c.grupos.map(g => g.key)).toEqual(['dados_quebrados', 'clientes_risco', 'confirmacoes_pendentes']);
    expect(c.vazio).toBe(false);
  });

  it('merge visual: cliente em risco E em tarefa → badge, sem duplicar na seção de tarefas', () => {
    const c = montarExcecoes(baseInput({
      decisoes: [dec({ clienteUserId: 'c1', donoNome: 'Regina' })],
      tarefas: [gap({ tarefaId: 't1', clienteUserId: 'c1', effectiveDue: '2026-06-01' })],
    }));
    const risco = c.grupos.find(g => g.key === 'clientes_risco')!.linhas;
    const conf = c.grupos.find(g => g.key === 'confirmacoes_pendentes');
    expect(risco[0].badges).toContain('também há tarefa pendente');
    expect(conf).toBeUndefined(); // a única tarefa era do mesmo cliente → seção some
  });

  it('teto total: críticos de dados sempre entram; excedente vira contagem', () => {
    const c = montarExcecoes(baseInput({
      saude: Array.from({ length: 6 }, (_, i) => saude({ source: `crit${i}`, severity: 'critical', status: 'broken' })),
      decisoes: Array.from({ length: 5 }, (_, i) => dec({ id: `d${i}`, clienteUserId: `c${i}` })),
      tarefas: Array.from({ length: 3 }, (_, i) => gap({ tarefaId: `t${i}`, clienteUserId: `z${i}`, effectiveDue: '2026-06-01' })),
    }), { ...EXCECOES_CFG_DEFAULT, totalMax: 10 });
    const total = c.grupos.reduce((n, g) => n + g.linhas.length, 0);
    expect(total).toBeLessThanOrEqual(10);
    expect(c.grupos.find(g => g.key === 'dados_quebrados')!.linhas).toHaveLength(6); // críticos nunca cortados
    expect(c.excedente).toBeGreaterThan(0);
  });

  it('tudo limpo → vazio=true, sem grupos', () => {
    const c = montarExcecoes(baseInput({}));
    expect(c.vazio).toBe(true);
    expect(c.grupos).toHaveLength(0);
  });
});
