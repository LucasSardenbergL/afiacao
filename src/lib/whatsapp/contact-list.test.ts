import { describe, it, expect } from 'vitest';
import { prontidaoRecompra, valorDaLigacao, buildContactList } from './contact-list';
import type { ContactCandidate, ContactConfig, ScoredCandidate } from './contact-list';

function cand(over: Partial<ContactCandidate> = {}): ContactCandidate {
  return {
    customerUserId: 'c1', farmerId: 'f1', cityKey: { city: 'FORMIGA', uf: 'MG' },
    pConverte: 0.5, ticketEsperado: 1000, margemPerc: 0.2,
    diasDesdeUltima: 30, intervaloMedioDias: 30, isColdStart: false,
    optOut: false, contatadoHaDias: null, fechouHoje: false,
    janela24hAberta: false, margemNegativaConhecida: false, ...over,
  };
}

const CFG: ContactConfig = { winBackReservaPct: 0.2, coldStartPisoDia: 3, capacidadeLigacoes: 10, cadenciaMinDias: 3 };

describe('prontidaoRecompra', () => {
  it('no ciclo (ratio ~1) → alta', () => {
    expect(prontidaoRecompra(30, 30)).toBeGreaterThanOrEqual(0.9);
  });
  it('muito antes do ciclo (ratio 0.2) → baixa', () => {
    expect(prontidaoRecompra(6, 30)).toBeLessThanOrEqual(0.3);
  });
  it('atrasado (ratio 1.5) → saturado no topo (1.0)', () => {
    expect(prontidaoRecompra(45, 30)).toBe(1);
  });
  it('sem histórico (null) → neutro 0.5', () => {
    expect(prontidaoRecompra(null, null)).toBe(0.5);
    expect(prontidaoRecompra(10, null)).toBe(0.5);
  });
});

describe('valorDaLigacao', () => {
  it('multiplica P × ticket × margem × prontidão', () => {
    // 0.5 * 1000 * 0.2 * prontidao(30,30)=1.0 → 100
    expect(valorDaLigacao(cand())).toBeCloseTo(100, 5);
  });
  it('cliente fora do ciclo vale menos que no ciclo (mesmos demais)', () => {
    const noCiclo = valorDaLigacao(cand({ diasDesdeUltima: 30, intervaloMedioDias: 30 }));
    const cedo = valorDaLigacao(cand({ diasDesdeUltima: 6, intervaloMedioDias: 30 }));
    expect(cedo).toBeLessThan(noCiclo);
  });
});

describe('buildContactList — gates', () => {
  it('exclui opt-out, fechou hoje, valor<=0 e margem negativa', () => {
    const r = buildContactList([
      cand({ customerUserId: 'a', optOut: true }),
      cand({ customerUserId: 'b', fechouHoje: true }),
      cand({ customerUserId: 'c', pConverte: 0 }),         // valor 0
      cand({ customerUserId: 'd', margemNegativaConhecida: true }),
      cand({ customerUserId: 'e' }),                        // sobrevive
    ], CFG);
    const ids = (q: { customerUserId: string }[]) => q.map(x => x.customerUserId).sort();
    expect(ids(r.excluidos)).toEqual(['a', 'b', 'c', 'd']);
    expect(r.excluidos.find(x => x.customerUserId === 'a')!.motivoGate).toBe('opt_out');
    const uniao = [...r.callQueue, ...r.whatsappQueue]
      .filter((x, i, arr) => arr.findIndex(y => y.customerUserId === x.customerUserId) === i)
      .map(x => x.customerUserId);
    expect(uniao).toContain('e');
  });
  it('exclui por cadência (contatado há menos que o mínimo)', () => {
    const r = buildContactList([cand({ customerUserId: 'x', contatadoHaDias: 1 })], CFG);
    expect(r.excluidos.map(x => x.customerUserId)).toEqual(['x']);
    expect(r.excluidos[0].motivoGate).toBe('cadencia');
  });
  it('exclui JIT prematuro (muito antes do ciclo E baixa propensão)', () => {
    const r = buildContactList([cand({ customerUserId: 'j', diasDesdeUltima: 3, intervaloMedioDias: 30, pConverte: 0.2 })], CFG);
    expect(r.excluidos[0].motivoGate).toBe('jit_prematuro');
  });
});

describe('buildContactList — ordenação, reservas e buckets', () => {
  it('ordena callQueue por valor desc e respeita capacidade', () => {
    const cands = Array.from({ length: 15 }, (_, i) =>
      cand({ customerUserId: `c${i}`, ticketEsperado: 1000 + i * 100 }));
    const r = buildContactList(cands, { ...CFG, capacidadeLigacoes: 5, winBackReservaPct: 0, coldStartPisoDia: 0 });
    expect(r.callQueue.length).toBe(5);
    const vals = r.callQueue.map(c => c.valorDaLigacao);
    expect([...vals].sort((a, b) => b - a)).toEqual(vals); // já ordenado desc
  });
  it('reserva piso de win-back (clientes sumindo) e cold-start mesmo com top forte', () => {
    const tops = Array.from({ length: 20 }, (_, i) =>
      cand({ customerUserId: `top${i}`, ticketEsperado: 5000 }));            // alto valor, no ciclo
    const winbacks = [cand({ customerUserId: 'wb1', diasDesdeUltima: 90, intervaloMedioDias: 30, ticketEsperado: 800 })];
    const colds = [cand({ customerUserId: 'cs1', isColdStart: true, diasDesdeUltima: null, intervaloMedioDias: null })];
    const r = buildContactList([...tops, ...winbacks, ...colds],
      { winBackReservaPct: 0.2, coldStartPisoDia: 1, capacidadeLigacoes: 10, cadenciaMinDias: 3 });
    expect(r.callQueue.find(c => c.customerUserId === 'wb1')?.bucket).toBe('winback');
    expect(r.callQueue.find(c => c.customerUserId === 'cs1')?.bucket).toBe('coldstart');
    expect(r.callQueue.length).toBe(10);
  });
  it('whatsappQueue exclui cold-start, sem-histórico e janela-aberta (vão p/ humano)', () => {
    const r = buildContactList([
      cand({ customerUserId: 'wa-ok' }),
      cand({ customerUserId: 'wa-cold', isColdStart: true }),
      cand({ customerUserId: 'wa-nohist', intervaloMedioDias: null }),
      cand({ customerUserId: 'wa-janela', janela24hAberta: true }),
    ], CFG);
    const ids = r.whatsappQueue.map((x: ScoredCandidate) => x.customerUserId);
    expect(ids).toContain('wa-ok');
    expect(ids).not.toContain('wa-cold');
    expect(ids).not.toContain('wa-nohist');
    expect(ids).not.toContain('wa-janela');
  });
});
