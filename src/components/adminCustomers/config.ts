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

export const SALES_HISTORY_LABELS: Record<string, { label: string; className: string }> = {
  sem_historico: { label: 'Sem histórico', className: 'text-muted-foreground' },
  stale: { label: 'Inativo', className: 'status-pending' },
  ativo: { label: 'Ativo', className: 'status-success' },
};

export function formatDocument(doc: string | null) {
  if (!doc) return '-';
  if (doc.length === 11) return doc.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
  if (doc.length === 14) return doc.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
  return doc;
}
