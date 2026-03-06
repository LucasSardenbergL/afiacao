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
        const processedTools: SharpeningTool[] = (data || []).map((tool: any) => {
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

// Calculate average sharpening frequency based on order history
export async function calculateSharpeningStats(userId: string): Promise<{
  totalOrders: number;
  averageFrequencyDays: number;
  mostFrequentCategory: string | null;
}> {
  try {
    const { data: orders, error } = await supabase
      .from('orders')
      .select('created_at, items, status')
      .eq('user_id', userId)
      .eq('status', 'entregue')
      .order('created_at', { ascending: true });

    if (error) throw error;

    if (!orders || orders.length < 2) {
      return {
        totalOrders: orders?.length || 0,
        averageFrequencyDays: 90, // default
        mostFrequentCategory: null,
      };
    }

    // Calculate average days between orders
    let totalDays = 0;
    for (let i = 1; i < orders.length; i++) {
      const prev = new Date(orders[i - 1].created_at);
      const curr = new Date(orders[i].created_at);
      totalDays += (curr.getTime() - prev.getTime()) / (1000 * 60 * 60 * 24);
    }
    const averageFrequencyDays = Math.round(totalDays / (orders.length - 1));

    // Find most frequent category
    const categoryCounts: Record<string, number> = {};
    orders.forEach(order => {
      const items = order.items as any[];
      items?.forEach(item => {
        if (item.category) {
          categoryCounts[item.category] = (categoryCounts[item.category] || 0) + 1;
        }
      });
    });

    const mostFrequentCategory = Object.entries(categoryCounts)
      .sort((a, b) => b[1] - a[1])[0]?.[0] || null;

    return {
      totalOrders: orders.length,
      averageFrequencyDays,
      mostFrequentCategory,
    };
  } catch (error) {
    console.error('Error calculating sharpening stats:', error);
    return {
      totalOrders: 0,
      averageFrequencyDays: 90,
      mostFrequentCategory: null,
    };
  }
}
