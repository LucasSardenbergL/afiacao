import { describe, it, expect } from 'vitest';
import { loteVigente, ehInedito, saiuDoDump, rotuloSaiuDoDump, recorteDeLote, lotePublicando, rotuloEfetivo, fotoPostgrest, type LoteIngest } from '../lote-vigente';

/**
 * Lote VIGENTE = a foto mais recente que TERMINOU (max(mes_referencia) com status='complete').
 * É o mesmo conceito da RPC `radar_kpis`; aqui vive uma vez só, para lista, KPIs, linha e ficha
 * lerem o MESMO lote em vez de cada componente recomputar.
 *
 * Medido em prod (psql-ro, 2026-10-19): 52.011 leads ativos com ultimo_lote=2026-05 (saíram do
 * dump da RFB) seguiam na fila porque a lista não olhava o lote — 1 em cada 10 era foto velha.
 */
const lote = (over: Partial<LoteIngest> & Pick<LoteIngest, 'mes_referencia' | 'status'>): LoteIngest => ({
  total_recebido: 0, novos: null, iniciado_em: '2026-10-19T16:31:08.593+00:00', ...over,
});

describe('loteVigente', () => {
  it('é o MAIOR mes_referencia com status complete', () => {
    const v = loteVigente([
      lote({ mes_referencia: '2026-05', status: 'complete' }),
      lote({ mes_referencia: '2026-08', status: 'complete' }),
    ]);
    expect(v?.mes_referencia).toBe('2026-08');
  });

  it('ignora running e error no meio — mesmo sendo mais recentes', () => {
    const v = loteVigente([
      lote({ mes_referencia: '2026-08', status: 'complete' }),
      lote({ mes_referencia: '2026-09', status: 'error' }),
      lote({ mes_referencia: '2026-10', status: 'running' }),
    ]);
    expect(v?.mes_referencia).toBe('2026-08');
  });

  it('não depende da ORDEM da lista', () => {
    const v = loteVigente([
      lote({ mes_referencia: '2026-08', status: 'complete' }),
      lote({ mes_referencia: '2026-05', status: 'complete' }),
    ]);
    expect(v?.mes_referencia).toBe('2026-08');
  });

  it('sem lote complete → null (ausente ≠ zero: o card diz "sem dado", a fila não filtra)', () => {
    expect(loteVigente([])).toBeNull();
    expect(loteVigente([lote({ mes_referencia: '2026-10', status: 'running' })])).toBeNull();
  });
});

describe('ehInedito', () => {
  const vigente = lote({ mes_referencia: '2026-08', status: 'complete', iniciado_em: '2026-10-19T16:31:08.593+00:00' });

  it('inédito = primeira_vista_em >= iniciado_em do lote vigente E ultimo_lote = vigente', () => {
    expect(ehInedito({ primeira_vista_em: '2026-10-19T16:35:00+00:00', ultimo_lote: '2026-08' }, vigente)).toBe(true);
  });

  it('visto ANTES do início do lote não é inédito, mesmo com ultimo_lote vigente', () => {
    expect(ehInedito({ primeira_vista_em: '2026-06-12T01:10:00+00:00', ultimo_lote: '2026-08' }, vigente)).toBe(false);
  });

  it('visto no lote mas com ultimo_lote de outro mês não é inédito', () => {
    expect(ehInedito({ primeira_vista_em: '2026-10-19T16:35:00+00:00', ultimo_lote: '2026-05' }, vigente)).toBe(false);
  });

  it('sem lote vigente ou sem primeira_vista_em → false (não fabrica selo)', () => {
    expect(ehInedito({ primeira_vista_em: '2026-10-19T16:35:00+00:00', ultimo_lote: '2026-08' }, null)).toBe(false);
    expect(ehInedito({ primeira_vista_em: null, ultimo_lote: '2026-08' }, vigente)).toBe(false);
  });
});

describe('saiuDoDump + rótulo', () => {
  const vigente = lote({ mes_referencia: '2026-08', status: 'complete' });

  it('ultimo_lote anterior ao vigente = saiu do dump', () => {
    expect(saiuDoDump({ ultimo_lote: '2026-05' }, vigente)).toBe(true);
  });

  it('ultimo_lote = vigente não saiu', () => {
    expect(saiuDoDump({ ultimo_lote: '2026-08' }, vigente)).toBe(false);
  });

  it('sem lote vigente ou sem ultimo_lote → false (sem selo fabricado)', () => {
    expect(saiuDoDump({ ultimo_lote: '2026-05' }, null)).toBe(false);
    expect(saiuDoDump({ ultimo_lote: null }, vigente)).toBe(false);
  });

  it('rótulo diz O MÊS em que foi visto pela última vez — sem motivo (baixa é outra entrega)', () => {
    expect(rotuloSaiuDoDump('2026-05')).toBe('última presença: mai/2026 · ausente no lote atual');
    expect(rotuloSaiuDoDump('2026-12')).toBe('última presença: dez/2026 · ausente no lote atual');
  });

  it('rótulo não inventa mês para lote fora do formato', () => {
    expect(rotuloSaiuDoDump('lixo')).toBe('última presença: lixo · ausente no lote atual');
  });
});

describe('recorteDeLote — o predicado único de fila e ranking/mapa', () => {
  const vigente = lote({ mes_referencia: '2026-08', status: 'complete', iniciado_em: '2026-10-19T16:31:08.593+00:00' });
  const modo = (incluirSaiuDoDump: boolean, soIneditos: boolean) => ({ incluirSaiuDoDump, soIneditos });

  it('default: foto vigente, sem recorte de inéditos', () => {
    expect(recorteDeLote(vigente, modo(false, false))).toEqual({ ultimoLote: '2026-08', primeiraVistaMin: null });
  });

  it('incluir quem saiu do dump: nada é recortado', () => {
    expect(recorteDeLote(vigente, modo(true, false))).toEqual({ ultimoLote: null, primeiraVistaMin: null });
  });

  it('só inéditos vence o toggle: lote vigente + primeira vista >= início do lote', () => {
    const esperado = { ultimoLote: '2026-08', primeiraVistaMin: '2026-10-19T16:31:08.593+00:00' };
    expect(recorteDeLote(vigente, modo(true, true))).toEqual(esperado);
    expect(recorteDeLote(vigente, modo(false, true))).toEqual(esperado);
  });

  it('sem lote complete: nada é recortado, em nenhum modo (sem foto não há filtro)', () => {
    for (const m of [modo(false, false), modo(true, false), modo(false, true)]) {
      expect(recorteDeLote(null, m)).toEqual({ ultimoLote: null, primeiraVistaMin: null });
    }
  });
});

/**
 * Publicação EM PASSOS (migration 20261111120000; incidente de 2026-11-08: a troca numa transação estourou
 * 30 min e travou o Realtime). Durante a publicação de P sobre o vigente V, quem já ganhou o rótulo P vindo
 * de V ainda é da foto V (lote_anterior); a empresa nova (anterior null) ainda não é de foto nenhuma.
 * Mesmo predicado de `public.radar_lote_publicando()` e de `radar_lista`.
 */
describe('publicação em passos — rótulo efetivo', () => {
  const V = lote({ mes_referencia: '2026-10', status: 'complete', iniciado_em: '2026-10-27T16:20:00Z' });
  const durante = { ...V, publicando: '2026-11' };

  it('lotePublicando: validada + publicação começada + mais novo que o vigente', () => {
    const p = (o: object) => ({ ...lote({ mes_referencia: '2026-11', status: 'running' }), ...o });
    expect(lotePublicando([V, p({ carga_fase: 'validada', carga_publicacao_iniciada_em: '2026-11-09T07:00Z' })], V)).toBe('2026-11');
    expect(lotePublicando([V, p({ carga_fase: 'validada', carga_publicacao_iniciada_em: null })], V), 'validada sem começar').toBeNull();
    expect(lotePublicando([V, p({ carga_fase: 'publicada', carga_publicacao_iniciada_em: '2026-11-09T07:00Z' })], V)).toBeNull();
    // Re-run do mês vigente nunca troca rótulo: não há P.
    const rerun = { ...V, carga_fase: 'validada', carga_publicacao_iniciada_em: '2026-11-09T07:00Z' };
    expect(lotePublicando([rerun], V)).toBeNull();
  });

  it('rotuloEfetivo: rótulo novo vindo do vigente = vigente; nova = null; fora da publicação = físico', () => {
    expect(rotuloEfetivo({ ultimo_lote: '2026-11', lote_anterior: '2026-10' }, durante)).toBe('2026-10');
    expect(rotuloEfetivo({ ultimo_lote: '2026-11', lote_anterior: null }, durante)).toBeNull();
    expect(rotuloEfetivo({ ultimo_lote: '2026-11', lote_anterior: '2026-05' }, durante), 'volta ao dump').toBe('2026-05');
    expect(rotuloEfetivo({ ultimo_lote: '2026-10', lote_anterior: '2026-09' }, durante)).toBe('2026-10');
    expect(rotuloEfetivo({ ultimo_lote: '2026-11', lote_anterior: '2026-10' }, V), 'sem publicação').toBe('2026-11');
  });

  it('selos durante a publicação: já trocada segue inédita/na foto; a que volta segue "saiu do dump"', () => {
    const trocada = { ultimo_lote: '2026-11', lote_anterior: '2026-10', primeira_vista_em: '2026-10-27T17:00:00Z' };
    expect(ehInedito(trocada, durante)).toBe(true);
    expect(saiuDoDump(trocada, durante)).toBe(false);
    const volta = { ultimo_lote: '2026-11', lote_anterior: '2026-05' };
    expect(saiuDoDump(volta, durante)).toBe(true);
    expect(saiuDoDump({ ultimo_lote: '2026-11', lote_anterior: null }, durante), 'nova: não é de foto nenhuma').toBe(false);
  });

  it('fotoPostgrest: só o vigente fora da publicação; IN (V,P) + OU anterior = V durante', () => {
    expect(fotoPostgrest(V)).toEqual({ rotulos: ['2026-10'], ou: null });
    expect(fotoPostgrest(durante)).toEqual({ rotulos: ['2026-10', '2026-11'], ou: 'ultimo_lote.eq.2026-10,lote_anterior.eq.2026-10' });
  });
});
