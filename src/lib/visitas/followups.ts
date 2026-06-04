/**
 * "Follow-ups sugeridos" — deriva, das visitas do vendedor, quais clientes pedem
 * uma próxima ação (estado morno sem retorno agendado/contatado). Puro e testável.
 *
 * Read-only / heurística — NÃO é "next best action inteligente"; é sugestão.
 * Spec: docs/superpowers/specs/2026-06-04-followups-sugeridos-design.md
 */
import { diasDesde } from './recencia';

export interface VisitaFollowupRow {
  customer_user_id: string;
  result: string | null;
  notes: string | null;
  check_in_at: string | null;
  visit_date: string;
  revenue_generated: number | null;
}

export type FollowupResult = 'reagendar' | 'interesse' | 'ausente';

export interface FollowupItem {
  customerUserId: string;
  result: FollowupResult;
  lastVisitAt: string; // check_in_at ?? visit_date
  diasDesde: number;
  notes: string | null;
}

/** Janela de relevância por resultado (dias). Fora dela = lead frio → ruído (dropa). */
const JANELA: Record<FollowupResult, number> = { reagendar: 45, interesse: 30, ausente: 21 };
/** Prioridade: reagendar (pediram retorno) > interesse (oportunidade) > ausente (logística). */
const RANK: Record<FollowupResult, number> = { reagendar: 0, interesse: 1, ausente: 2 };

function isWarm(r: string | null): r is FollowupResult {
  return r === 'reagendar' || r === 'interesse' || r === 'ausente';
}

export function montarFollowups(input: {
  visitas: VisitaFollowupRow[];
  agendadasPendentes: Set<string>;
  ultimoContatoPorCliente: Map<string, string>;
  hojeISO: string;
}): FollowupItem[] {
  const { visitas, agendadasPendentes, ultimoContatoPorCliente, hojeISO } = input;

  // 1. Visita MAIS RECENTE por cliente (estado atual). Compara ISO/data lexicograficamente.
  const maisRecente = new Map<string, VisitaFollowupRow>();
  for (const v of visitas) {
    const t = v.check_in_at ?? v.visit_date;
    const cur = maisRecente.get(v.customer_user_id);
    const curT = cur ? (cur.check_in_at ?? cur.visit_date) : '';
    if (!cur || t > curT) maisRecente.set(v.customer_user_id, v);
  }

  const items: FollowupItem[] = [];
  for (const [cid, v] of maisRecente) {
    if (!isWarm(v.result)) continue; // 2. só mornos
    if (agendadasPendentes.has(cid)) continue; // 3. de-dup: já agendei retorno
    const lastVisitAt = v.check_in_at ?? v.visit_date;
    const contato = ultimoContatoPorCliente.get(cid);
    if (contato && contato > lastVisitAt) continue; // 4. de-dup: já contatei DEPOIS da visita
    const dias = diasDesde(lastVisitAt, hojeISO);
    if (dias == null || dias > JANELA[v.result]) continue; // 5. janela por-resultado
    items.push({ customerUserId: cid, result: v.result, lastVisitAt, diasDesde: dias, notes: v.notes });
  }

  // 6. ordena por prioridade, depois mais recente primeiro
  items.sort((a, b) => RANK[a.result] - RANK[b.result] || a.diasDesde - b.diasDesde);
  return items;
}
