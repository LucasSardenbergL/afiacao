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

  it('domain/status/severity fora do vocabulário LANÇAM (nunca check inventado)', () => {
    expect(() => paraDataHealthCheck({ ...linha, domain: 'rh' })).toThrow(/domain "rh" fora do vocabulário/);
    expect(() => paraDataHealthCheck({ ...linha, status: 'meh' })).toThrow(/status "meh" fora/);
    expect(() => paraDataHealthCheck({ ...linha, severity: 'fatal' })).toThrow(/severity "fatal" fora/);
  });
});
