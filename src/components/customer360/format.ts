import { format, formatDistanceToNow, parseISO } from 'date-fns';
import { ptBR } from 'date-fns/locale';

const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

export function formatBRL(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  return BRL.format(v);
}

/**
 * Percentual a partir de valor cuja unidade é AMBÍGUA (fração 0–1 ou percentual 0–100), decidida
 * pela heurística `v > 1`. Usado onde a origem é fração — ex.: `MinhasVisitasResultadoCard`.
 *
 * ⚠️ NÃO use para margem: veja `formatMargemPct` em `@/lib/format`. A heurística erra em dois casos que a margem
 * produz de verdade — margem menor que 1% (0,5 vira "50%") e margem NEGATIVA (−143,22, o mínimo
 * medido em prod, não passa no `> 1` e vira "−14322%").
 */
export function formatPctMaybe(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  const pct = v > 1 ? v : v * 100;
  // Zero sem decimal ("0%" em vez de "0.0%"); outros valores com 1 decimal só se houver fração.
  if (pct === 0) return '0%';
  const rounded = Math.round(pct);
  return Math.abs(pct - rounded) < 0.05 ? `${rounded}%` : `${pct.toFixed(1)}%`;
}


/**
 * Profiles tem campo `email` text livre. Sincronização do Omie costuma concatenar
 * múltiplos emails com vírgula (ex: "compras@x.com,financeiro@x.com"). Quebra em
 * lista pra renderizar separadamente.
 */
export function splitEmails(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[,;]/)
    .map((e) => e.trim())
    .filter((e) => e.length > 0 && e.includes('@'));
}

/**
 * `profiles.customer_type` vem como enum-ish text do app/Omie. Mapeia pros rótulos
 * que o usuário humano entende. Fallback: capitaliza o valor cru.
 */
export function formatCustomerType(t: string | null | undefined): string {
  if (!t) return '—';
  const map: Record<string, string> = {
    domestic: 'Doméstico',
    residential: 'Residencial',
    residencial: 'Residencial',
    commercial: 'Comercial',
    comercial: 'Comercial',
    industrial: 'Industrial',
    revenda: 'Revenda',
    reseller: 'Revenda',
    professional: 'Profissional',
    profissional: 'Profissional',
  };
  return map[t.toLowerCase()] ?? (t.charAt(0).toUpperCase() + t.slice(1));
}

/** Tom semântico pro badge de status do pedido. Mapeia status string pra cor sutil. */
export function orderStatusTone(status: string): { className: string; label: string } {
  const s = (status || '').toLowerCase();
  if (['faturado', 'concluido', 'pago', 'entregue'].includes(s)) {
    return { className: 'bg-status-success-bg text-status-success-bold border-status-success/20', label: status };
  }
  if (['cancelado', 'recusado', 'erro'].includes(s)) {
    return { className: 'bg-status-error-bg text-status-error-bold border-status-error/20', label: status };
  }
  if (['pendente', 'aguardando', 'em_analise'].includes(s)) {
    return { className: 'bg-status-warning-bg text-status-warning-bold border-status-warning/20', label: status };
  }
  return { className: 'text-muted-foreground', label: status };
}

export function formatDateOrDash(d: string | null | undefined): string {
  if (!d) return '—';
  try {
    return format(parseISO(d), "dd 'de' MMM yyyy", { locale: ptBR });
  } catch {
    return '—';
  }
}

export function formatRelative(d: string | null | undefined): string {
  if (!d) return '—';
  try {
    return formatDistanceToNow(parseISO(d), { locale: ptBR, addSuffix: true });
  } catch {
    return '—';
  }
}

export function initials(name: string): string {
  return name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('') || '?';
}

export function healthTone(healthClass: string | null, salesHistoryStatus?: string | null): {
  label: string;
  className: string;
  dot: string;
} {
  if (salesHistoryStatus === 'sem_historico') {
    return { label: 'Sem histórico', className: 'text-muted-foreground', dot: 'bg-muted-foreground' };
  }
  switch (healthClass) {
    case 'saudavel':
      return { label: 'Saudável', className: 'text-status-success-bold', dot: 'bg-status-success' };
    case 'atencao':
      return { label: 'Atenção', className: 'text-status-warning-bold', dot: 'bg-status-warning' };
    case 'risco':
      return { label: 'Em risco', className: 'text-status-error-bold', dot: 'bg-status-error' };
    case 'critico':
      return { label: 'Crítico', className: 'text-status-error-bold', dot: 'bg-status-error' };
    default:
      return { label: 'Sem score', className: 'text-muted-foreground', dot: 'bg-muted-foreground' };
  }
}

export function churnTone(risk: number | null): { label: string; className: string } {
  if (risk === null || risk === undefined) return { label: '—', className: 'text-muted-foreground' };
  const pct = risk > 1 ? risk : risk * 100;
  if (pct >= 70) return { label: `${pct.toFixed(0)}% risco churn`, className: 'text-status-error-bold' };
  if (pct >= 40) return { label: `${pct.toFixed(0)}% risco churn`, className: 'text-status-warning-bold' };
  return { label: `${pct.toFixed(0)}% risco churn`, className: 'text-status-success-bold' };
}

export function formatDocument(doc: string): string {
  const d = doc.replace(/\D/g, '');
  if (d.length === 11) return d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
  if (d.length === 14) return d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
  return doc;
}

export function formatPhone(p: string): string {
  const d = p.replace(/\D/g, '');
  if (d.length === 11) return d.replace(/(\d{2})(\d{5})(\d{4})/, '($1) $2-$3');
  if (d.length === 10) return d.replace(/(\d{2})(\d{4})(\d{4})/, '($1) $2-$3');
  return p;
}

export function formatCep(z: string): string {
  const d = z.replace(/\D/g, '');
  if (d.length === 8) return d.replace(/(\d{5})(\d{3})/, '$1-$2');
  return z;
}
