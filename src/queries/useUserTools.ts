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
