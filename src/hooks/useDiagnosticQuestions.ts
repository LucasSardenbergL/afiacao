import { useState, useCallback } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/hooks/use-toast';
import type { CustomerProfile } from '@/hooks/useBundleArguments';

export interface DiagnosticQuestion {
  type: 'situacao' | 'problema' | 'implicacao' | 'direcionamento';
  main: string;
  alt: string;
  rationale: string;
}

export type QuestionResponse = 'interesse' | 'objecao' | 'indiferenca';

export interface QuestionWithResponse extends DiagnosticQuestion {
  dbId?: string;
  response?: QuestionResponse;
  notes?: string;
  useAlt?: boolean;
}

const typeLabels: Record<string, { label: string; emoji: string; color: string }> = {
  situacao: { label: 'Situação', emoji: '📋', color: 'text-blue-700' },
  problema: { label: 'Problema', emoji: '⚠️', color: 'text-amber-700' },
  implicacao: { label: 'Implicação', emoji: '📉', color: 'text-red-700' },
  direcionamento: { label: 'Direcionamento', emoji: '🎯', color: 'text-emerald-700' },
};

export { typeLabels };

export const useDiagnosticQuestions = () => {
  const { user } = useAuth();
  const { toast } = useToast();
  const [questions, setQuestions] = useState<Record<string, QuestionWithResponse[]>>({});
  const [generating, setGenerating] = useState<Record<string, boolean>>({});

  const generateQuestions = useCallback(async (
    bundleKey: string,
    bundle: {
      products: { id: string; name: string; price: number; margin: number }[];
      lieBundle: number;
      confidence: number;
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
        body: { bundle, customer, customerProfile, mode: 'diagnostic_questions' },
      });

      if (error) throw error;
      if (data?.error) {
        toast({ title: data.error, variant: 'destructive' });
        return null;
      }

      const qs: QuestionWithResponse[] = (data.questions || []).map((q: DiagnosticQuestion) => ({
        ...q,
        useAlt: false,
      }));

      setQuestions(prev => ({ ...prev, [bundleKey]: qs }));
      return qs;
    } catch (error) {
      console.error('Error generating diagnostic questions:', error);
      toast({ title: 'Erro ao gerar perguntas diagnósticas', variant: 'destructive' });
      return null;
    } finally {
      setGenerating(prev => ({ ...prev, [bundleKey]: false }));
    }
  }, [toast]);

  const setResponse = useCallback((bundleKey: string, questionIndex: number, response: QuestionResponse, notes?: string) => {
    setQuestions(prev => {
      const qs = [...(prev[bundleKey] || [])];
      if (qs[questionIndex]) {
        qs[questionIndex] = { ...qs[questionIndex], response, notes };
      }
      return { ...prev, [bundleKey]: qs };
    });
  }, []);

  const toggleAlt = useCallback((bundleKey: string, questionIndex: number) => {
    setQuestions(prev => {
      const qs = [...(prev[bundleKey] || [])];
      if (qs[questionIndex]) {
        qs[questionIndex] = { ...qs[questionIndex], useAlt: !qs[questionIndex].useAlt };
      }
      return { ...prev, [bundleKey]: qs };
    });
  }, []);

  const saveQuestionsToDb = useCallback(async (
    bundleKey: string,
    bundleRecommendationId: string | undefined,
    customerId: string,
    customerProfile: CustomerProfile,
    wasBundleOffered: boolean,
    bundleResult?: string,
    marginGenerated?: number,
    timeSpentSeconds?: number
  ) => {
    if (!user?.id) return;
    const qs = questions[bundleKey];
    if (!qs?.length) return;

    try {
      for (const q of qs) {
        await supabase.from('farmer_diagnostic_questions' as any).insert({
          bundle_recommendation_id: bundleRecommendationId || null,
          farmer_id: user.id,
          customer_user_id: customerId,
          question_type: q.type,
          question_text: q.useAlt ? q.alt : q.main,
          alt_question_text: q.useAlt ? q.main : q.alt,
          customer_profile: customerProfile,
          response_type: q.response || null,
          response_notes: q.notes || null,
          was_bundle_offered: wasBundleOffered,
          bundle_result: bundleResult || null,
          margin_generated: marginGenerated || 0,
          time_spent_seconds: timeSpentSeconds || 0,
        } as any);
      }
      toast({ title: 'Respostas salvas com sucesso' });
    } catch (error) {
      console.error('Error saving questions:', error);
      toast({ title: 'Erro ao salvar respostas', variant: 'destructive' });
    }
  }, [user?.id, questions, toast]);

  const getEffectivenessStats = useCallback(async () => {
    if (!user?.id) return null;

    const { data } = await supabase
      .from('farmer_diagnostic_questions' as any)
      .select('question_type, response_type, was_bundle_offered, bundle_result, margin_generated')
      .eq('farmer_id', user.id) as any;

    if (!data?.length) return null;

    const stats: Record<string, { total: number; interesse: number; offered: number; accepted: number; totalMargin: number }> = {};

    for (const row of data) {
      const type = row.question_type;
      if (!stats[type]) stats[type] = { total: 0, interesse: 0, offered: 0, accepted: 0, totalMargin: 0 };
      stats[type].total++;
      if (row.response_type === 'interesse') stats[type].interesse++;
      if (row.was_bundle_offered) stats[type].offered++;
      if (['aceito_total', 'aceito_parcial'].includes(row.bundle_result)) stats[type].accepted++;
      stats[type].totalMargin += Number(row.margin_generated || 0);
    }

    return stats;
  }, [user?.id]);

  return {
    questions,
    generating,
    generateQuestions,
    setResponse,
    toggleAlt,
    saveQuestionsToDb,
    getEffectivenessStats,
  };
};
