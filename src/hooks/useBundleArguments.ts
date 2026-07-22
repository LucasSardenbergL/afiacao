import { useState, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';

export interface BundleArgument {
  diagnostico: string;
  insight_tecnico: string;
  beneficio_operacional: string;
  beneficio_economico: string;
  objecao_antecipada: string;
  versao_phone: string;
  versao_whatsapp: string;
  versao_tecnica: string;
}

export type CustomerProfile = 'sensivel_preco' | 'orientado_qualidade' | 'orientado_produtividade' | 'misto';

export const classifyCustomerProfile = (
  healthScore: number,
  avgMonthlySpend: number,
  grossMarginPct: number,
  categoryCount: number
): CustomerProfile => {
  // Price-sensitive: low spend, low margin tolerance
  if (avgMonthlySpend < 500 && grossMarginPct < 20) return 'sensivel_preco';
  // Quality-oriented: high margin, fewer categories (focused buyer)
  if (grossMarginPct > 35 && categoryCount <= 3) return 'orientado_qualidade';
  // Productivity-oriented: high spend, many categories, high health
  if (avgMonthlySpend > 2000 && categoryCount >= 4 && healthScore > 60) return 'orientado_produtividade';
  return 'misto';
};

export const profileLabels: Record<CustomerProfile, { label: string; emoji: string; color: string }> = {
  sensivel_preco: { label: 'Sensível a Preço', emoji: '💰', color: 'text-amber-700' },
  orientado_qualidade: { label: 'Orientado a Qualidade', emoji: '🎯', color: 'text-blue-700' },
  orientado_produtividade: { label: 'Orientado a Produtividade', emoji: '⚡', color: 'text-emerald-700' },
  misto: { label: 'Perfil Misto', emoji: '🔄', color: 'text-purple-700' },
};

export const useBundleArguments = () => {
  const [arguments_, setArguments] = useState<Record<string, BundleArgument>>({});
  const [generating, setGenerating] = useState<Record<string, boolean>>({});

  const generateArgument = useCallback(async (
    bundleKey: string,
    // Sem `margin` por produto e sem `lieBundle`: a edge imprimia os dois em R$ dentro do prompt
    // da LLM, e o texto gerado é LIDO pela vendedora. Instruir o modelo a "não citar margem" é
    // prompt, não gate — o jeito de não vazar é não mandar. Além disso, mandar custo para o
    // provedor externo da LLM é exposição por si só.
    bundle: {
      products: { id: string; name: string; price: number }[];
      confidence: number;
      lift: number;
    },
    customer: {
      name: string;
      cnae?: string | null;
      customerType?: string | null;
      healthScore: number;
      daysSinceLastPurchase?: number | null;
      avgMonthlySpend?: number | null;
      categoryCount?: number | null;
      recentProducts?: string[] | null;
    },
    customerProfile: CustomerProfile
  ) => {
    setGenerating(prev => ({ ...prev, [bundleKey]: true }));

    try {
      const { data, error } = await supabase.functions.invoke('generate-bundle-argument', {
        body: { bundle, customer, customerProfile },
      });

      if (error) throw error;

      if (data?.error) {
        toast.error(data.error);
        return null;
      }

      const argument = data as BundleArgument;
      setArguments(prev => ({ ...prev, [bundleKey]: argument }));
      return argument;
    } catch (error) {
      console.error('Error generating argument:', error);
      toast.error('Erro ao gerar argumentação');
      return null;
    } finally {
      setGenerating(prev => ({ ...prev, [bundleKey]: false }));
    }
  }, []);

  const saveArgumentToBundle = useCallback(async (
    bundleId: string,
    argument: BundleArgument,
    profile: CustomerProfile,
    approachType: string
  ) => {
    await supabase.from('farmer_bundle_recommendations').update({
      argument_phone: argument.versao_phone,
      argument_whatsapp: argument.versao_whatsapp,
      argument_technical: argument.versao_tecnica,
      customer_profile: profile,
      approach_type: approachType,
      updated_at: new Date().toISOString(),
    }).eq('id', bundleId);
  }, []);

  return {
    arguments: arguments_,
    generating,
    generateArgument,
    saveArgumentToBundle,
  };
};
