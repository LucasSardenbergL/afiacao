import { useState, useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Header } from '@/components/Header';
import { BottomNav } from '@/components/BottomNav';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/hooks/use-toast';
import {
  Phone, PhoneOff, Play, Pause, Clock, User, Search,
  Plus, ChevronRight, Timer, CheckCircle, XCircle, Loader2
} from 'lucide-react';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';

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
  { value: 'reativacao', label: 'Reativação' },
  { value: 'cross_sell', label: 'Cross-sell' },
  { value: 'up_sell', label: 'Up-sell' },
  { value: 'follow_up', label: 'Follow-up' },
];

const CALL_RESULTS = [
  { value: 'contato_sucesso', label: '✅ Contato com Sucesso' },
  { value: 'sem_resposta', label: '📵 Sem Resposta' },
  { value: 'ocupado', label: '🔴 Ocupado' },
  { value: 'caixa_postal', label: '📩 Caixa Postal' },
  { value: 'numero_invalido', label: '❌ Número Inválido' },
  { value: 'reagendado', label: '📅 Reagendado' },
];

const FarmerCalls = () => {
  const navigate = useNavigate();
  const { user, isStaff, loading: authLoading } = useAuth();
  const { toast } = useToast();

  // Timer state
  const [isCallActive, setIsCallActive] = useState(false);
  const [isFollowUpActive, setIsFollowUpActive] = useState(false);
  const [callSeconds, setCallSeconds] = useState(0);
  const [followUpSeconds, setFollowUpSeconds] = useState(0);
  const callTimerRef = useRef<number | null>(null);
  const followUpTimerRef = useRef<number | null>(null);
  const callStartRef = useRef<Date | null>(null);

  // Form state
  const [showNewCall, setShowNewCall] = useState(false);
  const [selectedCustomer, setSelectedCustomer] = useState<Customer | null>(null);
  const [callType, setCallType] = useState<string>('follow_up');
  const [callResult, setCallResult] = useState<string>('contato_sucesso');
  const [attemptNumber, setAttemptNumber] = useState(1);
  const [notes, setNotes] = useState('');
  const [revenue, setRevenue] = useState('');
  const [margin, setMargin] = useState('');
  const [saving, setSaving] = useState(false);

  // Search state
  const [customerSearch, setCustomerSearch] = useState('');
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);

  // Call history
  const [callLogs, setCallLogs] = useState<CallLog[]>([]);
  const [loadingLogs, setLoadingLogs] = useState(true);

  useEffect(() => {
    if (!authLoading && !isStaff) {
      navigate('/', { replace: true });
    }
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
        .limit(50);

      if (data) {
        // Load customer names
        const customerIds = [...new Set(data.map((c: any) => c.customer_user_id))];
        const { data: profiles } = await supabase
          .from('profiles')
          .select('user_id, name')
          .in('user_id', customerIds);

        const nameMap = new Map(profiles?.map((p: any) => [p.user_id, p.name]) || []);

        setCallLogs(
          (data as CallLog[]).map(c => ({
            ...c,
            customer_name: nameMap.get(c.customer_user_id) || 'Cliente',
          }))
        );
      }
    } catch (error) {
      console.error('Error loading call logs:', error);
    } finally {
      setLoadingLogs(false);
    }
  };

  const searchCustomers = useCallback(async (query: string) => {
    if (query.length < 2) {
      setCustomers([]);
      return;
    }
    setSearchLoading(true);
    try {
      const { data } = await supabase
        .from('profiles')
        .select('user_id, name, email, phone')
        .ilike('name', `%${query}%`)
        .limit(10);
      setCustomers((data || []) as Customer[]);
    } catch (error) {
      console.error('Error searching customers:', error);
    } finally {
      setSearchLoading(false);
    }
  }, []);

  useEffect(() => {
    const debounce = setTimeout(() => searchCustomers(customerSearch), 300);
    return () => clearTimeout(debounce);
  }, [customerSearch, searchCustomers]);

  // Timer controls
  const startCallTimer = () => {
    setIsCallActive(true);
    callStartRef.current = new Date();
    callTimerRef.current = window.setInterval(() => {
      setCallSeconds(s => s + 1);
    }, 1000);
  };

  const stopCallTimer = () => {
    setIsCallActive(false);
    if (callTimerRef.current) {
      clearInterval(callTimerRef.current);
      callTimerRef.current = null;
    }
  };

  const startFollowUpTimer = () => {
    setIsFollowUpActive(true);
    followUpTimerRef.current = window.setInterval(() => {
      setFollowUpSeconds(s => s + 1);
    }, 1000);
  };

  const stopFollowUpTimer = () => {
    setIsFollowUpActive(false);
    if (followUpTimerRef.current) {
      clearInterval(followUpTimerRef.current);
      followUpTimerRef.current = null;
    }
  };

  const resetForm = () => {
    setSelectedCustomer(null);
    setCallType('follow_up');
    setCallResult('contato_sucesso');
    setAttemptNumber(1);
    setNotes('');
    setRevenue('');
    setMargin('');
    setCallSeconds(0);
    setFollowUpSeconds(0);
    setIsCallActive(false);
    setIsFollowUpActive(false);
    setCustomerSearch('');
    setCustomers([]);
    callStartRef.current = null;
    if (callTimerRef.current) clearInterval(callTimerRef.current);
    if (followUpTimerRef.current) clearInterval(followUpTimerRef.current);
  };

  const handleSaveCall = async () => {
    if (!selectedCustomer || !user) return;
    setSaving(true);

    try {
      stopCallTimer();
      stopFollowUpTimer();

      const { error } = await supabase.from('farmer_calls').insert({
        farmer_id: user.id,
        customer_user_id: selectedCustomer.user_id,
        call_type: callType as any,
        call_result: callResult as any,
        started_at: callStartRef.current?.toISOString() || new Date().toISOString(),
        ended_at: new Date().toISOString(),
        duration_seconds: callSeconds,
        follow_up_duration_seconds: followUpSeconds,
        attempt_number: attemptNumber,
        notes: notes || null,
        revenue_generated: parseFloat(revenue) || 0,
        margin_generated: parseFloat(margin) || 0,
      } as any);

      if (error) throw error;

      toast({ title: 'Ligação registrada com sucesso!' });
      resetForm();
      setShowNewCall(false);
      loadCallLogs();
    } catch (error) {
      console.error('Error saving call:', error);
      toast({ title: 'Erro ao salvar ligação', variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  const formatTimer = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  };

  const callTypeLabel = (type: string) =>
    CALL_TYPES.find(t => t.value === type)?.label || type;
  const callResultLabel = (result: string) =>
    CALL_RESULTS.find(r => r.value === result)?.label || result;

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background pb-24">
      <Header title="Ligações" showBack />

      <main className="px-4 py-4 space-y-4 max-w-lg mx-auto">
        <Button
          className="w-full"
          onClick={() => { resetForm(); setShowNewCall(true); }}
        >
          <Plus className="w-4 h-4 mr-2" />
          Nova Ligação
        </Button>

        <Tabs defaultValue="history">
          <TabsList className="w-full grid grid-cols-1">
            <TabsTrigger value="history">Histórico de Ligações</TabsTrigger>
          </TabsList>

          <TabsContent value="history" className="space-y-2 mt-3">
            {loadingLogs ? (
              <div className="flex justify-center py-8">
                <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
              </div>
            ) : callLogs.length === 0 ? (
              <div className="text-center py-8">
                <Phone className="w-12 h-12 text-muted-foreground mx-auto mb-2" />
                <p className="text-sm text-muted-foreground">Nenhuma ligação registrada</p>
              </div>
            ) : (
              callLogs.map(log => (
                <Card key={log.id} className="overflow-hidden">
                  <CardContent className="p-3">
                    <div className="flex items-start justify-between">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <p className="text-sm font-medium truncate">{log.customer_name}</p>
                          <Badge variant="outline" className="text-[10px] shrink-0">
                            {callTypeLabel(log.call_type)}
                          </Badge>
                        </div>
                        <div className="flex items-center gap-2 text-xs text-muted-foreground">
                          <span>{callResultLabel(log.call_result)}</span>
                          <span>·</span>
                          <span>
                            <Clock className="w-3 h-3 inline mr-0.5" />
                            {formatTimer(log.duration_seconds)}
                          </span>
                          {log.attempt_number > 1 && (
                            <>
                              <span>·</span>
                              <span>#{log.attempt_number}</span>
                            </>
                          )}
                        </div>
                        {(log.revenue_generated > 0 || log.margin_generated > 0) && (
                          <div className="flex items-center gap-3 mt-1 text-xs">
                            {log.revenue_generated > 0 && (
                              <span className="text-emerald-600 font-medium">
                                Receita: R$ {Number(log.revenue_generated).toFixed(2)}
                              </span>
                            )}
                            {log.margin_generated > 0 && (
                              <span className="text-blue-600 font-medium">
                                Margem: R$ {Number(log.margin_generated).toFixed(2)}
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                      <span className="text-xs text-muted-foreground shrink-0">
                        {format(new Date(log.created_at), 'dd/MM HH:mm', { locale: ptBR })}
                      </span>
                    </div>
                  </CardContent>
                </Card>
              ))
            )}
          </TabsContent>
        </Tabs>
      </main>

      {/* New Call Dialog */}
      <Dialog open={showNewCall} onOpenChange={setShowNewCall}>
        <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Phone className="w-5 h-5" />
              Registrar Ligação
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
                    <Input
                      placeholder="Buscar cliente..."
                      value={customerSearch}
                      onChange={e => setCustomerSearch(e.target.value)}
                      className="pl-9"
                    />
                  </div>
                  {searchLoading && (
                    <div className="flex justify-center py-2">
                      <Loader2 className="w-4 h-4 animate-spin" />
                    </div>
                  )}
                  {customers.length > 0 && (
                    <div className="border rounded-lg mt-1 max-h-40 overflow-y-auto">
                      {customers.map(c => (
                        <button
                          key={c.user_id}
                          onClick={() => {
                            setSelectedCustomer(c);
                            setCustomerSearch('');
                            setCustomers([]);
                          }}
                          className="w-full text-left px-3 py-2 hover:bg-muted/50 text-sm border-b last:border-b-0"
                        >
                          <p className="font-medium">{c.name}</p>
                          <p className="text-xs text-muted-foreground">{c.phone || c.email}</p>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Call Type */}
            <div>
              <label className="text-sm font-medium">Tipo de Abordagem</label>
              <Select value={callType} onValueChange={setCallType}>
                <SelectTrigger className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CALL_TYPES.map(t => (
                    <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Timer Section */}
            <Card>
              <CardContent className="p-3">
                <div className="grid grid-cols-2 gap-3">
                  {/* Call Timer */}
                  <div className="text-center">
                    <p className="text-xs text-muted-foreground mb-1">Ligação</p>
                    <p className="text-2xl font-mono font-bold">{formatTimer(callSeconds)}</p>
                    <Button
                      size="sm"
                      variant={isCallActive ? 'destructive' : 'default'}
                      className="mt-2 w-full"
                      onClick={isCallActive ? stopCallTimer : startCallTimer}
                    >
                      {isCallActive ? (
                        <><PhoneOff className="w-3 h-3 mr-1" /> Parar</>
                      ) : (
                        <><Play className="w-3 h-3 mr-1" /> Iniciar</>
                      )}
                    </Button>
                  </div>

                  {/* Follow-up Timer */}
                  <div className="text-center">
                    <p className="text-xs text-muted-foreground mb-1">Follow-up</p>
                    <p className="text-2xl font-mono font-bold">{formatTimer(followUpSeconds)}</p>
                    <Button
                      size="sm"
                      variant={isFollowUpActive ? 'destructive' : 'outline'}
                      className="mt-2 w-full"
                      onClick={isFollowUpActive ? stopFollowUpTimer : startFollowUpTimer}
                    >
                      {isFollowUpActive ? (
                        <><Pause className="w-3 h-3 mr-1" /> Parar</>
                      ) : (
                        <><Timer className="w-3 h-3 mr-1" /> Iniciar</>
                      )}
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Call Result */}
            <div>
              <label className="text-sm font-medium">Resultado</label>
              <Select value={callResult} onValueChange={setCallResult}>
                <SelectTrigger className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CALL_RESULTS.map(r => (
                    <SelectItem key={r.value} value={r.value}>{r.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Attempt Number */}
            <div>
              <label className="text-sm font-medium">Nº da Tentativa</label>
              <Input
                type="number"
                min={1}
                value={attemptNumber}
                onChange={e => setAttemptNumber(parseInt(e.target.value) || 1)}
                className="mt-1"
              />
            </div>

            {/* Revenue & Margin (show if contact successful) */}
            {callResult === 'contato_sucesso' && (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-sm font-medium">Receita (R$)</label>
                  <Input
                    type="number"
                    step="0.01"
                    placeholder="0,00"
                    value={revenue}
                    onChange={e => setRevenue(e.target.value)}
                    className="mt-1"
                  />
                </div>
                <div>
                  <label className="text-sm font-medium">Margem (R$)</label>
                  <Input
                    type="number"
                    step="0.01"
                    placeholder="0,00"
                    value={margin}
                    onChange={e => setMargin(e.target.value)}
                    className="mt-1"
                  />
                </div>
              </div>
            )}

            {/* Notes */}
            <div>
              <label className="text-sm font-medium">Observações</label>
              <Textarea
                placeholder="Anotações da ligação..."
                value={notes}
                onChange={e => setNotes(e.target.value)}
                className="mt-1"
                rows={2}
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowNewCall(false)}>
              Cancelar
            </Button>
            <Button
              onClick={handleSaveCall}
              disabled={!selectedCustomer || saving}
            >
              {saving ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <CheckCircle className="w-4 h-4 mr-1" />}
              Salvar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <BottomNav />
    </div>
  );
};

export default FarmerCalls;
