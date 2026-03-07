import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Separator } from '@/components/ui/separator';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/hooks/use-toast';
import { useFarmerScoring } from '@/hooks/useFarmerScoring';
import { cn } from '@/lib/utils';
import {
  Phone, PhoneOff, Play, Pause, Clock, User, Search,
  Plus, Timer, CheckCircle, XCircle, Loader2, BarChart3,
  ArrowUpRight, DollarSign, Activity, Filter, FileText,
  Mic, StopCircle, MessageSquare, ChevronRight,
  PhoneCall, AlertTriangle, TrendingUp, RotateCcw,
} from 'lucide-react';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';

/* ─── Types ─── */
interface Customer {
  user_id: string;
  name: string;
  email: string | null;
  phone: string | null;
}

interface CallLog {
  id: string;
  customer_user_id: string;
  call_type: string;
  call_result: string;
  duration_seconds: number;
  follow_up_duration_seconds: number;
  attempt_number: number;
  revenue_generated: number;
  margin_generated: number;
  notes: string | null;
  created_at: string;
  customer_name?: string;
}

const CALL_TYPES = [
  { value: 'reativacao', label: 'Reativação', color: 'status-danger' },
  { value: 'cross_sell', label: 'Cross-sell', color: 'status-progress' },
  { value: 'up_sell', label: 'Up-sell', color: 'bg-purple-50 text-purple-700 border-purple-200' },
  { value: 'follow_up', label: 'Follow-up', color: 'status-pending' },
];

const CALL_RESULTS = [
  { value: 'contato_sucesso', label: 'Contato com Sucesso', icon: '✅' },
  { value: 'sem_resposta', label: 'Sem Resposta', icon: '📵' },
  { value: 'ocupado', label: 'Ocupado', icon: '🔴' },
  { value: 'caixa_postal', label: 'Caixa Postal', icon: '📩' },
  { value: 'numero_invalido', label: 'Número Inválido', icon: '❌' },
  { value: 'reagendado', label: 'Reagendado', icon: '📅' },
];

const fmt = (v: number) => v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

/* ─── Call Detail Panel (Gong-inspired) ─── */
function CallDetailPanel({ call, onClose }: { call: CallLog; onClose: () => void }) {
  const typeInfo = CALL_TYPES.find(t => t.value === call.call_type);
  const resultInfo = CALL_RESULTS.find(r => r.value === call.call_result);
  
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-foreground">{call.customer_name}</h3>
        <span className="text-xs text-muted-foreground">
          {format(new Date(call.created_at), "dd/MM/yy 'às' HH:mm", { locale: ptBR })}
        </span>
      </div>

      <div className="flex items-center gap-2">
        <Badge variant="outline" className={cn('text-[10px]', typeInfo?.color)}>
          {typeInfo?.label}
        </Badge>
        <Badge variant="outline" className="text-[10px]">
          {resultInfo?.icon} {resultInfo?.label}
        </Badge>
        {call.attempt_number > 1 && (
          <Badge variant="secondary" className="text-[10px]">#{call.attempt_number}</Badge>
        )}
      </div>

      {/* Timeline / Player area (Gong-style) */}
      <Card className="bg-muted/30">
        <CardContent className="p-4">
          <div className="flex items-center justify-center gap-6">
            <div className="text-center">
              <p className="text-2xl font-mono font-bold">{formatTimer(call.duration_seconds)}</p>
              <p className="text-[10px] text-muted-foreground mt-0.5">Duração da ligação</p>
            </div>
            {call.follow_up_duration_seconds > 0 && (
              <>
                <Separator orientation="vertical" className="h-10" />
                <div className="text-center">
                  <p className="text-2xl font-mono font-bold">{formatTimer(call.follow_up_duration_seconds)}</p>
                  <p className="text-[10px] text-muted-foreground mt-0.5">Follow-up</p>
                </div>
              </>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Metrics */}
      {(call.revenue_generated > 0 || call.margin_generated > 0) && (
        <div className="grid grid-cols-2 gap-3">
          <Card>
            <CardContent className="p-3 text-center">
              <DollarSign className="w-4 h-4 mx-auto text-muted-foreground mb-1" />
              <p className="text-sm font-bold">{fmt(call.revenue_generated)}</p>
              <p className="text-[10px] text-muted-foreground">Receita gerada</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-3 text-center">
              <ArrowUpRight className="w-4 h-4 mx-auto text-muted-foreground mb-1" />
              <p className="text-sm font-bold">{fmt(call.margin_generated)}</p>
              <p className="text-[10px] text-muted-foreground">Margem gerada</p>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Transcript placeholder */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
            <FileText className="w-3.5 h-3.5" /> Transcrição
          </CardTitle>
        </CardHeader>
        <CardContent>
          {call.notes ? (
            <p className="text-sm text-foreground whitespace-pre-wrap">{call.notes}</p>
          ) : (
            <div className="text-center py-6">
              <Mic className="w-6 h-6 mx-auto mb-2 text-muted-foreground/40" />
              <p className="text-xs text-muted-foreground">Nenhuma transcrição disponível</p>
              <p className="text-[10px] text-muted-foreground mt-0.5">Use o Copilot para transcrever em tempo real.</p>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Next steps placeholder */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Próximos passos</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground">Nenhum próximo passo registrado.</p>
        </CardContent>
      </Card>
    </div>
  );
}

function formatTimer(secs: number) {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/* ─── Main Page ─── */
const AGENDA_TYPE_META: Record<string, { label: string; icon: typeof AlertTriangle; color: string }> = {
  risco: { label: 'Risco', icon: AlertTriangle, color: 'text-destructive bg-destructive/10 border-destructive/20' },
  expansao: { label: 'Expansão', icon: TrendingUp, color: 'text-primary bg-primary/10 border-primary/20' },
  follow_up: { label: 'Follow-up', icon: RotateCcw, color: 'text-amber-600 bg-amber-50 border-amber-200' },
};

const FarmerCalls = () => {
  const navigate = useNavigate();
  const { user, isStaff, loading: authLoading } = useAuth();
  const { toast } = useToast();
  const { agenda, clientScores, loading: agendaLoading } = useFarmerScoring();

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
  }, [isStaff]);

  useEffect(() => {
    return () => {
      if (callTimerRef.current) clearInterval(callTimerRef.current);
      if (followUpTimerRef.current) clearInterval(followUpTimerRef.current);
    };
  }, []);

  const loadCallLogs = async () => {
    try {
      const { data } = await supabase
        .from('farmer_calls')
        .select('*')
        .eq('farmer_id', user?.id)
        .order('created_at', { ascending: false })
        .limit(100);

      if (data) {
        const customerIds = [...new Set(data.map((c: any) => c.customer_user_id))];
        const { data: profiles } = await supabase
          .from('profiles')
          .select('user_id, name')
          .in('user_id', customerIds);
        const nameMap = new Map(profiles?.map((p: any) => [p.user_id, p.name]) || []);
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

  const searchCustomers = useCallback(async (query: string) => {
    if (query.length < 2) { setCustomers([]); return; }
    setSearchLoading(true);
    try {
      const { data } = await supabase.from('profiles').select('user_id, name, email, phone').ilike('name', `%${query}%`).limit(10);
      setCustomers((data || []) as Customer[]);
    } catch (error) { console.error(error); }
    finally { setSearchLoading(false); }
  }, []);

  useEffect(() => {
    const debounce = setTimeout(() => searchCustomers(customerSearch), 300);
    return () => clearTimeout(debounce);
  }, [customerSearch, searchCustomers]);

  const startCallTimer = () => {
    setIsCallActive(true);
    callStartRef.current = new Date();
    callTimerRef.current = window.setInterval(() => setCallSeconds(s => s + 1), 1000);
  };
  const stopCallTimer = () => {
    setIsCallActive(false);
    if (callTimerRef.current) { clearInterval(callTimerRef.current); callTimerRef.current = null; }
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
      const { error } = await supabase.from('farmer_calls').insert({
        farmer_id: user.id, customer_user_id: selectedCustomer.user_id,
        call_type: callType as any, call_result: callResult as any,
        started_at: callStartRef.current?.toISOString() || new Date().toISOString(),
        ended_at: new Date().toISOString(),
        duration_seconds: callSeconds, follow_up_duration_seconds: followUpSeconds,
        attempt_number: attemptNumber, notes: notes || null,
        revenue_generated: parseFloat(revenue) || 0, margin_generated: parseFloat(margin) || 0,
      } as any);
      if (error) throw error;
      toast({ title: 'Ligação registrada!' });
      resetForm(); setShowNewCall(false); loadCallLogs();
    } catch (error) {
      toast({ title: 'Erro ao salvar ligação', variant: 'destructive' });
    } finally { setSaving(false); }
  };

  // Stats
  const todayCalls = callLogs.filter(c => {
    const d = new Date(c.created_at);
    const now = new Date();
    return d.toDateString() === now.toDateString();
  });
  const todayRevenue = todayCalls.reduce((s, c) => s + Number(c.revenue_generated), 0);
  const avgDuration = todayCalls.length > 0 ? Math.round(todayCalls.reduce((s, c) => s + c.duration_seconds, 0) / todayCalls.length) : 0;

  const filteredLogs = filterType === 'all' ? callLogs : callLogs.filter(c => c.call_type === filterType);

  if (authLoading) {
    return <div className="flex items-center justify-center py-32"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>;
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
          <Button className="gap-1.5" onClick={() => { resetForm(); setShowNewCall(true); }}>
            <Plus className="w-4 h-4" /> Nova ligação
          </Button>
        </div>

        {/* Today's stats */}
        <div className="grid grid-cols-3 gap-3">
          <Card><CardContent className="p-3 text-center">
            <Phone className="w-4 h-4 mx-auto text-muted-foreground mb-1" />
            <p className="text-lg font-bold">{todayCalls.length}</p>
            <p className="text-[10px] text-muted-foreground">Ligações hoje</p>
          </CardContent></Card>
          <Card><CardContent className="p-3 text-center">
            <DollarSign className="w-4 h-4 mx-auto text-muted-foreground mb-1" />
            <p className="text-lg font-bold">{fmt(todayRevenue)}</p>
            <p className="text-[10px] text-muted-foreground">Receita hoje</p>
          </CardContent></Card>
          <Card><CardContent className="p-3 text-center">
            <Clock className="w-4 h-4 mx-auto text-muted-foreground mb-1" />
            <p className="text-lg font-bold">{formatTimer(avgDuration)}</p>
            <p className="text-[10px] text-muted-foreground">Duração média</p>
          </CardContent></Card>
        </div>

        {/* Call list + detail (Gong split) */}
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
          {/* Call List */}
          <div className={cn('space-y-2', selectedCall ? 'lg:col-span-2' : 'lg:col-span-5')}>
            {/* Filters */}
            <div className="flex items-center gap-2">
              <Select value={filterType} onValueChange={setFilterType}>
                <SelectTrigger className="h-8 w-auto text-xs">
                  <Filter className="w-3 h-3 mr-1" />
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Todos os tipos</SelectItem>
                  {CALL_TYPES.map(t => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}
                </SelectContent>
              </Select>
              <span className="text-xs text-muted-foreground ml-auto">{filteredLogs.length} ligações</span>
            </div>

            {loadingLogs ? (
              <div className="flex justify-center py-12"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>
            ) : filteredLogs.length === 0 ? (
              <Card><CardContent className="py-12 text-center">
                <Phone className="w-8 h-8 mx-auto mb-2 text-muted-foreground/40" />
                <p className="text-sm text-muted-foreground">Nenhuma ligação registrada</p>
              </CardContent></Card>
            ) : (
              filteredLogs.map(log => {
                const typeInfo = CALL_TYPES.find(t => t.value === log.call_type);
                const resultInfo = CALL_RESULTS.find(r => r.value === log.call_result);
                const isSelected = selectedCall?.id === log.id;

                return (
                  <Card key={log.id} className={cn('cursor-pointer transition-colors hover:border-primary/30', isSelected && 'border-primary ring-1 ring-primary/20')}
                    onClick={() => setSelectedCall(isSelected ? null : log)}>
                    <CardContent className="p-3">
                      <div className="flex items-start justify-between">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            <p className="text-sm font-medium truncate">{log.customer_name}</p>
                            <Badge variant="outline" className={cn('text-[10px] shrink-0', typeInfo?.color)}>
                              {typeInfo?.label}
                            </Badge>
                          </div>
                          <div className="flex items-center gap-2 text-xs text-muted-foreground">
                            <span>{resultInfo?.icon} {resultInfo?.label}</span>
                            <span>·</span>
                            <span><Clock className="w-3 h-3 inline mr-0.5" />{formatTimer(log.duration_seconds)}</span>
                          </div>
                          {Number(log.revenue_generated) > 0 && (
                            <p className="text-xs font-medium mt-1 status-success inline-block px-1.5 py-0.5 rounded">
                              {fmt(Number(log.revenue_generated))}
                            </p>
                          )}
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <span className="text-xs text-muted-foreground">
                            {format(new Date(log.created_at), 'dd/MM HH:mm', { locale: ptBR })}
                          </span>
                          <ChevronRight className="w-3.5 h-3.5 text-muted-foreground" />
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                );
              })
            )}
          </div>

          {/* Detail panel (Gong-style) */}
          {selectedCall && (
            <div className="lg:col-span-3">
              <Card>
                <CardContent className="p-4">
                  <CallDetailPanel call={selectedCall} onClose={() => setSelectedCall(null)} />
                </CardContent>
              </Card>
            </div>
          )}
        </div>
      </div>

      {/* New Call Dialog */}
      <Dialog open={showNewCall} onOpenChange={setShowNewCall}>
        <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Phone className="w-5 h-5" /> Registrar ligação
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            {/* Customer Search */}
            <div>
              <label className="text-sm font-medium">Cliente</label>
              {selectedCustomer ? (
                <div className="flex items-center justify-between bg-muted/50 rounded-lg p-3 mt-1">
                  <div>
                    <p className="text-sm font-medium">{selectedCustomer.name}</p>
                    <p className="text-xs text-muted-foreground">{selectedCustomer.phone || selectedCustomer.email}</p>
                  </div>
                  <Button size="sm" variant="ghost" onClick={() => setSelectedCustomer(null)}>
                    <XCircle className="w-4 h-4" />
                  </Button>
                </div>
              ) : (
                <div className="mt-1">
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                    <Input placeholder="Buscar cliente..." value={customerSearch} onChange={e => setCustomerSearch(e.target.value)} className="pl-9 h-9" />
                  </div>
                  {searchLoading && <div className="flex justify-center py-2"><Loader2 className="w-4 h-4 animate-spin" /></div>}
                  {customers.length > 0 && (
                    <div className="border rounded-lg mt-1 max-h-40 overflow-y-auto">
                      {customers.map(c => (
                        <button key={c.user_id} onClick={() => { setSelectedCustomer(c); setCustomerSearch(''); setCustomers([]); }}
                          className="w-full text-left px-3 py-2 hover:bg-muted/50 text-sm border-b last:border-b-0">
                          <p className="font-medium">{c.name}</p>
                          <p className="text-xs text-muted-foreground">{c.phone || c.email}</p>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            <Select value={callType} onValueChange={setCallType}>
              <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
              <SelectContent>{CALL_TYPES.map(t => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}</SelectContent>
            </Select>

            {/* Timers */}
            <Card className="bg-muted/30">
              <CardContent className="p-3">
                <div className="grid grid-cols-2 gap-3">
                  <div className="text-center">
                    <p className="text-xs text-muted-foreground mb-1">Ligação</p>
                    <p className="text-2xl font-mono font-bold">{formatTimer(callSeconds)}</p>
                    <Button size="sm" variant={isCallActive ? 'destructive' : 'default'} className="mt-2 w-full h-8"
                      onClick={isCallActive ? stopCallTimer : startCallTimer}>
                      {isCallActive ? <><PhoneOff className="w-3 h-3 mr-1" /> Parar</> : <><Play className="w-3 h-3 mr-1" /> Iniciar</>}
                    </Button>
                  </div>
                  <div className="text-center">
                    <p className="text-xs text-muted-foreground mb-1">Follow-up</p>
                    <p className="text-2xl font-mono font-bold">{formatTimer(followUpSeconds)}</p>
                    <Button size="sm" variant={isFollowUpActive ? 'destructive' : 'outline'} className="mt-2 w-full h-8"
                      onClick={isFollowUpActive ? stopFollowUpTimer : startFollowUpTimer}>
                      {isFollowUpActive ? <><Pause className="w-3 h-3 mr-1" /> Parar</> : <><Timer className="w-3 h-3 mr-1" /> Iniciar</>}
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Select value={callResult} onValueChange={setCallResult}>
              <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
              <SelectContent>{CALL_RESULTS.map(r => <SelectItem key={r.value} value={r.value}>{r.icon} {r.label}</SelectItem>)}</SelectContent>
            </Select>

            <Input type="number" min={1} value={attemptNumber} onChange={e => setAttemptNumber(parseInt(e.target.value) || 1)} className="h-9" placeholder="Nº da tentativa" />

            {callResult === 'contato_sucesso' && (
              <div className="grid grid-cols-2 gap-3">
                <Input type="number" step="0.01" placeholder="Receita (R$)" value={revenue} onChange={e => setRevenue(e.target.value)} className="h-9" />
                <Input type="number" step="0.01" placeholder="Margem (R$)" value={margin} onChange={e => setMargin(e.target.value)} className="h-9" />
              </div>
            )}

            <Textarea placeholder="Observações da ligação..." value={notes} onChange={e => setNotes(e.target.value)} rows={2} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowNewCall(false)}>Cancelar</Button>
            <Button onClick={handleSaveCall} disabled={!selectedCustomer || saving} className="gap-1.5">
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />} Salvar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};

export default FarmerCalls;
