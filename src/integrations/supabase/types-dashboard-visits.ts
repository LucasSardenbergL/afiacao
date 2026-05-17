/**
 * Extensão manual do Database type para tabela dashboard_visits
 * adicionada na migration 20260517140000.
 */

export interface DashboardVisitRow {
  id: number;
  user_id: string;
  visited_at: string;
  persona: string | null;
  company_selection: string | null;
  session_minutes: number | null;
}

export interface DashboardVisitInsert {
  user_id: string;
  visited_at?: string;
  persona?: string | null;
  company_selection?: string | null;
  session_minutes?: number | null;
}
