import { describe, it, expect } from 'vitest';
import { idadeHoras, frescorCarteira, frescorTexto, detectarDadosQuebrados } from '../montar';
import { EXCECOES_CFG_DEFAULT } from '../types';
import type { SaudeCheckInput } from '../types';

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
