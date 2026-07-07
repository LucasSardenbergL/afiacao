import { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';

export interface SharpeningTool {
  id: string;
  toolCategoryId: string;
  categoryName: string;
  lastSharpenedAt: Date | null;
  nextSharpeningDue: Date | null;
  sharpeningIntervalDays: number;
  daysUntilDue: number;
  isOverdue: boolean;
  isDueSoon: boolean; // Due within 7 days
}

export interface SharpeningSuggestions {
  overdueTools: SharpeningTool[];
  dueSoonTools: SharpeningTool[];
  upcomingTools: SharpeningTool[];
  loading: boolean;
}

interface UserToolRow {
  id: string;
  tool_category_id: string;
  last_sharpened_at: string | null;
  next_sharpening_due: string | null;
  sharpening_interval_days: number | null;
  tool_categories: { name: string } | null;
}

export function useSharpeningSuggestions(): SharpeningSuggestions {
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [tools, setTools] = useState<SharpeningTool[]>([]);

  useEffect(() => {
    const loadTools = async () => {
      if (!user) {
        setLoading(false);
        return;
      }

      try {
        const { data, error } = await supabase
          .from('user_tools')
          .select(`
            id,
            tool_category_id,
            last_sharpened_at,
            next_sharpening_due,
            sharpening_interval_days,
            tool_categories (name)
          `)
          .eq('user_id', user.id);

        if (error) throw error;

        const now = new Date();
        const processedTools: SharpeningTool[] = (data || []).map((tool: UserToolRow) => {
          const nextDue = tool.next_sharpening_due ? new Date(tool.next_sharpening_due) : null;
          const daysUntilDue = nextDue 
            ? Math.ceil((nextDue.getTime() - now.getTime()) / (1000 * 60 * 60 * 24))
            : 999;

          return {
            id: tool.id,
            toolCategoryId: tool.tool_category_id,
            categoryName: tool.tool_categories?.name || 'Ferramenta',
            lastSharpenedAt: tool.last_sharpened_at ? new Date(tool.last_sharpened_at) : null,
            nextSharpeningDue: nextDue,
            sharpeningIntervalDays: tool.sharpening_interval_days || 90,
            daysUntilDue,
            isOverdue: daysUntilDue < 0,
            isDueSoon: daysUntilDue >= 0 && daysUntilDue <= 7,
          };
        });

        setTools(processedTools);
      } catch (error) {
        console.error('Error loading sharpening suggestions:', error);
      } finally {
        setLoading(false);
      }
    };

    loadTools();
  }, [user]);

  const overdueTools = tools.filter(t => t.isOverdue).sort((a, b) => a.daysUntilDue - b.daysUntilDue);
  const dueSoonTools = tools.filter(t => t.isDueSoon).sort((a, b) => a.daysUntilDue - b.daysUntilDue);
  const upcomingTools = tools.filter(t => !t.isOverdue && !t.isDueSoon && t.nextSharpeningDue)
    .sort((a, b) => a.daysUntilDue - b.daysUntilDue);

  return {
    overdueTools,
    dueSoonTools,
    upcomingTools,
    loading,
  };
}
