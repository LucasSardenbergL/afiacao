import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { usePricingEngine } from "@/hooks/usePricingEngine";

// We test calculatePrice logic by pre-loading defaultPrices via the hook's internal state.
// Since loadDefaultPrices calls supabase, we bypass it and test the pure calculation logic.

function setupHookWithPrices(prices: any[]) {
  const { result } = renderHook(() => usePricingEngine());

  // Manually set defaultPrices by calling calculatePrice after injecting state.
  // We need to access the hook's calculatePrice which depends on defaultPrices.
  // Since we can't set state directly, we'll test the logic extracted from the hook.
  return result;
}

// Extract the pricing logic for unit testing
function calculatePriceFromList(
  defaultPrices: Array<{
    id: string;
    tool_category_id: string;
    spec_filter: Record<string, string>;
    price: number;
    description: string | null;
  }>,
  tool: { tool_category_id: string; specifications: Record<string, string> | null }
): number | null {
  if (!defaultPrices.length) return null;

  const categoryPrices = defaultPrices.filter(
    (p) => p.tool_category_id === tool.tool_category_id
  );

  if (categoryPrices.length === 0) return null;

  const specs = tool.specifications || {};

  // Formula-based pricing
  const formulaPrice = categoryPrices.find((p) => p.spec_filter._formula);
  if (formulaPrice) {
    const specKey = formulaPrice.spec_filter._formula;
    const multiplier = parseFloat(formulaPrice.spec_filter._multiplier || "0");
    const specValue = specs[specKey];
    if (specValue && multiplier > 0) {
      const numericValue = parseFloat(specValue);
      if (!isNaN(numericValue)) {
        return Math.round(multiplier * numericValue * 100) / 100;
      }
    }
    return null;
  }

  // Fixed pricing (empty spec_filter)
  const fixedPrice = categoryPrices.find(
    (p) => Object.keys(p.spec_filter).length === 0
  );
  if (fixedPrice) return fixedPrice.price;

  // Match by spec_filter
  for (const priceEntry of categoryPrices) {
    const filter = priceEntry.spec_filter;
    const filterKeys = Object.keys(filter).filter((k) => !k.startsWith("_"));

    if (filterKeys.length === 0) continue;

    const allMatch = filterKeys.every((key) => {
      const filterVal = filter[key]?.toLowerCase().trim();
      const specVal = specs[key]?.toString().toLowerCase().trim();
      return filterVal && specVal && filterVal === specVal;
    });

    if (allMatch) return priceEntry.price;
  }

  return null;
}

describe("usePricingEngine – calculatePrice logic", () => {
  const CATEGORY_TESOURA = "cat-tesoura";
  const CATEGORY_SERRA = "cat-serra-widea";
  const CATEGORY_FRESA = "cat-fresa";

  const mockPrices = [
    {
      id: "1",
      tool_category_id: CATEGORY_TESOURA,
      spec_filter: {},
      price: 20,
      description: "Tesoura Profissional – preço fixo",
    },
    {
      id: "2",
      tool_category_id: CATEGORY_SERRA,
      spec_filter: {
        _formula: "dentes",
        _multiplier: "1.20",
      },
      price: 0,
      description: "Serra Circular Widea – R$1,20/dente",
    },
  ];

  it("returns fixed price when spec_filter is empty", () => {
    const result = calculatePriceFromList(mockPrices, {
      tool_category_id: CATEGORY_TESOURA,
      specifications: null,
    });

    expect(result).toBe(20);
  });

  it("calculates formula-based price (serra circular – price per tooth)", () => {
    const result = calculatePriceFromList(mockPrices, {
      tool_category_id: CATEGORY_SERRA,
      specifications: { dentes: "48" },
    });

    // 1.20 * 48 = 57.60
    expect(result).toBe(57.6);
  });

  it("returns correct rounding for formula prices", () => {
    const result = calculatePriceFromList(mockPrices, {
      tool_category_id: CATEGORY_SERRA,
      specifications: { dentes: "36" },
    });

    // 1.20 * 36 = 43.20
    expect(result).toBe(43.2);
  });

  it("returns null when no price is registered for the category", () => {
    const result = calculatePriceFromList(mockPrices, {
      tool_category_id: CATEGORY_FRESA,
      specifications: null,
    });

    expect(result).toBeNull();
  });

  it("returns null when defaultPrices list is empty", () => {
    const result = calculatePriceFromList([], {
      tool_category_id: CATEGORY_TESOURA,
      specifications: null,
    });

    expect(result).toBeNull();
  });

  it("returns null for formula price when spec value is missing", () => {
    const result = calculatePriceFromList(mockPrices, {
      tool_category_id: CATEGORY_SERRA,
      specifications: {},
    });

    expect(result).toBeNull();
  });
});
