// Lógica do copiloto de vendas (sessão, transcrição ElevenLabs, análise, PTPL).
// Extraída verbatim de src/pages/FarmerCopilot.tsx (god-component split).
import { useState, useCallback, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '@/contexts/AuthContext';
import { useImpersonation } from '@/contexts/ImpersonationContext';
import { useMyActiveCoverage } from '@/hooks/useCoverage';
import { useCopilotEngine, type CopilotContext } from '@/hooks/useCopilotEngine';
import { useTacticalPlan, type TacticalPlan } from '@/hooks/useTacticalPlan';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { Minus } from 'lucide-react';
import { directionConfig, suggestionTypeIcons, fallbackSuggestionIcon } from './config';
import type { InputMode } from './types';
import type { MotorVozScribeProps } from './MotorVozScribe';
import { margemConhecida } from '@/lib/scoring/margin';

export function useFarmerCopilot() {
  const navigate = useNavigate();
  const { user, isStaff } = useAuth();
  // Lente "Ver como": o dropdown de clientes da carteira segue o id efetivo (o ALVO na
  // lente, o próprio usuário fora). Iniciar a sessão (startSession persiste + invoca
  // edge) é write — bloqueado na lente pelo write-guard + botão "Iniciar" disabled.
  const { effectiveUserId, isImpersonating } = useImpersonation();
  // Cobertura: dropdown inclui clientes que EU cubro agora (paridade com useMyCarteiraScores).
  const { data: coverage } = useMyActiveCoverage();
  const coveredIds = (coverage ?? []).map((c) => c.covered_user_id);
  const coveredKey = coveredIds.join(',');
  const ownerIds = isImpersonating && effectiveUserId ? [effectiveUserId] : (user ? [user.id, ...coveredIds] : []);
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

  // Sessão de voz: token != null ⇒ a página monta o MotorVozScribe (React.lazy),
  // que embute o useScribe — o SDK ElevenLabs fica FORA deste chunk de página.
  const [scribeToken, setScribeToken] = useState<string | null>(null);

  // Load customers (dropdown da carteira — segue o id efetivo na lente)
  useEffect(() => {
    if (!ownerIds.length || !isStaff) return;
    (async () => {
      const { data: scores } = await supabase
        .from('farmer_client_scores')
        .select('customer_user_id')
        .in('farmer_id', ownerIds);
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
  }, [effectiveUserId, isStaff, coveredKey]);

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
        // Vai para o prompt da IA. `margemConhecida` garante null EXPLÍCITO (em vez de
        // undefined, que some do JSON, ou de uma string numérica): o modelo precisa
        // distinguir "margem 0%" de "margem não apurada" para não sugerir desconto nem
        // discurso de rentabilidade em cima de um número que ninguém mediu.
        // Unidade: PERCENTUAL 0-100.
        grossMarginPct: margemConhecida(score?.gross_margin_pct),
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
      // Chunk do motor de voz (SDK ElevenLabs) baixa em PARALELO ao roundtrip do
      // token; o branch com catch noop evita unhandled rejection se o fluxo
      // falhar antes do await dele.
      const motorPromise = import('./MotorVozScribe');
      motorPromise.catch(() => {});

      const { data: tokenData, error: tokenError } = await supabase.functions.invoke('elevenlabs-scribe-token');
      if (tokenError || !tokenData?.token) throw new Error('Falha ao obter token de transcrição');

      const { customerContext, customerName, bundleContext } = await prepareSessionContext();

      await copilot.startSession({
        customerId: selectedCustomer || undefined,
        customerName: customerName || undefined,
        customerContext: customerContext ?? undefined,
        bundleContext,
      });

      // Garante o chunk baixado ANTES de montar; falha cai no catch (modo texto).
      await motorPromise;
      // Monta o motor → connect acontece no mount; o toast de "Copiloto ativado"
      // sai no onConnected (conexão real), como antes saía após o connect.
      setScribeToken(tokenData.token);
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
  }, [selectedCustomer, copilot, prepareSessionContext]);

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
    setScribeToken(null); // desmonta o motor de voz → cleanup desconecta o scribe
    await copilot.endSession();
    toast.success('Sessão encerrada');
  }, [copilot]);

  // Copy suggestion
  const handleCopySuggestion = useCallback((text: string) => {
    navigator.clipboard.writeText(text);
    copilot.markSuggestionUsed(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [copilot]);

  // Props do motor de voz montado pela página (null = sem sessão de voz).
  const handleScribePartial = useCallback((text: string) => copilot.addTranscript(text, true), [copilot]);
  const handleScribeCommitted = useCallback((text: string) => copilot.addTranscript(text, false), [copilot]);
  const handleScribeConnected = useCallback(() => {
    toast.success('Copiloto ativado', { description: 'Transcrição em tempo real iniciada' });
  }, []);
  const handleScribeError = useCallback((err: unknown) => {
    console.error('Scribe error:', err);
    setScribeToken(null);
    setInputMode('text');
    toast.error('Voz indisponível', {
      description: 'Transcrição por voz falhou. Modo texto ativado automaticamente.',
    });
  }, []);
  const motorVozProps: MotorVozScribeProps | null = scribeToken
    ? {
        token: scribeToken,
        onPartialTranscript: handleScribePartial,
        onCommittedTranscript: handleScribeCommitted,
        onConnected: handleScribeConnected,
        onError: handleScribeError,
      }
    : null;

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
    motorVozProps,
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
