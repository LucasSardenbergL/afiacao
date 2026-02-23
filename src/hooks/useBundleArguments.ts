import { useState, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useToast } from '@/hooks/use-toast';

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
  const { toast } = useToast();
  const [arguments_, setArguments] = useState<Record<string, BundleArgument>>({});
  const [generating, setGenerating] = useState<Record<string, boolean>>({});

  const generateArgument = useCallback(async (
    bundleKey: string,
    bundle: {
      products: { id: string; name: string; price: number; margin: number }[];
      lieBundle: number;
      confidence: number;
      lift: number;
    },
    customer: {
      name: string;
      cnae?: string;
      customerType?: string;
      healthScore: number;
      daysSinceLastPurchase?: number;
      avgMonthlySpend?: number;
      categoryCount?: number;
      recentProducts?: string[];
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
        toast({ title: data.error, variant: 'destructive' });
        return null;
      }

      const argument = data as BundleArgument;
      setArguments(prev => ({ ...prev, [bundleKey]: argument }));
      return argument;
    } catch (error) {
      console.error('Error generating argument:', error);
      toast({ title: 'Erro ao gerar argumentação', variant: 'destructive' });
      return null;
    } finally {
      setGenerating(prev => ({ ...prev, [bundleKey]: false }));
    }
  }, [toast]);

  const saveArgumentToBundle = useCallback(async (
    bundleId: string,
    argument: BundleArgument,
    profile: CustomerProfile,
    approachType: string
  ) => {
    await supabase.from('farmer_bundle_recommendations' as any).update({
      argument_phone: argument.versao_phone,
      argument_whatsapp: argument.versao_whatsapp,
      argument_technical: argument.versao_tecnica,
      customer_profile: profile,
      approach_type: approachType,
      updated_at: new Date().toISOString(),
    } as any).eq('id', bundleId);
  }, []);

  return {
    arguments: arguments_,
    generating,
    generateArgument,
    saveArgumentToBundle,
  };
};
