// Lógica do copiloto de vendas (sessão, transcrição ElevenLabs, análise, PTPL).
// Extraída verbatim de src/pages/FarmerCopilot.tsx (god-component split).
import { useState, useCallback, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useScribe, CommitStrategy } from '@elevenlabs/react';
import { useAuth } from '@/contexts/AuthContext';
import { useImpersonation } from '@/contexts/ImpersonationContext';
import { useCopilotEngine, type CopilotContext } from '@/hooks/useCopilotEngine';
import { useTacticalPlan, type TacticalPlan } from '@/hooks/useTacticalPlan';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { Minus } from 'lucide-react';
import { directionConfig, suggestionTypeIcons, fallbackSuggestionIcon } from './config';
import type { InputMode } from './types';

export function useFarmerCopilot() {
  const navigate = useNavigate();
  const { user, isStaff } = useAuth();
  // Lente "Ver como": o dropdown de clientes da carteira segue o id efetivo (o ALVO na
  // lente, o próprio usuário fora). Iniciar a sessão (startSession persiste + invoca
  // edge) é write — bloqueado na lente pelo write-guard + botão "Iniciar" disabled.
  const { effectiveUserId, isImpersonating } = useImpersonation();
  const copilot = useCopilotEngine();
  const { getActivePlan } = useTacticalPlan();
  const [selectedCustomer, setSelectedCustomer] = useState<string>('');
  const [customers, setCustomers] = useState<{ id: string; name: string }[]>([]);
  const [isConnecting, setIsConnecting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [activePlan, setActivePlan] = useState<TacticalPlan | null>(null);
  const [showPlan, setShowPlan] = useState(false);
  const transcriptEndRef = useRef<HTMLDivElement>(null);

  // Text mode state
  const [inputMode, setInputMode] = useState<InputMode>('voice');
  const [manualText, setManualText] = useState('');
  const [isManualAnalyzing, setIsManualAnalyzing] = useState(false);
  const [riskFlash, setRiskFlash] = useState(false);

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

  // Load customers (dropdown da carteira — segue o id efetivo na lente)
  useEffect(() => {
    if (!effectiveUserId || !isStaff) return;
    (async () => {
      const { data: scores } = await supabase
        .from('farmer_client_scores')
        .select('customer_user_id')
        .eq('farmer_id', effectiveUserId);
      if (!scores?.length) return;
      const ids = scores.map((s) => s.customer_user_id).filter((id): id is string => id !== null);
      const { data: profiles } = await supabase
        .from('profiles')
        .select('user_id, name')
        .in('user_id', ids);
      if (profiles) {
        setCustomers(profiles.map((p) => ({ id: p.user_id, name: p.name ?? '' })));
      }
    })();
  }, [effectiveUserId, isStaff]);

  // Auto-scroll transcript
  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [copilot.transcript]);

  // Flash risk highlight when direction changes to 'risco'
  useEffect(() => {
    if (copilot.currentAnalysis?.direction === 'risco') {
      setRiskFlash(true);
      const timer = setTimeout(() => setRiskFlash(false), 2500);
      return () => clearTimeout(timer);
    }
  }, [copilot.currentAnalysis]);

  // Shared session start logic (reused by both modes)
  const prepareSessionContext = useCallback(async () => {
    let customerContext: Record<string, unknown> | null = null;
    let customerName = '';
    let bundleContext: CopilotContext | undefined = undefined;

    if (selectedCustomer) {
      // Opção A: 1 linha por cliente; sem filtro de farmer_id — o dropdown segue effectiveUserId,
      // mas o score é único por cliente, e filtrar por user.id quebrava sob a lente. RLS gateia.
      const { data: score } = await supabase
        .from('farmer_client_scores')
        .select('*')
        .eq('customer_user_id', selectedCustomer)
        .single();

      const { data: profile } = await supabase
        .from('profiles')
        .select('name, customer_type, cnae')
        .eq('user_id', selectedCustomer)
        .single();

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

      const plan = await getActivePlan(selectedCustomer);
      if (plan) {
        setActivePlan(plan);
        setShowPlan(true);
        toast.success('PTPL carregado', { description: `Plano ${plan.planType} ativo para ${plan.customerName}` });
        bundleContext = plan.topBundle;
        if (customerContext) {
          customerContext.activePlan = {
            objective: plan.strategicObjective,
            profile: plan.customerProfile,
            approachStrategy: plan.approachStrategy,
            diagnosticQuestions: plan.diagnosticQuestions,
          };
        }
      } else {
        setActivePlan(null);
      }
    }

    return { customerContext, customerName, bundleContext };
  }, [selectedCustomer, getActivePlan]);

  // Start voice recording
  const handleStartVoice = useCallback(async () => {
    setIsConnecting(true);
    try {
      const { data: tokenData, error: tokenError } = await supabase.functions.invoke('elevenlabs-scribe-token');
      if (tokenError || !tokenData?.token) throw new Error('Falha ao obter token de transcrição');

      const { customerContext, customerName, bundleContext } = await prepareSessionContext();

      await copilot.startSession({
        customerId: selectedCustomer || undefined,
        customerName: customerName || undefined,
        customerContext: customerContext ?? undefined,
        bundleContext,
      });

      await scribe.connect({
        token: tokenData.token,
        microphone: {
          echoCancellation: true,
          noiseSuppression: true,
        },
      });

      toast.success('Copiloto ativado', { description: 'Transcrição em tempo real iniciada' });
    } catch (err) {
      console.error('Start error:', err);
      // Auto-fallback to text mode
      setInputMode('text');
      toast.error('Voz indisponível', {
        description: 'Transcrição por voz falhou. Modo texto ativado automaticamente.',
      });
    } finally {
      setIsConnecting(false);
    }
  }, [selectedCustomer, copilot, scribe, prepareSessionContext]);

  // Start text mode session
  const handleStartText = useCallback(async () => {
    setIsConnecting(true);
    try {
      const { customerContext, customerName, bundleContext } = await prepareSessionContext();

      await copilot.startSession({
        customerId: selectedCustomer || undefined,
        customerName: customerName || undefined,
        customerContext: customerContext ?? undefined,
        bundleContext,
      });

      toast.success('Copiloto ativado', { description: 'Modo texto — cole ou digite trechos da conversa' });
    } catch (err) {
      console.error('Start error:', err);
      const message = err instanceof Error ? err.message : 'Falha ao iniciar copiloto';
      toast.error('Erro', { description: message });
    } finally {
      setIsConnecting(false);
    }
  }, [selectedCustomer, copilot, prepareSessionContext]);

  // Unified start handler
  const handleStart = useCallback(async () => {
    if (inputMode === 'voice') {
      await handleStartVoice();
    } else {
      await handleStartText();
    }
  }, [inputMode, handleStartVoice, handleStartText]);

  // Analyze manual text — reuses same pipeline
  const handleAnalyzeManualText = useCallback(async () => {
    if (!manualText.trim() || manualText.trim().length < 10) {
      toast.error('Texto curto', { description: 'Digite pelo menos 10 caracteres para análise.' });
      return;
    }
    setIsManualAnalyzing(true);
    // Feed text into the same transcript pipeline
    copilot.addTranscript(manualText.trim(), false);
    // Trigger analysis using the existing engine
    await copilot.triggerAnalysis();
    setManualText('');
    setIsManualAnalyzing(false);
  }, [manualText, copilot]);

  // Stop recording
  const handleStop = useCallback(async () => {
    if (inputMode === 'voice') {
      scribe.disconnect();
    }
    await copilot.endSession();
    toast.success('Sessão encerrada');
  }, [scribe, copilot, inputMode]);

  // Copy suggestion
  const handleCopySuggestion = useCallback((text: string) => {
    navigator.clipboard.writeText(text);
    copilot.markSuggestionUsed(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [copilot]);

  const analysis = copilot.currentAnalysis;
  const dir = analysis ? directionConfig[analysis.direction] : null;
  const DirIcon = dir?.icon || Minus;
  const SugIcon = analysis ? (suggestionTypeIcons[analysis.suggestionType] || fallbackSuggestionIcon) : fallbackSuggestionIcon;

  return {
    navigate,
    isStaff,
    isImpersonating,
    userId: user?.id ?? null,
    copilot,
    selectedCustomer,
    setSelectedCustomer,
    customers,
    isConnecting,
    copied,
    activePlan,
    showPlan,
    setShowPlan,
    inputMode,
    setInputMode,
    manualText,
    setManualText,
    isManualAnalyzing,
    riskFlash,
    transcriptEndRef,
    handleStart,
    handleStop,
    handleAnalyzeManualText,
    handleCopySuggestion,
    analysis,
    dir,
    DirIcon,
    SugIcon,
  };
}
