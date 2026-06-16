// Tipos, constantes e helpers da página de Ligações (FarmerCalls).
// Extraídos de src/pages/FarmerCalls.tsx (god-component split).
import { AlertTriangle, TrendingUp, RotateCcw } from 'lucide-react';

export interface Customer {
  user_id: string;
  name: string;
  email: string | null;
  phone: string | null;
  /** Omie codigo_cliente (Oben). Used to resolve/create local user_id when saving. */
  omie_codigo_cliente?: number | null;
  /** Omie cnpj_cpf used to resolve local profile by document. */
  document?: string | null;
}

export interface CallLog {
  id: string;
  customer_user_id: string;
  call_type: string;
  call_result: string;
  duration_seconds: number;
  follow_up_duration_seconds: number;
  attempt_number: number;
  revenue_generated: number;
  margin_generated: number;
  notes: string | null;
  created_at: string;
  customer_name?: string;
}

export const CALL_TYPES = [
  { value: 'reativacao', label: 'Reativação', color: 'status-danger' },
  { value: 'cross_sell', label: 'Cross-sell', color: 'status-progress' },
  { value: 'up_sell', label: 'Up-sell', color: 'bg-purple-50 text-purple-700 border-purple-200' },
  { value: 'follow_up', label: 'Follow-up', color: 'status-pending' },
];

export const CALL_RESULTS = [
  { value: 'contato_sucesso', label: 'Contato com Sucesso', icon: '✅' },
  { value: 'sem_resposta', label: 'Sem Resposta', icon: '📵' },
  { value: 'ocupado', label: 'Ocupado', icon: '🔴' },
  { value: 'caixa_postal', label: 'Caixa Postal', icon: '📩' },
  { value: 'numero_invalido', label: 'Número Inválido', icon: '❌' },
  { value: 'reagendado', label: 'Reagendado', icon: '📅' },
];

export const AGENDA_TYPE_META: Record<string, { label: string; icon: typeof AlertTriangle; color: string }> = {
  risco: { label: 'Risco', icon: AlertTriangle, color: 'text-destructive bg-destructive/10 border-destructive/20' },
  expansao: { label: 'Expansão', icon: TrendingUp, color: 'text-primary bg-primary/10 border-primary/20' },
  follow_up: { label: 'Follow-up', icon: RotateCcw, color: 'text-amber-600 bg-amber-50 border-amber-200' },
};

export const fmt = (v: number) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export function formatTimer(secs: number) {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
