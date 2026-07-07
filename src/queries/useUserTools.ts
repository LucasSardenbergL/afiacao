import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export interface ToolCategory {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  suggested_interval_days: number | null;
}

export interface UserTool {
  id: string;
  tool_category_id: string;
  custom_name: string | null;
  generated_name: string | null;
  internal_code: string | null;
  quantity: number | null;
  specifications: Record<string, string> | null;
  sharpening_interval_days: number | null;
  last_sharpened_at: string | null;
  next_sharpening_due: string | null;
  tool_categories: ToolCategory;
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
      return (data ?? []) as unknown as UserTool[];
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
        .select(`id, tool_category_id, next_sharpening_due, sharpening_interval_days, tool_categories (name)`)
        .eq('user_id', userId!);
      if (error) throw error;
      return (data ?? []) as unknown as {
        id: string;
        tool_category_id: string;
        next_sharpening_due: string | null;
        sharpening_interval_days: number | null;
        tool_categories: { name: string };
      }[];
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

interface UserToolDetail {
  id: string;
  internal_code: string | null;
  custom_name: string | null;
  generated_name: string | null;
  quantity: number | null;
  specifications: Record<string, string> | null;
  sharpening_interval_days: number | null;
  last_sharpened_at: string | null;
  next_sharpening_due: string | null;
  created_at: string;
  tool_categories: {
    name: string;
    description: string | null;
    suggested_interval_days: number | null;
  };
}

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
      return (data ?? null) as unknown as UserToolDetail | null;
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

/** Histórico público de uma ferramenta (QR code, visitante não-logado). */
export function useToolPublicHistory(toolId: string | undefined) {
  return useQuery({
    queryKey: ['tool-public-history', toolId],
    enabled: !!toolId,
    queryFn: async (): Promise<PublicToolHistory> => {
      // RPC pública SECURITY DEFINER: funciona pra visitante NÃO-LOGADO (QR) e devolve só campos
      // seguros (sem user_id do dono). As tabelas user_tools/tool_events não têm policy anon.
      const { data, error } = await supabase.rpc('get_public_tool_history' as never, {
        p_tool_id: toolId,
      } as never);
      if (error) throw error;
      return (data as unknown as PublicToolHistory | null) ?? { tool: null, events: [] };
    },
  });
}
