// src/queries/useTraining.ts
// Queries/mutation da Educação Técnica (Training): módulos ativos, conclusões
// do usuário e registro de tentativa de quiz.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

interface QuizQuestion {
  question: string;
  options: string[];
  correct: number;
}

export interface TrainingModule {
  id: string;
  title: string;
  description: string | null;
  video_url: string | null;
  quiz_questions: QuizQuestion[];
  min_score: number;
  points_reward: number;
  is_active: boolean;
}

interface TrainingCompletion {
  module_id: string;
  passed: boolean;
  quiz_score: number;
}

/** Módulos de treinamento ativos, na ordem de criação. */
export function useTrainingModules() {
  return useQuery({
    queryKey: ['training', 'modules'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('training_modules')
        .select('*')
        .eq('is_active', true)
        .order('created_at');
      if (error) throw error;
      return (data ?? []) as unknown as TrainingModule[];
    },
  });
}

/** Tentativas (aprovadas ou não) do usuário — base de progresso/melhor nota. */
export function useTrainingCompletions(userId: string | undefined) {
  return useQuery({
    queryKey: ['training', 'completions', userId],
    enabled: !!userId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('training_completions')
        .select('module_id, passed, quiz_score')
        .eq('user_id', userId!);
      if (error) throw error;
      return (data ?? []) as TrainingCompletion[];
    },
  });
}

/** Grava o resultado de um quiz e invalida as conclusões do usuário. */
export function useRegistrarConclusaoTraining() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { userId: string; moduleId: string; quizScore: number; passed: boolean }) => {
      const { error } = await supabase.from('training_completions').insert({
        user_id: input.userId,
        module_id: input.moduleId,
        quiz_score: input.quizScore,
        passed: input.passed,
      });
      if (error) throw error;
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['training', 'completions'] }),
  });
}
