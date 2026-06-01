import { CityKey } from './route-city';

export interface RouteScheduleRow {
  weekday: number;     // 0=dom..6=sab
  city: string;        // canônico (já normalizado, UPPER sem acento)
  uf: string;
  is_daily: boolean;
  ativo: boolean;
}
export interface RouteOverrideRow {
  data: string;        // 'YYYY-MM-DD'
  cancela_rota: boolean;
}
export interface PrepCity extends CityKey {
  is_daily: boolean;
}
export interface PrepResult {
  workday: string;          // hoje 'YYYY-MM-DD'
  routeDate: string | null; // data da rota preparada (D+1 útil) ou null
  cities: PrepCity[];       // alvos do contato de hoje (rota D+1 + diárias), deduplicado
  dailyOnly: boolean;       // true quando não há rota amanhã
}

// UTC determinístico (sem Date.now()/argless new Date()).
export function weekdayOfIso(iso: string): number {
  return new Date(iso + 'T12:00:00Z').getUTCDay();
}
export function addDaysIso(iso: string, n: number): string {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function resolvePrepForWorkday(
  workdayIso: string,
  schedule: RouteScheduleRow[],
  overrides: RouteOverrideRow[],
): PrepResult {
  const active = schedule.filter(r => r.ativo);
  const daily = active.filter(r => r.is_daily);

  const routeDate = addDaysIso(workdayIso, 1);
  const cancelled = overrides.some(o => o.data === routeDate && o.cancela_rota);
  const routeRows = cancelled ? [] : active.filter(r => !r.is_daily && r.weekday === weekdayOfIso(routeDate));
  const hasRoute = routeRows.length > 0;

  // dedup por city+uf (rota + diárias), diárias entram sempre.
  const seen = new Set<string>();
  const cities: PrepCity[] = [];
  for (const r of [...routeRows, ...daily]) {
    const k = `${r.city}|${r.uf}`;
    if (seen.has(k)) continue;
    seen.add(k);
    cities.push({ city: r.city, uf: r.uf, is_daily: r.is_daily });
  }

  return {
    workday: workdayIso,
    routeDate: hasRoute ? routeDate : null,
    cities,
    dailyOnly: !hasRoute,
  };
}
