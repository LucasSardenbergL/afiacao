import { describe, expect, it } from 'vitest';
import { paraDataHealthCheck } from '../borda';

const linha = {
  source: 'fin_sync_heartbeat', domain: 'financeiro', status: 'ok', severity: 'info',
  age_seconds: 12, expected_max_age_seconds: 3600, freshness_basis: 'heartbeat', message: 'ok',
  last_error: null as unknown as string, probable_cause: null as unknown as string, how_to_fix: null as unknown as string,
};

describe('paraDataHealthCheck (borda da RPC get_data_health)', () => {
  it('linha no vocabulário passa; NULL dos campos "audiência full" vira null tipado', () => {
    expect(paraDataHealthCheck(linha)).toMatchObject({ domain: 'financeiro', status: 'ok', severity: 'info', last_error: null, how_to_fix: null });
  });

  it('domain analytics (sensores do outbox em prod) é vocabulário', () => {
    expect(paraDataHealthCheck({ ...linha, source: 'analytics_outbox_trigger', domain: 'analytics' }))
      .toMatchObject({ domain: 'analytics', status: 'ok' });
  });

  it('fora do vocabulário degrada SÓ a linha para unknown/critical — nunca verde, nunca lança', () => {
    const casos = [
      [{ domain: 'rh' }, 'domain "rh"'],
      [{ status: 'meh' }, 'status "meh"'],
      [{ severity: 'fatal' }, 'severity "fatal"'],
    ] as const;
    for (const [over, trecho] of casos) {
      const c = paraDataHealthCheck({ ...linha, ...over });
      expect(c).toMatchObject({
        source: 'fin_sync_heartbeat', domain: 'fora_do_vocabulario', status: 'unknown', severity: 'critical',
      });
      expect(c.message).toContain(trecho);
      expect(c.message).toContain('fora do vocabulário');
    }
  });
});
