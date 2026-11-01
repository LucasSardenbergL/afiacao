import { describe, expect, it } from 'vitest';
import { parseAvisoPrazo } from '../usePrazoAviso';

describe('parseAvisoPrazo — contrato fail-closed do jsonb da RPC venda_prazo_aviso', () => {
  it('disponivel:true com vencido numérico → objeto; vencido 0 é zero REAL', () => {
    const a = parseAvisoPrazo({ disponivel: true, vencido: 160, n_titulos: 3, dias_vencido_max: 70, vencimento_mais_antigo: '2026-08-22',
      atraso_medio_vencido_dias: 18.4, n_ambiguos: 1, n_invalidos: 2, sync_em: '2026-10-31T14:31:01Z', qualidade: 'ok' });
    expect(a).toMatchObject({ vencido: 160, nTitulos: 3, diasVencidoMax: 70, atrasoMedioVencidoDias: 18.4, nAmbiguos: 1, nInvalidos: 2, qualidade: 'ok' });
    expect(parseAvisoPrazo({ disponivel: true, vencido: 0, n_titulos: 0, n_ambiguos: 0, n_invalidos: 0 })).toMatchObject({ vencido: 0, nTitulos: 0, diasVencidoMax: null });
  });
  it('numeric chega como string do PostgREST → número', () => {
    expect(parseAvisoPrazo({ disponivel: true, vencido: '160.5', n_titulos: 2, dias_vencido_max: 3, n_ambiguos: 0, n_invalidos: 0 })?.vencido).toBe(160.5);
  });
  it('disponivel:false, payload fora do contrato ou vencido inválido → null (indisponível), nunca 0', () => {
    expect(parseAvisoPrazo({ disponivel: false, motivo: 'sem_codigo' })).toBeNull();
    expect(parseAvisoPrazo(null)).toBeNull();
    expect(parseAvisoPrazo([])).toBeNull();
    expect(parseAvisoPrazo({ disponivel: true })).toBeNull();
    expect(parseAvisoPrazo({ disponivel: true, vencido: 'NaN', n_titulos: 1 })).toBeNull();
    expect(parseAvisoPrazo({ disponivel: true, vencido: -5, n_titulos: 1 })).toBeNull();
  });
  it('contrato incoerente → null: contagem negativa/fracionária, dias texto, saldo > 0 sem título ou sem dias (achado Codex P2 #8)', () => {
    const base = { disponivel: true, vencido: 160, n_titulos: 3, dias_vencido_max: 70, n_ambiguos: 0, n_invalidos: 0 };
    expect(parseAvisoPrazo({ ...base, n_titulos: -1 })).toBeNull();
    expect(parseAvisoPrazo({ ...base, n_titulos: 1.5 })).toBeNull();
    expect(parseAvisoPrazo({ ...base, dias_vencido_max: 'quebrado' })).toBeNull();
    expect(parseAvisoPrazo({ ...base, n_ambiguos: 'NaN' })).toBeNull();
    expect(parseAvisoPrazo({ ...base, n_invalidos: null })).toBeNull();
    expect(parseAvisoPrazo({ ...base, n_titulos: 0 })).toBeNull();
    expect(parseAvisoPrazo({ ...base, dias_vencido_max: null })).toBeNull();
    expect(parseAvisoPrazo({ ...base, dias_vencido_max: -2 })).toBeNull();
  });
  it('qualidade desconhecida degrada para sem_sync (não para ok)', () => {
    expect(parseAvisoPrazo({ disponivel: true, vencido: 1, n_titulos: 1, dias_vencido_max: 1, n_ambiguos: 0, n_invalidos: 0, qualidade: 'otima' })?.qualidade).toBe('sem_sync');
  });
});
