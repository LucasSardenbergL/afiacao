import { useState, useEffect } from 'react';
import { Header } from '@/components/Header';
import { BottomNav } from '@/components/BottomNav';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/hooks/use-toast';
import { Loader2, BookOpen, CheckCircle2, XCircle, PlayCircle, Award, Sparkles, ArrowRight } from 'lucide-react';

interface QuizQuestion {
  question: string;
  options: string[];
  correct: number;
}

interface TrainingModule {
  id: string;
  title: string;
  description: string | null;
  video_url: string | null;
  quiz_questions: QuizQuestion[];
  min_score: number;
  points_reward: number;
  is_active: boolean;
}

interface Completion {
  module_id: string;
  passed: boolean;
  quiz_score: number;
}

const Training = () => {
  const { user } = useAuth();
  const { toast } = useToast();

  const [modules, setModules] = useState<TrainingModule[]>([]);
  const [completions, setCompletions] = useState<Completion[]>([]);
  const [loading, setLoading] = useState(true);

  // Quiz state
  const [activeModule, setActiveModule] = useState<TrainingModule | null>(null);
  const [currentQ, setCurrentQ] = useState(0);
  const [answers, setAnswers] = useState<(number | null)[]>([]);
  const [showResult, setShowResult] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (user) loadData();
  }, [user]);

  const loadData = async () => {
    const [modRes, compRes] = await Promise.all([
      supabase.from('training_modules').select('*').eq('is_active', true).order('created_at'),
      supabase.from('training_completions').select('module_id, passed, quiz_score').eq('user_id', user!.id),
    ]);
    setModules((modRes.data || []) as unknown as TrainingModule[]);
    setCompletions((compRes.data || []) as Completion[]);
    setLoading(false);
  };

  const startQuiz = (mod: TrainingModule) => {
    setActiveModule(mod);
    setCurrentQ(0);
    setAnswers(new Array(mod.quiz_questions.length).fill(null));
    setShowResult(false);
  };

  const selectAnswer = (optionIdx: number) => {
    setAnswers(prev => prev.map((a, i) => i === currentQ ? optionIdx : a));
  };

  const submitQuiz = async () => {
    if (!activeModule || !user) return;
    setSubmitting(true);

    const totalQ = activeModule.quiz_questions.length;
    const correctCount = activeModule.quiz_questions.reduce((count, q, idx) => {
      return count + (answers[idx] === q.correct ? 1 : 0);
    }, 0);
    const scorePercent = Math.round((correctCount / totalQ) * 100);
    const passed = scorePercent >= activeModule.min_score;

    const { error } = await supabase.from('training_completions').insert({
      user_id: user.id,
      module_id: activeModule.id,
      quiz_score: scorePercent,
      passed,
    });

    if (error) {
      toast({ title: 'Erro ao salvar resultado', variant: 'destructive' });
    } else {
      if (passed) {
        toast({ title: `Parabéns! Você ganhou ${activeModule.points_reward} pontos de educação!`, description: `Nota: ${scorePercent}%` });
      } else {
        toast({ title: 'Não atingiu a nota mínima', description: `Nota: ${scorePercent}% (mínimo: ${activeModule.min_score}%)`, variant: 'destructive' });
      }
      setCompletions(prev => [...prev, { module_id: activeModule.id, passed, quiz_score: scorePercent }]);
    }
    setShowResult(true);
    setSubmitting(false);
  };

  const getCompletion = (moduleId: string) => completions.find(c => c.module_id === moduleId && c.passed);
  const getBestAttempt = (moduleId: string) => {
    const attempts = completions.filter(c => c.module_id === moduleId);
    return attempts.length > 0 ? Math.max(...attempts.map(a => a.quiz_score)) : null;
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-background pb-24">
        <Header title="Treinamentos" showBack />
        <div className="flex items-center justify-center pt-32">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </div>
        <BottomNav />
      </div>
    );
  }

  const passedCount = modules.filter(m => getCompletion(m.id)).length;
  const progressPercent = modules.length > 0 ? Math.round((passedCount / modules.length) * 100) : 0;

  // Sort: incomplete first (by highest reward), then completed
  const sortedModules = [...modules].sort((a, b) => {
    const aDone = !!getCompletion(a.id);
    const bDone = !!getCompletion(b.id);
    if (aDone !== bDone) return aDone ? 1 : -1;
    return b.points_reward - a.points_reward;
  });

  // Next recommended = first incomplete, highest reward
  const recommendedModule = sortedModules.find(m => !getCompletion(m.id)) || null;

  return (
    <div className="min-h-screen bg-background pb-24">
      <Header title="Treinamentos Técnicos" showBack />

      <main className="pt-16 px-4 max-w-lg mx-auto space-y-4">
        {/* Progress card */}
        <Card className="border-0 shadow-strong overflow-hidden">
          <div className="bg-gradient-dark text-secondary-foreground p-5">
            <div className="flex items-center gap-3 mb-3">
              <div className="w-12 h-12 rounded-xl bg-primary/20 flex items-center justify-center">
                <BookOpen className="w-6 h-6" />
              </div>
              <div>
                <h2 className="font-display font-bold text-lg">Educação Técnica</h2>
                <p className="text-xs text-secondary-foreground/60">Complete módulos e ganhe pontos no pilar Educação (15%)</p>
              </div>
            </div>
            <div className="flex justify-between text-sm mb-1">
              <span className="text-secondary-foreground/70">{passedCount} de {modules.length} concluídos</span>
              <span className="font-bold">{progressPercent}%</span>
            </div>
            <Progress value={progressPercent} className="h-2 bg-secondary-foreground/10" />
          </div>
        </Card>

        {/* Recommended next module */}
        {recommendedModule && (
          <Card className="border-primary/30 bg-primary/5">
            <CardContent className="p-4">
              <div className="flex items-center gap-2 mb-3">
                <Sparkles className="w-4 h-4 text-primary" />
                <span className="text-xs font-semibold text-primary uppercase tracking-wide">Próximo módulo recomendado</span>
              </div>
              <h3 className="font-semibold text-foreground mb-1">{recommendedModule.title}</h3>
              {recommendedModule.description && (
                <p className="text-xs text-muted-foreground mb-2">{recommendedModule.description}</p>
              )}
              <div className="flex gap-2 mb-3">
                <Badge variant="secondary" className="text-[10px]">
                  <Award className="w-3 h-3 mr-0.5" />{recommendedModule.points_reward} pts
                </Badge>
                <Badge variant="outline" className="text-[10px]">Mínimo {recommendedModule.min_score}%</Badge>
                <Badge variant="outline" className="text-[10px]">{recommendedModule.quiz_questions.length} perguntas</Badge>
              </div>
              {(() => {
                const best = getBestAttempt(recommendedModule.id);
                return best !== null ? (
                  <p className="text-xs text-muted-foreground mb-2">Melhor tentativa anterior: {best}%</p>
                ) : null;
              })()}
              <Button size="sm" className="w-full" onClick={() => startQuiz(recommendedModule)}>
                Iniciar módulo
                <ArrowRight className="w-4 h-4 ml-1" />
              </Button>
            </CardContent>
          </Card>
        )}

        {/* Module list */}
        {sortedModules.length > 0 && (
          <h3 className="font-display font-bold text-foreground text-sm pt-2">Todos os módulos</h3>
        )}
        {sortedModules.map(mod => {
          const completed = getCompletion(mod.id);
          const bestScore = getBestAttempt(mod.id);
          const isRecommended = recommendedModule?.id === mod.id;

          return (
            <Card key={mod.id} className={completed ? 'border-emerald-200 bg-emerald-50/30' : isRecommended ? 'ring-1 ring-primary/20' : ''}>
              <CardContent className="p-4">
                <div className="flex items-start gap-3">
                  <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${completed ? 'bg-emerald-100' : 'bg-primary/10'}`}>
                    {completed ? <CheckCircle2 className="w-5 h-5 text-emerald-600" /> : <BookOpen className="w-5 h-5 text-primary" />}
                  </div>
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <h3 className="font-semibold text-sm text-foreground">{mod.title}</h3>
                      {isRecommended && !completed && <Badge className="text-[9px] px-1.5 py-0">Recomendado</Badge>}
                    </div>
                    {mod.description && <p className="text-xs text-muted-foreground mt-0.5">{mod.description}</p>}
                    <div className="flex gap-2 mt-2">
                      <Badge variant="outline" className="text-[10px]">{mod.quiz_questions.length} perguntas</Badge>
                      <Badge variant="outline" className="text-[10px]">Mínimo {mod.min_score}%</Badge>
                      <Badge variant="secondary" className="text-[10px]">
                        <Award className="w-3 h-3 mr-0.5" />{mod.points_reward} pts
                      </Badge>
                    </div>
                    {bestScore !== null && !completed && (
                      <p className="text-xs text-muted-foreground mt-1">Melhor tentativa: {bestScore}%</p>
                    )}
                  </div>
                  <Button size="sm" variant={completed ? 'outline' : 'default'}
                    onClick={() => startQuiz(mod)} disabled={!!completed}>
                    {completed ? 'Concluído' : 'Iniciar'}
                  </Button>
                </div>
              </CardContent>
            </Card>
          );
        })}

        {modules.length === 0 && (
          <div className="text-center py-12 text-muted-foreground">
            <BookOpen className="w-12 h-12 mx-auto mb-3 opacity-30" />
            <p>Nenhum treinamento disponível no momento</p>
          </div>
        )}
      </main>

      {/* Quiz Dialog */}
      <Dialog open={!!activeModule} onOpenChange={(open) => { if (!open) setActiveModule(null); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-base">{activeModule?.title}</DialogTitle>
          </DialogHeader>

          {activeModule && !showResult && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">
                  Pergunta {currentQ + 1} de {activeModule.quiz_questions.length}
                </span>
                <Progress value={((currentQ + 1) / activeModule.quiz_questions.length) * 100} className="w-24 h-1.5" />
              </div>

              <p className="font-medium text-sm text-foreground">{activeModule.quiz_questions[currentQ].question}</p>

              <div className="space-y-2">
                {activeModule.quiz_questions[currentQ].options.map((opt, idx) => (
                  opt.trim() && (
                    <button key={idx}
                      onClick={() => selectAnswer(idx)}
                      className={`w-full text-left p-3 rounded-lg border text-sm transition-colors ${
                        answers[currentQ] === idx
                          ? 'border-primary bg-primary/5 text-foreground'
                          : 'border-border hover:border-primary/50 text-foreground'
                      }`}>
                      {opt}
                    </button>
                  )
                ))}
              </div>

              <div className="flex gap-2 justify-between">
                <Button variant="outline" size="sm" disabled={currentQ === 0}
                  onClick={() => setCurrentQ(prev => prev - 1)}>
                  Anterior
                </Button>
                {currentQ < activeModule.quiz_questions.length - 1 ? (
                  <Button size="sm" disabled={answers[currentQ] === null}
                    onClick={() => setCurrentQ(prev => prev + 1)}>
                    Próxima
                  </Button>
                ) : (
                  <Button size="sm" disabled={answers.some(a => a === null) || submitting}
                    onClick={submitQuiz}>
                    {submitting && <Loader2 className="w-4 h-4 mr-1 animate-spin" />}
                    Finalizar
                  </Button>
                )}
              </div>
            </div>
          )}

          {activeModule && showResult && (
            <div className="text-center space-y-3 py-4">
              {(() => {
                const totalQ = activeModule.quiz_questions.length;
                const correctCount = activeModule.quiz_questions.reduce((count, q, idx) => {
                  return count + (answers[idx] === q.correct ? 1 : 0);
                }, 0);
                const scorePercent = Math.round((correctCount / totalQ) * 100);
                const passed = scorePercent >= activeModule.min_score;

                return (
                  <>
                    {passed ? (
                      <CheckCircle2 className="w-16 h-16 text-emerald-500 mx-auto" />
                    ) : (
                      <XCircle className="w-16 h-16 text-destructive mx-auto" />
                    )}
                    <h3 className="text-lg font-bold text-foreground">
                      {passed ? 'Aprovado!' : 'Não aprovado'}
                    </h3>
                    <p className="text-3xl font-display font-bold text-foreground">{scorePercent}%</p>
                    <p className="text-sm text-muted-foreground">
                      {correctCount} de {totalQ} corretas (mínimo: {activeModule.min_score}%)
                    </p>
                    {passed && (
                      <Badge className="text-sm">
                        <Award className="w-4 h-4 mr-1" /> +{activeModule.points_reward} pontos de educação
                      </Badge>
                    )}
                    <Button className="w-full mt-2" onClick={() => setActiveModule(null)}>
                      Fechar
                    </Button>
                  </>
                );
              })()}
            </div>
          )}
        </DialogContent>
      </Dialog>

      <BottomNav />
    </div>
  );
};

export default Training;
