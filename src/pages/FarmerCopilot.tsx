import { useState, useCallback, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useScribe, CommitStrategy } from '@elevenlabs/react';
import { Header } from '@/components/Header';
import { BottomNav } from '@/components/BottomNav';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useAuth } from '@/contexts/AuthContext';
import { useCopilotEngine, type CopilotDirection, type CopilotPhase, type CopilotIntent } from '@/hooks/useCopilotEngine';
import { supabase } from '@/integrations/supabase/client';
import {
  Mic, MicOff, Radio, StopCircle, Lightbulb, Copy, Check,
  MessageSquare, Brain, Target, Shield, TrendingUp, TrendingDown,
  Minus, AlertTriangle, Loader2, ChevronRight, Phone
} from 'lucide-react';
import { useToast } from '@/hooks/use-toast';

// ─── Helpers ───────────────────────────────────────────────────────
const directionConfig: Record<CopilotDirection, { color: string; bg: string; icon: any; label: string }> = {
  positivo: { color: 'text-emerald-700', bg: 'bg-emerald-50 border-emerald-200', icon: TrendingUp, label: 'Positivo' },
  neutro: { color: 'text-amber-700', bg: 'bg-amber-50 border-amber-200', icon: Minus, label: 'Neutro' },
  risco: { color: 'text-red-700', bg: 'bg-red-50 border-red-200', icon: TrendingDown, label: 'Em Risco' },
};

const phaseLabels: Record<CopilotPhase, string> = {
  abertura: '🔵 Abertura',
  diagnostico: '🔍 Diagnóstico',
  exploracao: '🧭 Exploração',
  proposta: '💼 Proposta',
  fechamento: '🎯 Fechamento',
};

const intentLabels: Record<CopilotIntent, { label: string; color: string }> = {
  interesse: { label: 'Interesse', color: 'bg-emerald-100 text-emerald-800' },
  objecao_preco: { label: 'Objeção Preço', color: 'bg-red-100 text-red-800' },
  objecao_tecnica: { label: 'Objeção Técnica', color: 'bg-orange-100 text-orange-800' },
  falta_urgencia: { label: 'Falta Urgência', color: 'bg-amber-100 text-amber-800' },
  comparacao_concorrente: { label: 'Concorrente', color: 'bg-purple-100 text-purple-800' },
  indiferenca: { label: 'Indiferença', color: 'bg-muted text-muted-foreground' },
};

const suggestionTypeIcons: Record<string, any> = {
  pergunta_diagnostica: MessageSquare,
  resposta_tecnica: Brain,
  argumento_economico: Target,
  alternativa_abordagem: Shield,
};

const FarmerCopilot = () => {
  const navigate = useNavigate();
  const { user, isStaff } = useAuth();
  const { toast } = useToast();
  const copilot = useCopilotEngine();
  const [selectedCustomer, setSelectedCustomer] = useState<string>('');
  const [customers, setCustomers] = useState<{ id: string; name: string }[]>([]);
  const [isConnecting, setIsConnecting] = useState(false);
  const [copied, setCopied] = useState(false);
  const transcriptEndRef = useRef<HTMLDivElement>(null);

  // ElevenLabs realtime scribe
  const scribe = useScribe({
    modelId: 'scribe_v2_realtime',
    commitStrategy: CommitStrategy.VAD,
    onPartialTranscript: (data) => {
      if (data.text) copilot.addTranscript(data.text, true);
    },
    onCommittedTranscript: (data) => {
      if (data.text) copilot.addTranscript(data.text, false);
    },
  });

  // Load customers
  useEffect(() => {
    if (!user?.id || !isStaff) return;
    (async () => {
      const { data: scores } = await supabase
        .from('farmer_client_scores')
        .select('customer_user_id')
        .eq('farmer_id', user.id) as any;
      if (!scores?.length) return;
      const ids = scores.map((s: any) => s.customer_user_id);
      const { data: profiles } = await supabase
        .from('profiles')
        .select('user_id, name')
        .in('user_id', ids) as any;
      if (profiles) {
        setCustomers(profiles.map((p: any) => ({ id: p.user_id, name: p.name })));
      }
    })();
  }, [user, isStaff]);

  // Auto-scroll transcript
  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [copilot.transcript]);

  // Start recording
  const handleStart = useCallback(async () => {
    setIsConnecting(true);
    try {
      // Get scribe token
      const { data: tokenData, error: tokenError } = await supabase.functions.invoke('elevenlabs-scribe-token');
      if (tokenError || !tokenData?.token) throw new Error('Falha ao obter token de transcrição');

      // Get customer context
      let customerContext: any = null;
      let customerName = '';
      if (selectedCustomer) {
        const { data: score } = await supabase
          .from('farmer_client_scores')
          .select('*')
          .eq('customer_user_id', selectedCustomer)
          .eq('farmer_id', user!.id)
          .single() as any;

        const { data: profile } = await supabase
          .from('profiles')
          .select('name, customer_type, cnae')
          .eq('user_id', selectedCustomer)
          .single() as any;

        customerName = profile?.name || '';
        customerContext = {
          name: profile?.name,
          cnae: profile?.cnae,
          customerType: profile?.customer_type,
          healthScore: score?.health_score,
          avgMonthlySpend: score?.avg_monthly_spend_180d,
          grossMarginPct: score?.gross_margin_pct,
          categoryCount: score?.category_count,
          daysSinceLastPurchase: score?.days_since_last_purchase,
          churnRisk: score?.churn_risk,
        };
      }

      // Start copilot session
      await copilot.startSession({
        customerId: selectedCustomer || undefined,
        customerName: customerName || undefined,
        customerContext,
      });

      // Connect scribe
      await scribe.connect({
        token: tokenData.token,
        microphone: {
          echoCancellation: true,
          noiseSuppression: true,
        },
      });

      toast({ title: 'Copiloto ativado', description: 'Transcrição em tempo real iniciada' });
    } catch (err: any) {
      console.error('Start error:', err);
      toast({ variant: 'destructive', title: 'Erro', description: err.message || 'Falha ao iniciar copiloto' });
    } finally {
      setIsConnecting(false);
    }
  }, [selectedCustomer, user, copilot, scribe, toast]);

  // Stop recording
  const handleStop = useCallback(async () => {
    scribe.disconnect();
    await copilot.endSession();
    toast({ title: 'Sessão encerrada' });
  }, [scribe, copilot, toast]);

  // Copy suggestion
  const handleCopySuggestion = useCallback((text: string) => {
    navigator.clipboard.writeText(text);
    copilot.markSuggestionUsed(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [copilot]);

  if (!isStaff) { navigate('/', { replace: true }); return null; }

  const analysis = copilot.currentAnalysis;
  const dir = analysis ? directionConfig[analysis.direction] : null;
  const DirIcon = dir?.icon || Minus;
  const SugIcon = analysis ? (suggestionTypeIcons[analysis.suggestionType] || Lightbulb) : Lightbulb;

  return (
    <div className="min-h-screen bg-background pb-24">
      <Header title="Copiloto Comercial" showBack />

      <main className="px-4 py-4 space-y-3 max-w-lg mx-auto">
        {/* Session Controls */}
        {!copilot.isActive ? (
          <Card className="border-primary/20">
            <CardContent className="p-4 space-y-3">
              <div className="flex items-center gap-2 mb-1">
                <Radio className="w-5 h-5 text-primary" />
                <h2 className="text-sm font-bold">Iniciar Copiloto em Tempo Real</h2>
              </div>
              <p className="text-[10px] text-muted-foreground">
                O copiloto transcreve a ligação, detecta intenções e sugere a melhor ação em cada momento.
              </p>

              <Select value={selectedCustomer} onValueChange={setSelectedCustomer}>
                <SelectTrigger className="h-9 text-xs">
                  <SelectValue placeholder="Selecionar cliente (opcional)" />
                </SelectTrigger>
                <SelectContent>
                  {customers.map(c => (
                    <SelectItem key={c.id} value={c.id} className="text-xs">{c.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Button
                onClick={handleStart}
                disabled={isConnecting}
                className="w-full gap-2"
              >
                {isConnecting ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Mic className="w-4 h-4" />
                )}
                {isConnecting ? 'Conectando...' : 'Iniciar Transcrição'}
              </Button>
            </CardContent>
          </Card>
        ) : (
          <>
            {/* Active Session Header */}
            <Card className="bg-gradient-to-r from-primary/10 to-primary/5 border-primary/20">
              <CardContent className="p-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                    <span className="text-xs font-bold">AO VIVO</span>
                    {copilot.session?.customerName && (
                      <Badge variant="outline" className="text-[9px]">{copilot.session.customerName}</Badge>
                    )}
                  </div>
                  <Button size="sm" variant="destructive" onClick={handleStop} className="h-7 text-[10px] gap-1">
                    <StopCircle className="w-3 h-3" /> Encerrar
                  </Button>
                </div>
              </CardContent>
            </Card>

            {/* Direction Indicator */}
            {analysis && dir && (
              <Card className={`border ${dir.bg}`}>
                <CardContent className="p-3">
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center gap-2">
                      <DirIcon className={`w-5 h-5 ${dir.color}`} />
                      <span className={`text-sm font-bold ${dir.color}`}>{dir.label}</span>
                    </div>
                    <div className="flex gap-1">
                      <Badge className={intentLabels[analysis.intent]?.color || ''} variant="secondary">
                        {intentLabels[analysis.intent]?.label || analysis.intent}
                      </Badge>
                      <Badge variant="outline" className="text-[9px]">
                        {phaseLabels[analysis.phase] || analysis.phase}
                      </Badge>
                    </div>
                  </div>
                  {analysis.directionReasons.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-1">
                      {analysis.directionReasons.map((r, i) => (
                        <span key={i} className="text-[9px] text-muted-foreground">• {r}</span>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            )}

            {/* AI Suggestion */}
            {analysis?.suggestion && (
              <Card className="border-2 border-primary/30 bg-primary/5">
                <CardContent className="p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-start gap-2 flex-1">
                      <SugIcon className="w-4 h-4 text-primary mt-0.5 shrink-0" />
                      <div>
                        <p className="text-[10px] font-semibold text-primary mb-0.5">
                          {analysis.suggestionType === 'pergunta_diagnostica' ? 'Pergunta Sugerida' :
                           analysis.suggestionType === 'resposta_tecnica' ? 'Resposta Técnica' :
                           analysis.suggestionType === 'argumento_economico' ? 'Argumento Econômico' :
                           'Abordagem Alternativa'}
                        </p>
                        <p className="text-xs leading-relaxed">{analysis.suggestion}</p>
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 w-7 p-0 shrink-0"
                      onClick={() => handleCopySuggestion(analysis.suggestion)}
                    >
                      {copied ? <Check className="w-3 h-3 text-emerald-600" /> : <Copy className="w-3 h-3" />}
                    </Button>
                  </div>
                  <div className="flex items-center justify-between mt-2">
                    <span className="text-[9px] text-muted-foreground">
                      Confiança: {analysis.confidence}%
                    </span>
                    <span className="text-[9px] text-muted-foreground">
                      {copilot.suggestionsShown} sugestões • {copilot.suggestionsUsed} usadas
                    </span>
                  </div>
                </CardContent>
              </Card>
            )}

            {copilot.isAnalyzing && (
              <div className="flex items-center gap-2 justify-center py-1">
                <Loader2 className="w-3 h-3 animate-spin text-primary" />
                <span className="text-[10px] text-muted-foreground">Analisando...</span>
              </div>
            )}

            {/* Transcript */}
            <Card>
              <CardHeader className="p-3 pb-2">
                <CardTitle className="text-xs flex items-center gap-2">
                  <MessageSquare className="w-3 h-3" /> Transcrição
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <ScrollArea className="h-48 px-3 pb-3">
                  {copilot.transcript.length === 0 ? (
                    <p className="text-[10px] text-muted-foreground text-center py-8">
                      Aguardando fala...
                    </p>
                  ) : (
                    <div className="space-y-1">
                      {copilot.transcript.map(entry => (
                        <p
                          key={entry.id}
                          className={`text-xs leading-relaxed ${entry.isPartial ? 'text-muted-foreground italic' : ''}`}
                        >
                          {entry.text}
                        </p>
                      ))}
                      <div ref={transcriptEndRef} />
                    </div>
                  )}
                </ScrollArea>
              </CardContent>
            </Card>

            {/* Analysis History */}
            {copilot.analysisHistory.length > 1 && (
              <Card>
                <CardHeader className="p-3 pb-2">
                  <CardTitle className="text-xs flex items-center gap-2">
                    <Brain className="w-3 h-3" /> Histórico de Análises ({copilot.analysisHistory.length})
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-3 pt-0">
                  <div className="space-y-1.5">
                    {copilot.analysisHistory.slice(-5).reverse().map((a, i) => {
                      const d = directionConfig[a.direction];
                      return (
                        <div key={i} className="flex items-center gap-2 text-[9px]">
                          <div className={`w-2 h-2 rounded-full ${
                            a.direction === 'positivo' ? 'bg-emerald-500' :
                            a.direction === 'risco' ? 'bg-red-500' : 'bg-amber-500'
                          }`} />
                          <span className="font-medium">{intentLabels[a.intent]?.label}</span>
                          <span className="text-muted-foreground">→</span>
                          <span className="text-muted-foreground truncate flex-1">{a.suggestion.slice(0, 50)}...</span>
                        </div>
                      );
                    })}
                  </div>
                </CardContent>
              </Card>
            )}
          </>
        )}

        {/* Governance Notice */}
        <Card className="border-dashed">
          <CardContent className="p-3">
            <div className="flex items-start gap-2">
              <Shield className="w-4 h-4 text-muted-foreground mt-0.5" />
              <div>
                <p className="text-[10px] font-semibold text-muted-foreground">Governança</p>
                <p className="text-[9px] text-muted-foreground">
                  O copiloto apenas sugere — nenhuma resposta é enviada automaticamente ao cliente.
                  Mudanças estruturais requerem aprovação via CPF autorizado.
                </p>
              </div>
            </div>
          </CardContent>
        </Card>
      </main>

      <BottomNav />
    </div>
  );
};

export default FarmerCopilot;
