import { useState, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { logger } from '@/lib/logger';

interface PriceHistoryEntry {
  user_tool_id: string;
  service_type: string;
  unit_price: number;
}

interface PriceHistory {
  [key: string]: number; // key = `${userToolId}_${serviceType}` or `${serviceType}`
}

export function usePriceHistory(userId: string | undefined) {
  const [priceHistory, setPriceHistory] = useState<PriceHistory>({});
  const [isLoading, setIsLoading] = useState(false);

  // Fetch all price history for the user
  const loadPriceHistory = useCallback(async () => {
    if (!userId) return;

    setIsLoading(true);
    try {
      const { data, error } = await supabase
        .from('order_price_history')
        .select('user_tool_id, service_type, unit_price')
        .eq('user_id', userId)
        .order('created_at', { ascending: false });

      if (error) {
        logger.error('Failed to load price history', { stage: 'load_history', customerUserId: userId, error });
        return;
      }

      // Build a map with most recent prices
      // Key format: `${userToolId}_${serviceType}` for specific tool pricing
      // Also store `${serviceType}` for general service pricing
      const historyMap: PriceHistory = {};
      
      data?.forEach((entry) => {
        // Specific tool + service combination (takes priority)
        if (entry.user_tool_id) {
          const toolKey = `${entry.user_tool_id}_${entry.service_type}`;
          if (!(toolKey in historyMap)) {
            historyMap[toolKey] = entry.unit_price;
          }
        }
        
        // General service price (fallback)
        const serviceKey = entry.service_type;
        if (!(serviceKey in historyMap)) {
          historyMap[serviceKey] = entry.unit_price;
        }
      });

      setPriceHistory(historyMap);
    } catch (error) {
      logger.error('Unexpected error loading price history', { stage: 'load_history', customerUserId: userId, error });
    } finally {
      setIsLoading(false);
    }
  }, [userId]);

  // Get the last price for a specific tool and service
  const getLastPrice = useCallback((userToolId: string | undefined, serviceType: string): number | null => {
    // First try to find a specific tool + service price
    if (userToolId) {
      const toolKey = `${userToolId}_${serviceType}`;
      if (toolKey in priceHistory) {
        return priceHistory[toolKey];
      }
    }

    // Fallback to general service price
    if (serviceType in priceHistory) {
      return priceHistory[serviceType];
    }

    return null;
  }, [priceHistory]);

  // Save a new price entry (called when order is completed with pricing)
  const savePriceEntry = useCallback(async (
    userToolId: string | null,
    serviceType: string,
    unitPrice: number
  ) => {
    if (!userId || unitPrice <= 0) return;

    try {
      const { error } = await supabase
        .from('order_price_history')
        .insert({
          user_id: userId,
          user_tool_id: userToolId,
          service_type: serviceType,
          unit_price: unitPrice,
        });

      if (error) {
        logger.error('Failed to save price history entry', {
          stage: 'save_entry', customerUserId: userId, userToolId, serviceType, unitPrice, error,
        });
      }
    } catch (error) {
      logger.error('Unexpected error saving price history entry', {
        stage: 'save_entry', customerUserId: userId, userToolId, serviceType, unitPrice, error,
      });
    }
  }, [userId]);

  return {
    priceHistory,
    isLoading,
    loadPriceHistory,
    getLastPrice,
    savePriceEntry,
  };
}
