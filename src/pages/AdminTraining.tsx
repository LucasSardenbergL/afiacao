import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Header } from '@/components/Header';
import { BottomNav } from '@/components/BottomNav';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/hooks/use-toast';
import { Loader2, Plus, Trash2, BookOpen, Edit, GripVertical } from 'lucide-react';

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
  created_at: string;
}

const emptyQuestion: QuizQuestion = { question: '', options: ['', '', '', ''], correct: 0 };

const AdminTraining = () => {
  const navigate = useNavigate();
  const { isStaff, loading: authLoading, role } = useAuth();
  const { toast } = useToast();

  const [modules, setModules] = useState<TrainingModule[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  // Form state
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [videoUrl, setVideoUrl] = useState('');
  const [minScore, setMinScore] = useState(60);
  const [pointsReward, setPointsReward] = useState(15);
  const [isActive, setIsActive] = useState(true);
  const [questions, setQuestions] = useState<QuizQuestion[]>([{ ...emptyQuestion }]);

  useEffect(() => {
    if (!authLoading && role !== null && !isStaff) navigate('/', { replace: true });
  }, [authLoading, isStaff, role, navigate]);

  useEffect(() => {
    if (isStaff) loadModules();
  }, [isStaff]);

  const loadModules = async () => {
    const { data } = await supabase
      .from('training_modules')
      .select('*')
      .order('created_at', { ascending: false });
    setModules((data || []) as unknown as TrainingModule[]);
    setLoading(false);
  };

  const resetForm = () => {
    setEditingId(null);
    setTitle('');
    setDescription('');
    setVideoUrl('');
    setMinScore(60);
    setPointsReward(15);
    setIsActive(true);
    setQuestions([{ ...emptyQuestion }]);
  };

  const openEdit = (mod: TrainingModule) => {
    setEditingId(mod.id);
    setTitle(mod.title);
    setDescription(mod.description || '');
    setVideoUrl(mod.video_url || '');
    setMinScore(mod.min_score);
    setPointsReward(mod.points_reward);
    setIsActive(mod.is_active);
    setQuestions(mod.quiz_questions.length > 0 ? mod.quiz_questions : [{ ...emptyQuestion }]);
    setDialogOpen(true);
  };

  const handleSave = async () => {
    if (!title.trim()) {
      toast({ title: 'Título obrigatório', variant: 'destructive' });
      return;
    }
    const validQuestions = questions.filter(q => q.question.trim() && q.options.some(o => o.trim()));
    if (validQuestions.length === 0) {
      toast({ title: 'Adicione pelo menos uma pergunta válida', variant: 'destructive' });
      return;
    }

    setSaving(true);
    const payload = {
      title: title.trim(),
      description: description.trim() || null,
      video_url: videoUrl.trim() || null,
      min_score: minScore,
      points_reward: pointsReward,
      is_active: isActive,
      quiz_questions: JSON.parse(JSON.stringify(validQuestions)),
    };

    let error;
    if (editingId) {
      ({ error } = await supabase.from('training_modules').update(payload).eq('id', editingId));
    } else {
      ({ error } = await supabase.from('training_modules').insert(payload));
    }

    if (error) {
      toast({ title: 'Erro ao salvar', description: error.message, variant: 'destructive' });
    } else {
      toast({ title: editingId ? 'Módulo atualizado!' : 'Módulo criado!' });
      setDialogOpen(false);
      resetForm();
      loadModules();
    }
    setSaving(false);
  };

  const deleteModule = async (id: string) => {
    const { error } = await supabase.from('training_modules').delete().eq('id', id);
    if (!error) {
      toast({ title: 'Módulo excluído' });
      loadModules();
    }
  };

  const updateQuestion = (idx: number, field: keyof QuizQuestion, value: unknown) => {
    setQuestions(prev => prev.map((q, i) => i === idx ? { ...q, [field]: value } : q));
  };

  const updateOption = (qIdx: number, oIdx: number, value: string) => {
    setQuestions(prev => prev.map((q, i) => {
      if (i !== qIdx) return q;
      const opts = [...q.options];
      opts[oIdx] = value;
      return { ...q, options: opts };
    }));
  };

  if (authLoading || loading) {
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

  return (
    <div className="min-h-screen bg-background pb-24">
      <Header title="Gerenciar Treinamentos" showBack />

      <main className="pt-16 px-4 max-w-4xl mx-auto space-y-4">
        <div className="flex justify-between items-center">
          <p className="text-sm text-muted-foreground">{modules.length} módulo(s)</p>
          <Dialog open={dialogOpen} onOpenChange={(open) => { setDialogOpen(open); if (!open) resetForm(); }}>
            <DialogTrigger asChild>
              <Button size="sm"><Plus className="w-4 h-4 mr-1" /> Novo Módulo</Button>
            </DialogTrigger>
            <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>{editingId ? 'Editar Módulo' : 'Novo Módulo de Treinamento'}</DialogTitle>
              </DialogHeader>

              <div className="space-y-4">
                <div>
                  <Label>Título *</Label>
                  <Input value={title} onChange={e => setTitle(e.target.value)} placeholder="Ex: Cuidados com Serra Circular" />
                </div>
                <div>
                  <Label>Descrição</Label>
                  <Textarea value={description} onChange={e => setDescription(e.target.value)} placeholder="Breve descrição do módulo" />
                </div>
                <div>
                  <Label>URL do Vídeo (opcional)</Label>
                  <Input value={videoUrl} onChange={e => setVideoUrl(e.target.value)} placeholder="https://youtube.com/..." />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label>Nota mínima (%)</Label>
                    <Input type="number" min={0} max={100} value={minScore} onChange={e => setMinScore(Number(e.target.value))} />
                  </div>
                  <div>
                    <Label>Pontos de recompensa</Label>
                    <Input type="number" min={0} value={pointsReward} onChange={e => setPointsReward(Number(e.target.value))} />
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Switch checked={isActive} onCheckedChange={setIsActive} />
                  <Label>Ativo</Label>
                </div>

                {/* Quiz questions */}
                <div>
                  <Label className="text-base font-semibold">Perguntas do Quiz</Label>
                  <div className="space-y-4 mt-2">
                    {questions.map((q, qIdx) => (
                      <Card key={qIdx} className="p-3 space-y-2">
                        <div className="flex items-center gap-2">
                          <GripVertical className="w-4 h-4 text-muted-foreground" />
                          <span className="text-xs font-medium text-muted-foreground">Pergunta {qIdx + 1}</span>
                          {questions.length > 1 && (
                            <Button variant="ghost" size="sm" className="ml-auto h-6 w-6 p-0"
                              onClick={() => setQuestions(prev => prev.filter((_, i) => i !== qIdx))}>
                              <Trash2 className="w-3 h-3 text-destructive" />
                            </Button>
                          )}
                        </div>
                        <Input value={q.question} onChange={e => updateQuestion(qIdx, 'question', e.target.value)}
                          placeholder="Qual é a pergunta?" />
                        {q.options.map((opt, oIdx) => (
                          <div key={oIdx} className="flex items-center gap-2">
                            <input type="radio" name={`q-${qIdx}`} checked={q.correct === oIdx}
                              onChange={() => updateQuestion(qIdx, 'correct', oIdx)}
                              className="accent-primary" />
                            <Input value={opt} onChange={e => updateOption(qIdx, oIdx, e.target.value)}
                              placeholder={`Opção ${oIdx + 1}`} className="flex-1" />
                          </div>
                        ))}
                        <p className="text-[10px] text-muted-foreground">Selecione o radio da resposta correta</p>
                      </Card>
                    ))}
                  </div>
                  <Button variant="outline" size="sm" className="mt-2"
                    onClick={() => setQuestions(prev => [...prev, { ...emptyQuestion }])}>
                    <Plus className="w-3 h-3 mr-1" /> Adicionar Pergunta
                  </Button>
                </div>

                <Button className="w-full" onClick={handleSave} disabled={saving}>
                  {saving && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                  {editingId ? 'Salvar Alterações' : 'Criar Módulo'}
                </Button>
              </div>
            </DialogContent>
          </Dialog>
        </div>

        {modules.map(mod => (
          <Card key={mod.id}>
            <CardContent className="p-4">
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
                    <BookOpen className="w-5 h-5 text-primary" />
                  </div>
                  <div>
                    <h3 className="font-semibold text-foreground text-sm">{mod.title}</h3>
                    {mod.description && <p className="text-xs text-muted-foreground">{mod.description}</p>}
                    <div className="flex gap-2 mt-1">
                      <Badge variant={mod.is_active ? 'default' : 'secondary'} className="text-[10px]">
                        {mod.is_active ? 'Ativo' : 'Inativo'}
                      </Badge>
                      <Badge variant="outline" className="text-[10px]">
                        {(mod.quiz_questions || []).length} perguntas
                      </Badge>
                      <Badge variant="outline" className="text-[10px]">
                        {mod.points_reward} pts
                      </Badge>
                    </div>
                  </div>
                </div>
                <div className="flex gap-1">
                  <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={() => openEdit(mod)}>
                    <Edit className="w-4 h-4" />
                  </Button>
                  <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={() => deleteModule(mod.id)}>
                    <Trash2 className="w-4 h-4 text-destructive" />
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}

        {modules.length === 0 && (
          <div className="text-center py-12 text-muted-foreground">
            <BookOpen className="w-12 h-12 mx-auto mb-3 opacity-30" />
            <p>Nenhum módulo de treinamento criado</p>
          </div>
        )}
      </main>

      <BottomNav />
    </div>
  );
};

export default AdminTraining;
