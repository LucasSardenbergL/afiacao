import type { CustomerCallRow } from '@/hooks/useCustomerCalls';
import type { AggregatedEntity } from './aggregate-entities';

interface CompetitorMention {
  value: string;
  totalOccurrences: number;
  maxConfidence: number;
}

interface ObjectionAgg {
  type: string;
  count: number;
  exampleNote: string;
}

export interface CustomerProfile360 {
  totalCalls: number;
  totalDurationSeconds: number;
  totalRevenue: number;
  totalMargin: number;
  avgTicket: number;
  lastCallAt: string | null;
  competitorsMentioned: CompetitorMention[];
  pricesReferenced: AggregatedEntity[];
  productsCompetitor: AggregatedEntity[];
  topObjections: ObjectionAgg[];
}

interface AnalysisLike {
  risks?: Array<{ type: string; severity: string; note: string }>;
}

/**
 * Agrega múltiplas chamadas de 1 cliente em um perfil 360 v1.
 * Foco em fatos: KPIs + entidades agregadas. Sem inferências/scoring.
 */
export function aggregateCustomerProfile(calls: CustomerCallRow[]): CustomerProfile360 {
  if (calls.length === 0) {
    return {
      totalCalls: 0,
      totalDurationSeconds: 0,
      totalRevenue: 0,
      totalMargin: 0,
      avgTicket: 0,
      lastCallAt: null,
      competitorsMentioned: [],
      pricesReferenced: [],
      productsCompetitor: [],
      topObjections: [],
    };
  }

  const totalDurationSeconds = calls.reduce((s, c) => s + (c.duration_seconds ?? 0), 0);
  const totalRevenue = calls.reduce((s, c) => s + Number(c.revenue_generated ?? 0), 0);
  const totalMargin = calls.reduce((s, c) => s + Number(c.margin_generated ?? 0), 0);
  const revenueCalls = calls.filter((c) => Number(c.revenue_generated ?? 0) > 0);
  const avgTicket = revenueCalls.length === 0
    ? 0
    : revenueCalls.reduce((s, c) => s + Number(c.revenue_generated ?? 0), 0) / revenueCalls.length;

  const lastCallAt = calls
    .map((c) => c.started_at)
    .sort()
    .reverse()[0] ?? null;

  // Agrega entities deduplicadas por (type, value lowercase)
  const allEntities: AggregatedEntity[] = calls.flatMap((c) =>
    Array.isArray(c.entities_extracted) ? (c.entities_extracted as AggregatedEntity[]) : []
  );

  const byTypeValue = new Map<string, AggregatedEntity & { totalOccurrences: number }>();
  for (const e of allEntities) {
    const key = `${e.type}::${e.value.trim().toLowerCase()}`;
    const ex = byTypeValue.get(key);
    if (ex) {
      ex.totalOccurrences += e.occurrences ?? 1;
      if (e.confidence > ex.confidence) ex.confidence = e.confidence;
    } else {
      byTypeValue.set(key, { ...e, totalOccurrences: e.occurrences ?? 1 });
    }
  }

  const allAgg = Array.from(byTypeValue.values());
  const competitorsMentioned: CompetitorMention[] = allAgg
    .filter((e) => e.type === 'competitor')
    .map((e) => ({ value: e.value, totalOccurrences: e.totalOccurrences, maxConfidence: e.confidence }));

  const pricesReferenced = allAgg.filter((e) => e.type === 'price');
  const productsCompetitor = allAgg.filter((e) => e.type === 'product');

  // Top objections: agrega risks[] de todas as análises
  const objMap = new Map<string, ObjectionAgg>();
  for (const c of calls) {
    const analyses = (Array.isArray(c.analyses) ? c.analyses : []) as AnalysisLike[];
    for (const a of analyses) {
      for (const r of (a.risks ?? [])) {
        const ex = objMap.get(r.type);
        if (ex) ex.count += 1;
        else objMap.set(r.type, { type: r.type, count: 1, exampleNote: r.note });
      }
    }
  }
  const topObjections = Array.from(objMap.values()).sort((a, b) => b.count - a.count).slice(0, 5);

  return {
    totalCalls: calls.length,
    totalDurationSeconds,
    totalRevenue,
    totalMargin,
    avgTicket,
    lastCallAt,
    competitorsMentioned,
    pricesReferenced,
    productsCompetitor,
    topObjections,
  };
}
