import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { Json } from '@/integrations/supabase/types';
import { listaJson, objetoJson, textoJson, textoOuNuloJson } from '@/lib/json-forma';

interface ToolCategory {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  suggested_interval_days: number | null;
}


/** Full user tools with category join */
export function useUserTools(userId: string | undefined) {
  return useQuery({
    queryKey: ['user-tools', userId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('user_tools')
        .select(`*, tool_categories (*)`)
        .eq('user_id', userId!)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
    enabled: !!userId,
  });
}

/** Lightweight user tools for Index page (only fields needed for sharpening alerts) */
export function useUserToolsSummary(userId: string | undefined, enabled = true) {
  return useQuery({
    queryKey: ['user-tools', 'summary', userId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('user_tools')
        .select(`id, tool_category_id, next_sharpening_due, last_sharpened_at, sharpening_interval_days, tool_categories (name, suggested_interval_days)`)
        .eq('user_id', userId!);
      if (error) throw error;
      return data ?? [];
    },
    enabled: !!userId && enabled,
  });
}

/** Tool categories */
export function useToolCategories() {
  return useQuery({
    queryKey: ['tool-categories'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('tool_categories')
        .select('*')
        .order('name');
      if (error) throw error;
      return (data ?? []) as ToolCategory[];
    },
    staleTime: 1000 * 60 * 30, // 30 min
  });
}

/* ─── Detalhe de ferramenta (ToolHistory / ToolReports) ─── */


export interface ToolEvent {
  id: string;
  event_type: string;
  description: string | null;
  metadata: Record<string, unknown> | null;
  order_id: string | null;
  created_at: string;
}

interface ToolPriceRecord {
  unit_price: number;
  created_at: string;
}

/** Uma ferramenta com categoria (RLS limita ao dono/staff). `null` = não encontrada. */
export function useUserToolDetail(toolId: string | undefined) {
  return useQuery({
    queryKey: ['user-tool', toolId],
    enabled: !!toolId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('user_tools')
        .select('*, tool_categories (*)')
        .eq('id', toolId!)
        .maybeSingle();
      if (error) throw error;
      return data ?? null;
    },
  });
}

/** Eventos da ferramenta em ordem CRONOLÓGICA (asc). Timeline desc → inverter no consumidor. */
export function useToolEvents(toolId: string | undefined) {
  return useQuery({
    queryKey: ['user-tool', toolId, 'events'],
    enabled: !!toolId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('tool_events')
        .select('*')
        .eq('user_tool_id', toolId!)
        .order('created_at', { ascending: true });
      if (error) throw error;
      return (data ?? []) as ToolEvent[];
    },
  });
}

/** Histórico de preços pagos por afiação desta ferramenta (asc). */
export function useToolPriceHistory(toolId: string | undefined) {
  return useQuery({
    queryKey: ['user-tool', toolId, 'price-history'],
    enabled: !!toolId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('order_price_history')
        .select('unit_price, created_at')
        .eq('user_tool_id', toolId!)
        .order('created_at', { ascending: true });
      if (error) throw error;
      return (data ?? []) as ToolPriceRecord[];
    },
  });
}

/* ─── Histórico público via QR (ToolPublicHistory) ─── */

interface PublicToolData {
  id: string;
  internal_code: string | null;
  generated_name: string | null;
  custom_name: string | null;
  specifications: Record<string, string> | null;
  last_sharpened_at: string | null;
  next_sharpening_due: string | null;
  created_at: string;
  tool_categories: { name: string };
}

interface PublicToolEvent {
  id: string;
  event_type: string;
  description: string | null;
  created_at: string;
}

interface PublicToolHistory {
  tool: PublicToolData | null;
  events: PublicToolEvent[];
}

const F_HIST = 'get_public_tool_history';

/** `specifications` é jsonb livre na tabela: só objeto de textos vale; o resto (número, lista) é descartado. */
function lerEspecificacoes(v: Json | undefined): Record<string, string> | null {
  if (v === null || v === undefined) return null;
  const o = objetoJson(v, `${F_HIST}.tool.specifications`);
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries(o)) if (typeof x === 'string') out[k] = x;
  return out;
}

/**
 * O jsonb de `get_public_tool_history` lido campo a campo (forma do corpo da RPC na prod, conferida em
 * 2026-10-21): NULL (ou `tool: null`) = ferramenta inexistente ("não encontrada"); senão `{ tool, events }`.
 * Desvio lança.
 */
function lerHistoricoPublico(v: Json | null): PublicToolHistory {
  if (v === null) return { tool: null, events: [] };
  const o = objetoJson(v, F_HIST);
  // `tool: null` tem o mesmo sentido do NULL inteiro ("não encontrada"); o contrato sempre o admitiu.
  if (o.tool === null) return { tool: null, events: [] };
  const ft = `${F_HIST}.tool`;
  const t = objetoJson(o.tool, ft);
  const cat = objetoJson(t.tool_categories, `${ft}.tool_categories`);
  return {
    tool: {
      id: textoJson(t, 'id', ft),
      internal_code: textoOuNuloJson(t, 'internal_code', ft),
      generated_name: textoOuNuloJson(t, 'generated_name', ft),
      custom_name: textoOuNuloJson(t, 'custom_name', ft),
      specifications: lerEspecificacoes(t.specifications),
      last_sharpened_at: textoOuNuloJson(t, 'last_sharpened_at', ft),
      next_sharpening_due: textoOuNuloJson(t, 'next_sharpening_due', ft),
      created_at: textoJson(t, 'created_at', ft),
      tool_categories: { name: textoJson(cat, 'name', `${ft}.tool_categories`) },
    },
    events: listaJson(o.events, `${F_HIST}.events`).map((e) => {
      const fe = `${F_HIST}.events[]`;
      const oe = objetoJson(e, fe);
      return {
        id: textoJson(oe, 'id', fe),
        event_type: textoJson(oe, 'event_type', fe),
        description: textoOuNuloJson(oe, 'description', fe),
        created_at: textoJson(oe, 'created_at', fe),
      };
    }),
  };
}

/** Histórico público de uma ferramenta (QR code, visitante não-logado). */
export function useToolPublicHistory(toolId: string | undefined) {
  return useQuery({
    queryKey: ['tool-public-history', toolId],
    enabled: !!toolId,
    queryFn: async (): Promise<PublicToolHistory> => {
      // RPC pública SECURITY DEFINER: funciona pra visitante NÃO-LOGADO (QR) e devolve só campos
      // seguros (sem user_id do dono). As tabelas user_tools/tool_events não têm policy anon.
      if (!toolId) return { tool: null, events: [] }; // `enabled` já barra; aqui é o estreitamento do tipo
      const { data, error } = await supabase.rpc('get_public_tool_history', { p_tool_id: toolId });
      if (error) throw error;
      return lerHistoricoPublico(data);
    },
  });
}
