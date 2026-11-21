// Helpers e constantes do AdminCustomers.
// Extraídos verbatim de src/pages/AdminCustomers.tsx (god-component split).

export const fmt = (v: number) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export const HEALTH_CLASSES: Record<string, { label: string; className: string }> = {
  saudavel: { label: 'Saudável', className: 'status-success' },
  estavel: { label: 'Estável', className: 'status-progress' },
  atencao: { label: 'Atenção', className: 'status-pending' },
  critico: { label: 'Crítico', className: 'status-danger' },
  novo: { label: 'Novo', className: 'text-muted-foreground' },
};

/** Valores do filtro "Saúde" (o mesmo vocabulário que a RPC `listar_clientes_base` aceita). */
const FILTROS_SAUDE = ['saudavel', 'estavel', 'atencao', 'critico', 'sem_historico'] as const;
export type FiltroSaude = (typeof FILTROS_SAUDE)[number];

/**
 * `?health=` da URL → filtro válido ou `null` (= todos). Valor desconhecido (link velho, digitado à
 * mão) vira "todos" em vez de ir ao servidor, que o recusaria com 22023 e a tela diria "falha".
 */
export function normalizarFiltroSaude(v: string | null | undefined): FiltroSaude | null {
  return (FILTROS_SAUDE as readonly string[]).includes(v ?? '') ? (v as FiltroSaude) : null;
}

/** Ordem da lista. `prioridade` = "Priorizar contatos" (padrão); `nome` = A–Z. */
export type OrdemClientes = 'prioridade' | 'nome';
export function normalizarOrdem(v: string | null | undefined): OrdemClientes {
  return v === 'nome' ? 'nome' : 'prioridade';
}

export function formatDocument(doc: string | null) {
  if (!doc) return '-';
  if (doc.length === 11) return doc.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
  if (doc.length === 14) return doc.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
  return doc;
}

/** Placeholder de "não apurado" — nunca "0", "R$ 0,00" ou "999d" (ausente ≠ zero). */
export const NAO_APURADO = '—';

/** Contagem pt-BR com separador de milhar ("16.099", não "16099"). */
export const fmtContagem = (n: number) => n.toLocaleString('pt-BR');

/** Gasto em BRL, ou "—" quando não apurado. `0` medido continua "R$ 0,00". */
export const fmtGasto = (v: number | null) => (v == null ? NAO_APURADO : fmt(v));

/** Prioridade é inteira na fonte (`Math.round` na edge) — "34", não "34.0". */
export const fmtPrioridade = (v: number | null) => (v == null ? NAO_APURADO : String(Math.round(v)));

/** Rótulo da classe de saúde; classe ausente ou desconhecida → "Não avaliado" (nunca "Crítico"). */
export function classeSaudeExibida(healthClass: string | null): { label: string; className: string } {
  return (healthClass != null ? HEALTH_CLASSES[healthClass] : undefined)
    ?? { label: 'Não avaliado', className: 'text-muted-foreground' };
}

/**
 * O que a tela PODE afirmar de um score. Para `sem_historico` a edge grava sentinelas
 * (999 dias, R$ 0, e uma prioridade dominada por churn=100 de quem nunca comprou) —
 * nenhuma é medida, então viram `null`. Fora desse status, repassa o que veio.
 */
export function metricasExibiveis(score: {
  sales_history_status: string | null;
  days_since_last_purchase: number | null;
  avg_monthly_spend_180d: number | null;
  priority_score: number | null;
}): { dias: number | null; gasto: number | null; prioridade: number | null } {
  if (score.sales_history_status === 'sem_historico') {
    return { dias: null, gasto: null, prioridade: null };
  }
  return {
    dias: score.days_since_last_purchase,
    gasto: score.avg_monthly_spend_180d,
    prioridade: score.priority_score,
  };
}

/**
 * Cabeçalho de contagem. `total` só é afirmado quando CONFIRMADO pela fonte; enquanto a contagem
 * não chega, diz quantos já foram carregados (é o que se sabe); falha ou `count: null` →
 * "contagem indisponível". Nunca "0 clientes na base" por ausência de dado.
 */
export function rotuloContagem({ total, pendente, carregados, isCarteira }: {
  total: number | null;
  pendente: boolean;
  carregados: number;
  isCarteira: boolean;
}): string {
  if (total != null) return `${fmtContagem(total)} ${isCarteira ? 'clientes na carteira' : 'clientes na base'}`;
  if (pendente) return `${fmtContagem(carregados)} clientes carregados`;
  return 'contagem indisponível';
}

/**
 * Motivo do contato, numa linha sob o nome (aparece no celular, onde as colunas somem).
 * "Atenção · 66d sem compra"; sem histórico → "Sem histórico de compra"; sem recência medida,
 * só a classe — nunca dias fabricados. Sem score → `null` (nada a afirmar).
 */
export function motivoContato(score: {
  sales_history_status: string | null;
  health_class: string | null;
  days_since_last_purchase: number | null;
  avg_monthly_spend_180d: number | null;
  priority_score: number | null;
} | null | undefined): string | null {
  if (!score) return null;
  if (score.sales_history_status === 'sem_historico') return 'Sem histórico de compra';
  const { label } = classeSaudeExibida(score.health_class);
  const { dias } = metricasExibiveis(score);
  return dias != null ? `${label} · ${dias}d sem compra` : label;
}
