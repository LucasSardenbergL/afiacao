// Constantes de apresentação do copiloto de vendas.
// Extraídas verbatim de src/pages/FarmerCopilot.tsx (god-component split).
import {
  Lightbulb, MessageSquare, Brain, Target, Shield,
  TrendingUp, TrendingDown, Minus, type LucideIcon,
} from 'lucide-react';
import type {
  CopilotDirection,
  CopilotPhase,
  CopilotIntent,
  SuggestionType,
} from '@/hooks/useCopilotEngine';

export const directionConfig: Record<CopilotDirection, { color: string; bg: string; icon: LucideIcon; label: string }> = {
  positivo: { color: 'text-status-success', bg: 'bg-status-success-bg border-status-success/30', icon: TrendingUp, label: 'Positivo' },
  neutro: { color: 'text-status-warning', bg: 'bg-status-warning-bg border-status-warning/30', icon: Minus, label: 'Neutro' },
  risco: { color: 'text-status-error', bg: 'bg-status-error-bg border-status-error/30', icon: TrendingDown, label: 'Em Risco' },
};

export const phaseLabels: Record<CopilotPhase, string> = {
  abertura: '🔵 Abertura',
  diagnostico: '🔍 Diagnóstico',
  exploracao: '🧭 Exploração',
  proposta: '💼 Proposta',
  fechamento: '🎯 Fechamento',
};

export const intentLabels: Record<CopilotIntent, { label: string; color: string }> = {
  interesse: { label: 'Interesse', color: 'bg-status-success-bg text-status-success-fg' },
  objecao_preco: { label: 'Objeção Preço', color: 'bg-status-error-bg text-status-error-fg' },
  objecao_tecnica: { label: 'Objeção Técnica', color: 'bg-orange-100 text-orange-800' },
  falta_urgencia: { label: 'Falta Urgência', color: 'bg-status-warning-bg text-status-warning-fg' },
  comparacao_concorrente: { label: 'Concorrente', color: 'bg-purple-100 text-purple-800' },
  indiferenca: { label: 'Indiferença', color: 'bg-muted text-muted-foreground' },
};

export const suggestionTypeIcons: Record<SuggestionType, LucideIcon> = {
  pergunta_diagnostica: MessageSquare,
  resposta_tecnica: Brain,
  argumento_economico: Target,
  alternativa_abordagem: Shield,
};

export const fallbackSuggestionIcon = Lightbulb;
