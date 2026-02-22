import { useState, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';

interface DefaultPrice {
  id: string;
  tool_category_id: string;
  spec_filter: Record<string, string>;
  price: number;
  description: string | null;
}

interface ToolSpecs {
  tool_category_id: string;
  specifications: Record<string, string> | null;
}

export function usePricingEngine() {
  const [defaultPrices, setDefaultPrices] = useState<DefaultPrice[]>([]);
  const [isLoading, setIsLoading] = useState(false);

  const loadDefaultPrices = useCallback(async () => {
    setIsLoading(true);
    try {
      const { data, error } = await supabase
        .from('default_prices')
        .select('*');

      if (error) {
        console.error('Error loading default prices:', error);
        return;
      }

      setDefaultPrices((data || []).map(d => ({
        ...d,
        spec_filter: (d.spec_filter as Record<string, string>) || {},
      })));
    } catch (error) {
      console.error('Error loading default prices:', error);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const calculatePrice = useCallback((tool: ToolSpecs): number | null => {
    if (!defaultPrices.length) return null;

    const categoryPrices = defaultPrices.filter(
      p => p.tool_category_id === tool.tool_category_id
    );

    if (categoryPrices.length === 0) return null;

    const specs = tool.specifications || {};

    // Check for formula-based pricing (Serra Circular Widea: price per tooth)
    const formulaPrice = categoryPrices.find(p => p.spec_filter._formula);
    if (formulaPrice) {
      const specKey = formulaPrice.spec_filter._formula;
      const multiplier = parseFloat(formulaPrice.spec_filter._multiplier || '0');
      const specValue = specs[specKey];
      if (specValue && multiplier > 0) {
        const numericValue = parseFloat(specValue);
        if (!isNaN(numericValue)) {
          return Math.round(multiplier * numericValue * 100) / 100;
        }
      }
      return null;
    }

    // Check for fixed pricing (empty spec_filter or {})
    const fixedPrice = categoryPrices.find(p => Object.keys(p.spec_filter).length === 0);
    if (fixedPrice) return fixedPrice.price;

    // Match by spec_filter (e.g., comprimento, espessura × dentes)
    for (const priceEntry of categoryPrices) {
      const filter = priceEntry.spec_filter;
      const filterKeys = Object.keys(filter).filter(k => !k.startsWith('_'));
      
      if (filterKeys.length === 0) continue;

      const allMatch = filterKeys.every(key => {
        const filterVal = filter[key]?.toLowerCase().trim();
        const specVal = specs[key]?.toString().toLowerCase().trim();
        return filterVal && specVal && filterVal === specVal;
      });

      if (allMatch) return priceEntry.price;
    }

    return null;
  }, [defaultPrices]);

  return {
    defaultPrices,
    isLoading,
    loadDefaultPrices,
    calculatePrice,
  };
}
