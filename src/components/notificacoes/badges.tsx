// Badges de severidade e status do módulo de notificações.
// Extraídos verbatim de src/pages/AdminNotificacoes.tsx (god-component split).
import { Badge } from '@/components/ui/badge';
import type { Severidade } from './types';

export function SeveridadeBadge({ s }: { s: Severidade }) {
  if (s === 'urgente') return <Badge className="bg-destructive text-destructive-foreground">urgente</Badge>;
  if (s === 'atencao') return <Badge className="bg-status-warning text-white">atenção</Badge>;
  return <Badge variant="secondary">info</Badge>;
}

export function StatusBadge({ s }: { s: string | null }) {
  if (s === 'notificado') return <Badge className="bg-status-success text-white">notificado</Badge>;
  if (s === 'falha_notificacao') return <Badge variant="destructive">falha</Badge>;
  return <Badge variant="outline">{s ?? '—'}</Badge>;
}
