import { describe, it, expect } from 'vitest';
import { detectRecorrenteSumiu, detectSemResposta, detectTarefaSemProva, detectAltoValorForaRota, montarEvidencePack } from '../montar';
import { CRITICA_CFG_DEFAULT, type CriticaInput } from '../types';

const base = (over: Partial<CriticaInput>): CriticaInput => ({
  clienteUserId: 'c1',
  clienteNome: 'Cliente 1',
  metrica: null,
  rota: null,
  tarefa: null,
  ...over,
});

describe('detectRecorrenteSumiu', () => {
  it('dispara quando atraso_relativo >= 2.0', () => {
    const r = detectRecorrenteSumiu(
      base({ metrica: { intervaloMedioDias: 15, diasDesdeUltimaCompra: 28, atrasoRelativo: 1.9, faturamento90d: 1000, faturamentoPrev90d: 1000, isColdStart: false } }),
      CRITICA_CFG_DEFAULT,
    );
    expect(r.contradicao).toBeNull(); // 1.9 < 2.0 → não dispara por atraso

    const r2 = detectRecorrenteSumiu(
      base({ metrica: { intervaloMedioDias: 15, diasDesdeUltimaCompra: 30, atrasoRelativo: 2.0, faturamento90d: 1000, faturamentoPrev90d: 1000, isColdStart: false } }),
      CRITICA_CFG_DEFAULT,
    );
    expect(r2.contradicao?.chave).toBe('recorrente_sumiu');
    expect(r2.contradicao?.confianca).toBe('alta');
    expect(r2.sinais).toHaveLength(1);
    expect(r2.sinais[0].fonte.tabela).toBe('customer_metrics_mv');
  });

  it('dispara quando faturamento cai >50%', () => {
    const r = detectRecorrenteSumiu(
      base({ metrica: { intervaloMedioDias: null, diasDesdeUltimaCompra: 10, atrasoRelativo: 1.0, faturamento90d: 400, faturamentoPrev90d: 1000, isColdStart: false } }),
      CRITICA_CFG_DEFAULT,
    );
    expect(r.contradicao?.chave).toBe('recorrente_sumiu');
  });

  it('NÃO fabrica nada para cold-start nem métrica ausente', () => {
    expect(detectRecorrenteSumiu(base({ metrica: null }), CRITICA_CFG_DEFAULT).contradicao).toBeNull();
    expect(
      detectRecorrenteSumiu(base({ metrica: { intervaloMedioDias: 15, diasDesdeUltimaCompra: 99, atrasoRelativo: 5, faturamento90d: 0, faturamentoPrev90d: 0, isColdStart: true } }), CRITICA_CFG_DEFAULT).contradicao,
    ).toBeNull();
  });
});

describe('detectSemResposta', () => {
  it('dispara quando semRespostaRecenteN >= 3', () => {
    const r = detectSemResposta(
      base({ rota: { naCallQueue: true, semRespostaRecenteN: 3, ultimoContatoRealHaDias: null } }),
      CRITICA_CFG_DEFAULT,
    );
    expect(r.contradicao?.chave).toBe('sem_resposta_repetido');
    expect(r.contradicao?.confianca).toBe('alta');
    expect(r.sinais[0].fonte.tabela).toBe('route_contact_log');
  });

  it('NÃO dispara abaixo do limiar nem com rota ausente', () => {
    expect(detectSemResposta(base({ rota: { naCallQueue: true, semRespostaRecenteN: 2, ultimoContatoRealHaDias: null } }), CRITICA_CFG_DEFAULT).contradicao).toBeNull();
    expect(detectSemResposta(base({ rota: null }), CRITICA_CFG_DEFAULT).contradicao).toBeNull();
  });
});

describe('detectTarefaSemProva', () => {
  it('dispara quando há indício pendente; severidade sobe se atrasada', () => {
    const r = detectTarefaSemProva(
      base({ tarefa: { atrasada: true, temSugestaoPendente: true, descricao: 'Ligar p/ oferecer linha nova' } }),
      CRITICA_CFG_DEFAULT,
    );
    expect(r.contradicao?.chave).toBe('tarefa_feita_sem_prova');
    expect(r.contradicao?.confianca).toBe('media');
    expect(r.sinais[0].severidade).toBe('critico'); // atrasada
    expect(r.sinais[0].texto).toContain('Ligar p/ oferecer linha nova');
  });

  it('NÃO dispara sem indício pendente nem sem tarefa', () => {
    expect(detectTarefaSemProva(base({ tarefa: { atrasada: true, temSugestaoPendente: false, descricao: 'x' } }), CRITICA_CFG_DEFAULT).contradicao).toBeNull();
    expect(detectTarefaSemProva(base({ tarefa: null }), CRITICA_CFG_DEFAULT).contradicao).toBeNull();
  });
});

describe('detectAltoValorForaRota', () => {
  const mAlto = { intervaloMedioDias: null, diasDesdeUltimaCompra: 60, atrasoRelativo: null, faturamento90d: 8000, faturamentoPrev90d: null, isColdStart: false };

  it('dispara: alto valor + quieto >=45d + fora da callQueue', () => {
    const r = detectAltoValorForaRota(
      base({ metrica: mAlto, rota: { naCallQueue: false, semRespostaRecenteN: 0, ultimoContatoRealHaDias: null } }),
      CRITICA_CFG_DEFAULT,
    );
    expect(r.contradicao?.chave).toBe('alto_valor_fora_rota');
    expect(r.contradicao?.confianca).toBe('media');
  });

  it('NÃO dispara se está na callQueue, se quieto<45d, ou rota ausente', () => {
    expect(detectAltoValorForaRota(base({ metrica: mAlto, rota: { naCallQueue: true, semRespostaRecenteN: 0, ultimoContatoRealHaDias: null } }), CRITICA_CFG_DEFAULT).contradicao).toBeNull();
    expect(detectAltoValorForaRota(base({ metrica: { ...mAlto, diasDesdeUltimaCompra: 10 }, rota: { naCallQueue: false, semRespostaRecenteN: 0, ultimoContatoRealHaDias: null } }), CRITICA_CFG_DEFAULT).contradicao).toBeNull();
    expect(detectAltoValorForaRota(base({ metrica: mAlto, rota: null }), CRITICA_CFG_DEFAULT).contradicao).toBeNull();
  });

  it('NÃO dispara abaixo do limiar de faturamento', () => {
    expect(detectAltoValorForaRota(base({ metrica: { ...mAlto, faturamento90d: 100 }, rota: { naCallQueue: false, semRespostaRecenteN: 0, ultimoContatoRealHaDias: null } }), CRITICA_CFG_DEFAULT).contradicao).toBeNull();
  });
});

describe('montarEvidencePack (composer)', () => {
  it('agrega sinais e contradições de múltiplos detectores', () => {
    const pack = montarEvidencePack(base({
      metrica: { intervaloMedioDias: 15, diasDesdeUltimaCompra: 40, atrasoRelativo: 2.5, faturamento90d: 1000, faturamentoPrev90d: 1000, isColdStart: false },
      rota: { naCallQueue: true, semRespostaRecenteN: 4, ultimoContatoRealHaDias: 1 },
      tarefa: null,
    }));
    const chaves = pack.contradicoes.map(c => c.chave).sort();
    expect(chaves).toEqual(['recorrente_sumiu', 'sem_resposta_repetido']);
    expect(pack.sinais.length).toBeGreaterThanOrEqual(2);
  });

  it('suprime alto_valor_fora_rota quando recorrente_sumiu também dispara', () => {
    const pack = montarEvidencePack(base({
      metrica: { intervaloMedioDias: 30, diasDesdeUltimaCompra: 90, atrasoRelativo: 3.0, faturamento90d: 9000, faturamentoPrev90d: 9000, isColdStart: false },
      rota: { naCallQueue: false, semRespostaRecenteN: 0, ultimoContatoRealHaDias: null },
    }));
    const chaves = pack.contradicoes.map(c => c.chave);
    expect(chaves).toContain('recorrente_sumiu');
    expect(chaves).not.toContain('alto_valor_fora_rota');
  });

  it('degrada honesto: métrica ausente e rota indisponível viram faltaDado, sem fabricar', () => {
    const pack = montarEvidencePack(base({ metrica: null, rota: null, tarefa: null }));
    expect(pack.contradicoes).toHaveLength(0);
    expect(pack.faltaDado.length).toBeGreaterThanOrEqual(2);
  });

  it('cold-start não fabrica delta', () => {
    const pack = montarEvidencePack(base({
      metrica: { intervaloMedioDias: 10, diasDesdeUltimaCompra: 99, atrasoRelativo: 9, faturamento90d: 0, faturamentoPrev90d: 0, isColdStart: true },
      rota: { naCallQueue: true, semRespostaRecenteN: 0, ultimoContatoRealHaDias: 1 },
    }));
    expect(pack.contradicoes).toHaveLength(0);
    expect(pack.faltaDado.some(f => f.toLowerCase().includes('novo'))).toBe(true);
  });

  it('toda contradição retornada tem ≥1 evidência', () => {
    const pack = montarEvidencePack(base({
      metrica: { intervaloMedioDias: 15, diasDesdeUltimaCompra: 30, atrasoRelativo: 2.0, faturamento90d: 1000, faturamentoPrev90d: 1000, isColdStart: false },
      rota: { naCallQueue: true, semRespostaRecenteN: 0, ultimoContatoRealHaDias: 1 },
    }));
    for (const c of pack.contradicoes) expect(c.evidencias.length).toBeGreaterThan(0);
  });
});
