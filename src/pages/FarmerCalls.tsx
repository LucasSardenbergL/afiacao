import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';

import { Button } from '@/components/ui/button';
import { supabase } from '@/integrations/supabase/client';
import { eqText, orFilter, ilikeContainsPattern } from '@/lib/postgrest';
import { useAuth } from '@/contexts/AuthContext';
import { toast } from 'sonner';
import { useFarmerScoring, type AgendaItem } from '@/hooks/useFarmerScoring';
import { TranscriptionPanel } from '@/components/call/TranscriptionPanel';
import type { NvoipCallState } from '@/hooks/useNvoipCall';
import { useCallBackend } from '@/hooks/useCallBackend';
import { useWebRTCCall } from '@/hooks/useWebRTCCall';
import { Plus } from 'lucide-react';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { type Customer, type CallLog } from '@/components/farmer/calls/types';
import { TodayStatsCards } from '@/components/farmer/calls/TodayStatsCards';
import { AgendaQueueCard } from '@/components/farmer/calls/AgendaQueueCard';
import { CallListPanel } from '@/components/farmer/calls/CallListPanel';
import { NewCallDialog } from '@/components/farmer/calls/NewCallDialog';
import { useMyPositivacao } from '@/hooks/useMyPositivacao';
import { useMyCommercialRole } from '@/hooks/useMyCommercialRole';
import { useImpersonation } from '@/contexts/ImpersonationContext';
import { PositivacaoHero } from '@/components/farmer/PositivacaoHero';
import { ClientesAPositivarCard } from '@/components/farmer/ClientesAPositivarCard';
import { MixGapCard } from '@/components/farmer/MixGapCard';

/* ─── Main Page ─── */
const FarmerCalls = () => {
  const navigate = useNavigate();
  const { user, isStaff, loading: authLoading } = useAuth();
  const { agenda, clientScores, loading: agendaLoading } = useFarmerScoring();
  const { data: positivacao } = useMyPositivacao();
  const { data: commercialRole } = useMyCommercialRole();
  const isHunter = commercialRole === 'hunter';
  const { isImpersonating, effectiveUserId } = useImpersonation();

  // Real Nvoip call integration for the dialog timer
  const {
    callState: nvoipState,
    callDuration: nvoipDuration,
    makeCall: nvoipMakeCall,
    endCall: nvoipEndCall,
    isActive: nvoipIsActive,
    isConnecting: nvoipIsConnecting,
    isRinging: nvoipIsRinging,
    isEstablished: nvoipIsEstablished,
    error: nvoipError,
    backend: callBackend,
  } = useCallBackend();

  // Acesso direto ao WebRTCCallContext pra transcrição (só faz sentido em backend WebRTC)
  const webrtc = useWebRTCCall();
  const [transcriptionPanelOpen, setTranscriptionPanelOpen] = useState(true);



  const [isCallActive, setIsCallActive] = useState(false);
  const [isFollowUpActive, setIsFollowUpActive] = useState(false);
  const [callSeconds, setCallSeconds] = useState(0);
  const [followUpSeconds, setFollowUpSeconds] = useState(0);
  const callTimerRef = useRef<number | null>(null);
  const followUpTimerRef = useRef<number | null>(null);
  const callStartRef = useRef<Date | null>(null);

  const [showNewCall, setShowNewCall] = useState(false);
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  const [callType, setCallType] = useState<string>('follow_up');
  const [callResult, setCallResult] = useState<string>('contato_sucesso');
  const [attemptNumber, setAttemptNumber] = useState(1);
  const [notes, setNotes] = useState('');
  const [revenue, setRevenue] = useState('');
  const [margin, setMargin] = useState('');
  const [saving, setSaving] = useState(false);

  const [customerSearch, setCustomerSearch] = useState('');
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);

  const [callLogs, setCallLogs] = useState<CallLog[]>([]);
  const [loadingLogs, setLoadingLogs] = useState(true);
  const [selectedCall, setSelectedCall] = useState<CallLog | null>(null);
  const [filterType, setFilterType] = useState<string>('all');

  useEffect(() => {
    if (!authLoading && !isStaff) navigate('/', { replace: true });
  }, [authLoading, isStaff, navigate]);

  useEffect(() => {
    if (isStaff) loadCallLogs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isStaff, effectiveUserId]);

  useEffect(() => {
    return () => {
      if (callTimerRef.current) clearInterval(callTimerRef.current);
      if (followUpTimerRef.current) clearInterval(followUpTimerRef.current);
    };
  }, []);

  // Mirror real Nvoip call duration into the form's call timer
  useEffect(() => {
    if (nvoipIsActive || nvoipIsEstablished) {
      setCallSeconds(nvoipDuration);
    }
  }, [nvoipDuration, nvoipIsActive, nvoipIsEstablished]);

  // When Nvoip call ends, stop the active flag and pre-fill result
  useEffect(() => {
    const terminal: NvoipCallState[] = ['finished', 'noanswer', 'busy', 'failed', 'error'];
    if (terminal.includes(nvoipState) && isCallActive) {
      setIsCallActive(false);
      const map: Record<string, string> = {
        finished: 'contato_sucesso',
        noanswer: 'sem_resposta',
        busy: 'ocupado',
        failed: 'sem_resposta',
        error: 'numero_invalido',
      };
      if (map[nvoipState]) setCallResult(map[nvoipState]);
      setCallSeconds(nvoipDuration);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nvoipState]);

  const loadCallLogs = async () => {
    // Lente "Ver como": lista as ligações do ALVO (effectiveUserId), não as do master.
    if (!effectiveUserId) return;
    try {
      const { data } = await supabase
        .from('farmer_calls')
        .select('*')
        .eq('farmer_id', effectiveUserId)
        .order('created_at', { ascending: false })
        .limit(100);

      if (data) {
        const customerIds = [...new Set(data.map((c) => c.customer_user_id).filter((id): id is string => Boolean(id)))];
        const { data: profiles } = await supabase
          .from('profiles')
          .select('user_id, name')
          .in('user_id', customerIds);
        const nameMap = new Map(profiles?.map((p: { user_id: string; name: string | null }) => [p.user_id, p.name]) || []);
        setCallLogs(
          (data as CallLog[]).map(c => ({ ...c, customer_name: nameMap.get(c.customer_user_id) || 'Cliente' }))
        );
      }
    } catch (error) {
      console.error('Error loading call logs:', error);
    } finally {
      setLoadingLogs(false);
    }
  };

  // Guard de corrida: a resposta de uma busca ANTIGA (o Omie leva 1-3s) não
  // pode sobrescrever a lista da busca atual nem apagar o loading dela.
  const searchSeqRef = useRef(0);
  const searchCustomers = useCallback(async (query: string) => {
    if (query.length < 2) {
      // Invalida QUALQUER busca em voo (senão a resposta atrasada do Omie
      // passaria no guard e repovoaria a lista que o usuário acabou de limpar).
      searchSeqRef.current++;
      setCustomers([]);
      setSearchLoading(false);
      return;
    }
    const seq = ++searchSeqRef.current;
    setSearchLoading(true);
    try {
      // Local e Omie em PARALELO. Antes a cadeia era serial (Omie → mapping →
      // profiles): os perfis locais, instantâneos, ficavam presos atrás da
      // roundtrip ao ERP — agora aparecem assim que chegam e o merge com o
      // Omie completa depois.
      const namePat = ilikeContainsPattern(query);
      const localPromise = namePat
        ? supabase
            .from('profiles')
            .select('user_id, name, email, phone')
            .ilike('name', namePat)
            .limit(10)
        : null;
      const omiePromise = supabase.functions.invoke('omie-vendas-sync', {
        body: { action: 'listar_clientes', search: query },
      });

      const { data: localProfiles } = localPromise ? await localPromise : { data: null };
      const local: Customer[] = (localProfiles || []).map(p => ({
        user_id: p.user_id,
        name: p.name,
        email: p.email,
        phone: p.phone,
      }));
      if (seq === searchSeqRef.current && local.length > 0) setCustomers(local);

      const { data: omieData } = await omiePromise;
      const omieClientes = (omieData?.clientes || []) as Array<{
        codigo_cliente: number;
        razao_social?: string;
        nome_fantasia?: string;
        email?: string | null;
        telefone?: string | null;
        cnpj_cpf?: string | null;
      }>;

      // Resolve local user_id mappings in batch
      let mappingByCode: Record<number, string> = {};
      if (omieClientes.length > 0) {
        const codigos = omieClientes.map(c => c.codigo_cliente);
        // P0-B follow-up: a busca `listar_clientes` roda na conta OBEN (default do edge). Sem
        // empresa_omie o código OBEN colidiria com um código colacor do espelho e anexaria o
        // customer_user_id ERRADO. Fail-safe: 0 linhas oben hoje → sem mapa → cai no match por doc.
        const { data: mappings } = await supabase
          .from('omie_clientes')
          .select('user_id, omie_codigo_cliente')
          .eq('empresa_omie', 'oben')
          .in('omie_codigo_cliente', codigos);
        mappingByCode = Object.fromEntries((mappings || []).map(m => [m.omie_codigo_cliente, m.user_id]));
      }

      const omieMapped: Customer[] = omieClientes.map(c => ({
        user_id: mappingByCode[c.codigo_cliente] || '', // resolved on save if empty
        name: c.nome_fantasia || c.razao_social || 'Cliente',
        email: c.email || null,
        phone: c.telefone || null,
        omie_codigo_cliente: c.codigo_cliente,
        document: c.cnpj_cpf || null,
      }));

      // Merge dedupe: prefer Omie entries (richer), avoid duplicate user_ids
      const seenUserIds = new Set(omieMapped.filter(c => c.user_id).map(c => c.user_id));
      const merged = [
        ...omieMapped,
        ...local.filter(p => !seenUserIds.has(p.user_id)),
      ];

      if (seq === searchSeqRef.current) setCustomers(merged);
    } catch (error) {
      console.error('Customer search failed', error);
    } finally {
      if (seq === searchSeqRef.current) setSearchLoading(false);
    }
  }, []);

  useEffect(() => {
    const debounce = setTimeout(() => searchCustomers(customerSearch), 300);
    return () => clearTimeout(debounce);
  }, [customerSearch, searchCustomers]);

  const startCallTimer = async () => {
    // If we have a customer with phone, trigger real Nvoip call
    const phone = selectedCustomer?.phone;
    if (phone) {
      callStartRef.current = new Date();
      setIsCallActive(true);
      setCallSeconds(0);
      await nvoipMakeCall(phone);
      return;
    }
    // Fallback: manual stopwatch only
    setIsCallActive(true);
    callStartRef.current = new Date();
    callTimerRef.current = window.setInterval(() => setCallSeconds(s => s + 1), 1000);
  };
  const stopCallTimer = async () => {
    setIsCallActive(false);
    if (callTimerRef.current) { clearInterval(callTimerRef.current); callTimerRef.current = null; }
    // Hang up real Nvoip call if active
    if (nvoipIsActive) {
      await nvoipEndCall();
    }
  };
  const startFollowUpTimer = () => {
    setIsFollowUpActive(true);
    followUpTimerRef.current = window.setInterval(() => setFollowUpSeconds(s => s + 1), 1000);
  };
  const stopFollowUpTimer = () => {
    setIsFollowUpActive(false);
    if (followUpTimerRef.current) { clearInterval(followUpTimerRef.current); followUpTimerRef.current = null; }
  };

  const resetForm = () => {
    setSelectedCustomer(null); setCallType('follow_up'); setCallResult('contato_sucesso');
    setAttemptNumber(1); setNotes(''); setRevenue(''); setMargin('');
    setCallSeconds(0); setFollowUpSeconds(0); setIsCallActive(false); setIsFollowUpActive(false);
    setCustomerSearch(''); setCustomers([]); callStartRef.current = null;
    if (callTimerRef.current) clearInterval(callTimerRef.current);
    if (followUpTimerRef.current) clearInterval(followUpTimerRef.current);
  };

  const handleSaveCall = async () => {
    if (!selectedCustomer || !user) return;
    setSaving(true);
    try {
      stopCallTimer(); stopFollowUpTimer();

      // Resolve local user_id when the customer came from Omie without a mapping yet
      let customerUserId = selectedCustomer.user_id;
      if (!customerUserId && selectedCustomer.document) {
        const docClean = selectedCustomer.document.replace(/\D/g, '');
        const { data: profile } = await supabase
          .from('profiles')
          .select('user_id')
          .or(orFilter(eqText('document', docClean), eqText('document', selectedCustomer.document)))
          .limit(1)
          .maybeSingle();
        if (profile?.user_id) customerUserId = profile.user_id;
      }
      if (!customerUserId && selectedCustomer.omie_codigo_cliente) {
        // P0-B follow-up: o código veio da busca OBEN — resolve só contra a conta OBEN (código
        // colidente de colacor mapearia o user errado). 0 oben hoje → null → cai no aviso abaixo.
        const { data: mapping } = await supabase
          .from('omie_clientes')
          .select('user_id')
          .eq('omie_codigo_cliente', selectedCustomer.omie_codigo_cliente)
          .eq('empresa_omie', 'oben')
          .maybeSingle();
        if (mapping?.user_id) customerUserId = mapping.user_id;
      }
      if (!customerUserId) {
        toast.error('Cliente sem cadastro local', {
          description: 'Esse cliente Omie ainda não tem perfil no app. Crie um pedido primeiro para vinculá-lo.',
        });
        setSaving(false);
        return;
      }

      const { error } = await supabase.from('farmer_calls').insert({
        farmer_id: user.id, customer_user_id: customerUserId,
        call_type: callType,
        call_result: callResult,
        started_at: callStartRef.current?.toISOString() || new Date().toISOString(),
        ended_at: new Date().toISOString(),
        duration_seconds: callSeconds, follow_up_duration_seconds: followUpSeconds,
        attempt_number: attemptNumber, notes: notes || null,
        revenue_generated: parseFloat(revenue) || 0, margin_generated: parseFloat(margin) || 0,
      } as never);
      if (error) throw error;

      const rev = parseFloat(revenue) || 0;
      const noContactResults = ['sem_resposta', 'ocupado', 'caixa_postal', 'numero_invalido'];

      if (noContactResults.includes(callResult)) {
        toast.success('Registrado — tente novamente', {
          description: `Tentativa ${attemptNumber} anotada. Reagende para manter o contato ativo.`,
        });
      } else if (rev > 0) {
        toast.success(`🎯 Boa! ${rev.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })} gerados`, {
          description: 'Receita registrada com sucesso.',
        });
      } else {
        toast.success('Ligação registrada com sucesso');
      }

      resetForm(); setShowNewCall(false); loadCallLogs();
    } catch (error) {
      toast.error('Erro ao salvar ligação');
    } finally { setSaving(false); }
  };

  // Prefill the call form from an agenda item after a Dialer call ends
  const handleAgendaCallEnd = (
    item: AgendaItem,
    phone: string,
    data: { duration: number; state: string; audioLink: string | null },
  ) => {
    // Map Nvoip state to call_result
    const resultMap: Record<string, string> = {
      finished: 'contato_sucesso',
      noanswer: 'sem_resposta',
      busy: 'ocupado',
      failed: 'sem_resposta',
    };
    // Pre-fill the call form with Nvoip data
    const agendaCallType = item.agendaType === 'risco' ? 'reativacao' : item.agendaType === 'expansao' ? 'cross_sell' : 'follow_up';
    resetForm();
    setSelectedCustomer({ user_id: item.customer_user_id, name: item.customer_name, email: null, phone });
    setCallType(agendaCallType);
    setCallResult(resultMap[data.state] || 'contato_sucesso');
    setCallSeconds(data.duration);
    callStartRef.current = new Date(Date.now() - data.duration * 1000);
    setShowNewCall(true);
  };

  // Open the call form for an agenda item ("Registrar" button)
  const handleAgendaRegister = (item: AgendaItem, phone: string | null | undefined) => {
    const agendaCallType = item.agendaType === 'risco' ? 'reativacao' : item.agendaType === 'expansao' ? 'cross_sell' : 'follow_up';
    resetForm();
    setSelectedCustomer({ user_id: item.customer_user_id, name: item.customer_name, email: null, phone: phone || null });
    setCallType(agendaCallType);
    setShowNewCall(true);
  };

  // Stats
  const todayCalls = callLogs.filter(c => {
    const d = new Date(c.created_at);
    const now = new Date();
    return d.toDateString() === now.toDateString();
  });
  const todayRevenue = todayCalls.reduce((s, c) => s + Number(c.revenue_generated), 0);
  const avgDuration = todayCalls.length > 0 ? Math.round(todayCalls.reduce((s, c) => s + c.duration_seconds, 0) / todayCalls.length) : 0;

  // Memoizado: durante chamada ativa a página re-renderiza a 1Hz (cronômetro/nvoip).
  // Referência estável aqui + React.memo no CallListPanel blindam a lista de 100+
  // ligações desse tick — sem isto ela re-renderizava inteira a cada segundo.
  const filteredLogs = useMemo(
    () => (filterType === 'all' ? callLogs : callLogs.filter(c => c.call_type === filterType)),
    [callLogs, filterType],
  );

  if (authLoading) {
    // PageSkeleton (não Loader2 full-page): o Suspense da rota já mostrou um
    // skeleton — regredir pra spinner vazio fazia o layout sumir e voltar.
    return <PageSkeleton variant="cockpit" />;
  }

  return (
    <>
    <div className="space-y-4">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-semibold">Ligações</h1>
            <p className="text-sm text-muted-foreground">Registre e analise suas ligações</p>
          </div>
          <Button
            className="gap-1.5"
            onClick={() => { resetForm(); setShowNewCall(true); }}
            disabled={isImpersonating}
            title={isImpersonating ? 'Indisponível em modo Ver como' : undefined}
          >
            <Plus className="w-4 h-4" /> Nova ligação
          </Button>
        </div>

        {/* ─── Positivação da carteira (hero principal) ─── */}
        {positivacao && (
          <div className="space-y-3">
            <PositivacaoHero kpis={positivacao} isHunter={isHunter} />
            <ClientesAPositivarCard clientes={positivacao.aPositivar} />
            <MixGapCard />
          </div>
        )}

        {/* Atividade de hoje (secundário) */}
        <div className="space-y-1.5">
          <h2 className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">Atividade de hoje</h2>
          <TodayStatsCards count={todayCalls.length} revenue={todayRevenue} avgDuration={avgDuration} />
        </div>

        {/* ─── Agenda Queue ─── */}
        <AgendaQueueCard
          agenda={agenda}
          clientScores={clientScores}
          agendaLoading={agendaLoading}
          onCallEnd={handleAgendaCallEnd}
          onRegister={handleAgendaRegister}
        />

        {/* Call list + detail (Gong split) */}
        <CallListPanel
          filterType={filterType}
          setFilterType={setFilterType}
          filteredLogs={filteredLogs}
          loadingLogs={loadingLogs}
          selectedCall={selectedCall}
          setSelectedCall={setSelectedCall}
        />
      </div>

      {/* New Call Dialog */}
      <NewCallDialog
        open={showNewCall}
        onOpenChange={setShowNewCall}
        selectedCustomer={selectedCustomer}
        setSelectedCustomer={setSelectedCustomer}
        customerSearch={customerSearch}
        setCustomerSearch={setCustomerSearch}
        customers={customers}
        setCustomers={setCustomers}
        searchLoading={searchLoading}
        callType={callType}
        setCallType={setCallType}
        callResult={callResult}
        setCallResult={setCallResult}
        attemptNumber={attemptNumber}
        setAttemptNumber={setAttemptNumber}
        notes={notes}
        setNotes={setNotes}
        revenue={revenue}
        setRevenue={setRevenue}
        margin={margin}
        setMargin={setMargin}
        callSeconds={callSeconds}
        followUpSeconds={followUpSeconds}
        isCallActive={isCallActive}
        isFollowUpActive={isFollowUpActive}
        nvoipIsConnecting={nvoipIsConnecting}
        nvoipIsRinging={nvoipIsRinging}
        nvoipIsEstablished={nvoipIsEstablished}
        nvoipIsActive={nvoipIsActive}
        nvoipError={nvoipError}
        callBackend={callBackend}
        saving={saving}
        onStartCall={startCallTimer}
        onStopCall={stopCallTimer}
        onStartFollowUp={startFollowUpTimer}
        onStopFollowUp={stopFollowUpTimer}
        onSave={handleSaveCall}
      />

      {/* Painel lateral de transcrição ao vivo — só renderiza em chamadas WebRTC ativas */}
      {callBackend === 'webrtc' && webrtc.callState === 'established' && (
        <TranscriptionPanel
          status={webrtc.transcriptionStatus}
          turns={webrtc.transcriptionTurns}
          error={webrtc.transcriptionError}
          open={transcriptionPanelOpen}
          onClose={() => setTranscriptionPanelOpen(false)}
          spinStatus={webrtc.spinAnalysisStatus}
          spinAnalysis={webrtc.spinAnalysis}
          spinError={webrtc.spinAnalysisError}
        />
      )}

      {/* Botão pra reabrir o painel se vendedor fechou acidentalmente */}
      {callBackend === 'webrtc' && webrtc.callState === 'established' && !transcriptionPanelOpen && (
        <Button
          size="sm"
          variant="outline"
          className="fixed right-4 top-20 z-30 gap-1.5"
          onClick={() => setTranscriptionPanelOpen(true)}
        >
          Mostrar transcrição
        </Button>
      )}
    </>
  );
};

export default FarmerCalls;
