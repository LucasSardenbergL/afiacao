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
  it('win-back reservado é ordenado por VALOR e exige piso (não o sumido mais barato) [codex #3]', () => {
    const tops = Array.from({ length: 3 }, (_, i) => cand({ customerUserId: `top${i}`, ticketEsperado: 5000 })); // valor 500
    const wbHi = cand({ customerUserId: 'wbHi', diasDesdeUltima: 45, intervaloMedioDias: 30, ticketEsperado: 4500 }); // winback, valor 450 (>= piso)
    const wbLo = cand({ customerUserId: 'wbLo', diasDesdeUltima: 90, intervaloMedioDias: 30, ticketEsperado: 400 });  // winback, valor 40 (< piso)
    const r = buildContactList([...tops, wbHi, wbLo],
      { winBackReservaPct: 0.34, coldStartPisoDia: 0, capacidadeLigacoes: 3, cadenciaMinDias: 3 });
    expect(r.callQueue.find(c => c.customerUserId === 'wbHi')?.bucket).toBe('winback'); // valioso entra na reserva
    expect(r.callQueue.find(c => c.customerUserId === 'wbLo')).toBeUndefined();          // sumido barato NÃO ocupa reserva
    expect(r.callQueue.length).toBe(3);
  });
  it('cold-start é limitado a % do cap (não o piso cego) quando o cap é pequeno [codex #4]', () => {
    const tops = Array.from({ length: 5 }, (_, i) => cand({ customerUserId: `top${i}`, ticketEsperado: 5000 }));
    const colds = Array.from({ length: 3 }, (_, i) => cand({ customerUserId: `cs${i}`, isColdStart: true }));
    const r = buildContactList([...tops, ...colds],
      { winBackReservaPct: 0, coldStartPisoDia: 3, capacidadeLigacoes: 5, cadenciaMinDias: 3 });
    // ceil(5*0.10)=1, min(3,1)=1 → só 1 cold-start, não 3
    expect(r.callQueue.filter(c => c.bucket === 'coldstart').length).toBe(1);
  });
  it('whatsappQueue dedup contra callQueue + filtra cold-start/sem-hist/janela [codex #6/#7]', () => {
    const r = buildContactList([
      cand({ customerUserId: 'hi', ticketEsperado: 5000 }),     // topo → vai pra callQueue
      cand({ customerUserId: 'wa-ok' }),                         // overflow elegível → whatsappQueue
      cand({ customerUserId: 'wa-cold', isColdStart: true }),
      cand({ customerUserId: 'wa-nohist', intervaloMedioDias: null }),
      cand({ customerUserId: 'wa-janela', janela24hAberta: true }),
    ], { winBackReservaPct: 0, coldStartPisoDia: 0, capacidadeLigacoes: 1, cadenciaMinDias: 3 });
    const ids = r.whatsappQueue.map((x: ScoredCandidate) => x.customerUserId);
    expect(ids).toContain('wa-ok');
    expect(ids).not.toContain('hi');        // já está na callQueue → não duplica canal
    expect(ids).not.toContain('wa-cold');
    expect(ids).not.toContain('wa-nohist');
    expect(ids).not.toContain('wa-janela');
  });
});
