import { describe, it, expect } from 'vitest';
import { weekdayOfIso, addDaysIso, resolvePrepForWorkday, RouteScheduleRow } from './route-schedule';

// Agenda fixa (spec §2.1). weekday: 0=dom,1=seg,...,6=sab. Terça=2,Qua=3,Qui=4,Sex=5.
const SCHEDULE: RouteScheduleRow[] = [
  { weekday: 2, city: 'FORMIGA', uf: 'MG', is_daily: false, ativo: true },
  { weekday: 2, city: 'PIMENTA', uf: 'MG', is_daily: false, ativo: true },
  { weekday: 3, city: 'CLAUDIO', uf: 'MG', is_daily: false, ativo: true },
  { weekday: 5, city: 'OLIVEIRA', uf: 'MG', is_daily: false, ativo: true },
  { weekday: 0, city: 'DIVINOPOLIS', uf: 'MG', is_daily: true, ativo: true },
  { weekday: 0, city: 'CARMO DO CAJURU', uf: 'MG', is_daily: true, ativo: true },
];

describe('utils de data ISO (UTC, determinístico)', () => {
  it('weekdayOfIso: 2026-05-26 é terça (2)', () => {
    expect(weekdayOfIso('2026-05-26')).toBe(2);
  });
  it('addDaysIso soma dias atravessando mês', () => {
    expect(addDaysIso('2026-05-31', 1)).toBe('2026-06-01');
  });
});

describe('resolvePrepForWorkday (D-1)', () => {
  it('Segunda (2026-05-25) prepara a rota de Terça + diárias', () => {
    const r = resolvePrepForWorkday('2026-05-25', SCHEDULE, []);
    expect(r.dailyOnly).toBe(false);
    expect(r.routeDate).toBe('2026-05-26');
    expect(r.cities.map(c => c.city).sort()).toEqual(
      ['CARMO DO CAJURU', 'DIVINOPOLIS', 'FORMIGA', 'PIMENTA'].sort(),
    );
  });
  it('Sexta (2026-05-29): amanhã é sábado (sem rota) → só diárias', () => {
    const r = resolvePrepForWorkday('2026-05-29', SCHEDULE, []);
    expect(r.dailyOnly).toBe(true);
    expect(r.routeDate).toBeNull();
    expect(r.cities.map(c => c.city).sort()).toEqual(['CARMO DO CAJURU', 'DIVINOPOLIS']);
  });
  it('Quinta (2026-05-28) prepara Sexta', () => {
    const r = resolvePrepForWorkday('2026-05-28', SCHEDULE, []);
    expect(r.routeDate).toBe('2026-05-29');
    expect(r.cities.some(c => c.city === 'OLIVEIRA')).toBe(true);
    expect(r.cities.some(c => c.is_daily)).toBe(true);
  });
  it('feriado na data da rota cancela → cai pra diárias', () => {
    const r = resolvePrepForWorkday('2026-05-25', SCHEDULE, [{ data: '2026-05-26', cancela_rota: true }]);
    expect(r.dailyOnly).toBe(true);
    expect(r.routeDate).toBeNull();
    expect(r.cities.map(c => c.city).sort()).toEqual(['CARMO DO CAJURU', 'DIVINOPOLIS']);
  });
  it('não duplica cidade que é diária E da rota', () => {
    const sched = [...SCHEDULE, { weekday: 2, city: 'DIVINOPOLIS', uf: 'MG', is_daily: false, ativo: true }];
    const r = resolvePrepForWorkday('2026-05-25', sched, []);
    expect(r.cities.filter(c => c.city === 'DIVINOPOLIS').length).toBe(1);
  });
});
