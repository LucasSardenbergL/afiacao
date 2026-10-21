// src/queries/useTraining.ts
// Queries/mutation da Educação Técnica (Training): módulos ativos, conclusões
// do usuário e registro de tentativa de quiz.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { Json, Tables } from '@/integrations/supabase/types';

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

/**
 * `quiz_questions` é jsonb (tipado `Json`). Pergunta fora da forma (sem texto, opções que não são
 * textos, `correct` fora do intervalo das opções) é DESCARTADA — um quiz com pergunta impossível
 * de responder certo daria nota errada. Antes, `as unknown as TrainingModule[]` aceitava qualquer forma.
 */
function lerQuiz(v: Json): QuizQuestion[] {
  if (!Array.isArray(v)) return [];
  const out: QuizQuestion[] = [];
  for (const q of v) {
    if (q === null || typeof q !== 'object' || Array.isArray(q)) continue;
    const { question, options, correct } = q;
    if (typeof question !== 'string' || !Array.isArray(options)) continue;
    const textos = options.filter((o): o is string => typeof o === 'string');
    if (textos.length !== options.length) continue;
    if (typeof correct !== 'number' || !Number.isInteger(correct) || correct < 0 || correct >= textos.length) continue;
    out.push({ question, options: textos, correct });
  }
  return out;
}

/** Linha de `training_modules` com o quiz lido por forma. */
export function paraTrainingModule(l: Tables<'training_modules'>): TrainingModule {
  return {
    id: l.id, title: l.title, description: l.description, video_url: l.video_url,
    quiz_questions: lerQuiz(l.quiz_questions), min_score: l.min_score,
    points_reward: l.points_reward, is_active: l.is_active,
  };
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
      return (data ?? []).map(paraTrainingModule);
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
