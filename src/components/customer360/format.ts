import { format, formatDistanceToNow, parseISO } from 'date-fns';
import { ptBR } from 'date-fns/locale';

const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

export function formatBRL(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  return BRL.format(v);
}

/**
 * Percentual a partir de FRAÇÃO (0–1 nominal, SEM teto — 2 é "200%"). Multiplica por 100 sempre.
 *
 * O contrato está no nome porque a unidade não está no tipo: `number` serve tanto a 0,56 quanto a
 * 56, e só o call-site sabe qual. Substituiu `formatPctMaybe`, que adivinhava pela heurística
 * `v > 1 ? v : v * 100` — inferência, não contrato, que errava sempre que o valor legítimo caía do
 * outro lado da fronteira.
 *
 * O caso que a heurística quebrava: `variacaoPct` (`@/lib/dashboard/team-kpis`) é
 * (atual−anterior)/anterior e não tem teto, então toda variação acima de +100% caía no ramo "já é
 * percentual" e saía com DUAS ordens de grandeza a menos. Medido em prod (2026-07-21) sobre
 * `sales_orders`, reproduzindo a janela MTD do consumidor: 39 de 971 combinações
 * mês × dia-do-mês × empresa dos últimos 12 meses excedem 1 — concentradas nos primeiros dias do
 * mês, quando a base ainda é pequena. Pior caso real: colacor em 01/07/2026 cresceu 11.553% e o
 * tile exibia "115.5%".
 *
 * ⚠️ Para valor JÁ percentual (0–100), use `formatMargemPct` em `@/lib/format`.
 */
export function formatarFracaoPct(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  const pct = v * 100;
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

/**
 * Tom + rótulo do risco de churn. `risk` é PERCENTUAL 0–100 — não fração.
 *
 * É o que a coluna produz: `farmer_client_scores.churn_risk` medido em prod (2026-07-21) tem
 * 6.632/6.632 linhas acima de 1 (mín. 33, máx. 100, média 96,03), zero nulos e zero zeros.
 *
 * Não adivinha unidade. A heurística anterior (`risk > 1 ? risk : risk * 100`) acertava só porque
 * o mínimo em prod é 33: um risco de 1% cairia no ramo da fração e viraria "100% risco churn" em
 * VERMELHO — o menor risco possível exibido como o maior, com o tom de alarme junto. Como nenhuma
 * linha está hoje na faixa 0–1, isto é DEFESA (o produtor pode passar a emitir a faixa baixa sem
 * avisar o consumidor), não correção de sintoma observado.
 *
 * `NaN` → "—", junto com null/undefined: antes vazava "NaN% risco churn" para a tela.
 */
export function churnTone(risk: number | null): { label: string; className: string } {
  if (risk === null || risk === undefined || Number.isNaN(risk)) {
    return { label: '—', className: 'text-muted-foreground' };
  }
  const label = `${risk.toFixed(0)}% risco churn`;
  if (risk >= 70) return { label, className: 'text-status-error-bold' };
  if (risk >= 40) return { label, className: 'text-status-warning-bold' };
  return { label, className: 'text-status-success-bold' };
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
