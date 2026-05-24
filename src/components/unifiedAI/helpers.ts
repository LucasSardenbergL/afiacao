// Helpers de apresentação do Assistente de Pedido IA (puros).
// Extraídos verbatim de src/components/UnifiedAIAssistant.tsx (god-component split).
import { type UserTool } from './types';

export const fmt = (v: number) =>
  v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export const getToolName = (tool: UserTool) =>
  tool.generated_name || tool.custom_name || tool.tool_categories?.name || 'Ferramenta';

export const formatDuration = (s: number) =>
  `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;
