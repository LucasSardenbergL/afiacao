// Helpers de apresentação do Assistente de Pedido IA (puros).
// Extraídos verbatim de src/components/UnifiedAIAssistant.tsx (god-component split).
import { type UserTool } from './types';

export const fmt = (v: number) =>
  v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export const getToolName = (tool: UserTool) =>
  tool.generated_name || tool.custom_name || tool.tool_categories?.name || 'Ferramenta';

export const formatDuration = (s: number) =>
  `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;

/** Contagem do relatório de adição (PR 3.1): só `entrou` (adicionado + somado) está no carrinho. */
export interface ContagemRelatorio {
  entrou: number;
  adicionado: number;
  somado: number;
  cor: number;
  descartado: number;
  inferidas: number;
}

/** Texto do anúncio: diz o que ENTROU, o que espera a cor e o que NÃO entrou — nunca só "N adicionados". */
export function resumoRelatorio(c: ContagemRelatorio): string {
  const partes = [
    c.adicionado > 0 ? `${c.adicionado} adicionado(s)` : null,
    c.somado > 0 ? `${c.somado} somado(s) a linha existente` : null,
    c.cor > 0 ? `${c.cor} aguardando a cor` : null,
    c.descartado > 0 ? `${c.descartado} não entrou(aram)` : null,
  ].filter(Boolean);
  const base = partes.length > 0 ? partes.join(' · ') : 'nenhum item';
  return c.inferidas > 0 ? `${base} — ${c.inferidas} com quantidade inferida, confira` : base;
}
