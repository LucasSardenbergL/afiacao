import { useState, useEffect } from 'react';
import { Header } from '@/components/Header';
import { BottomNav } from '@/components/BottomNav';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/contexts/AuthContext';
import { useToast } from '@/hooks/use-toast';
import { CalendarClock, Plus, Loader2, Trash2, Wrench, Pause, Play } from 'lucide-react';
import { format, addDays } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { DELIVERY_OPTIONS, TIME_SLOTS } from '@/types';

interface UserTool {
  id: string;
  generated_name: string | null;
  custom_name: string | null;
  tool_categories: { name: string };
}

interface AddressData {
  id: string;
  label: string;
  street: string;
  number: string;
  city: string;
}

interface Schedule {
  id: string;
  tool_ids: string[];
  frequency_days: number;
  delivery_option: string;
  address_id: string | null;
  time_slot: string | null;
  next_order_date: string;
  is_active: boolean;
  notes: string | null;
}

const FREQUENCY_OPTIONS = [
  { value: 7, label: 'Semanal' },
  { value: 14, label: 'Quinzenal' },
  { value: 30, label: 'Mensal' },
  { value: 60, label: 'Bimestral' },
  { value: 90, label: 'Trimestral' },
];

const RecurringSchedules = () => {
  const { user } = useAuth();
  const { toast } = useToast();
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [userTools, setUserTools] = useState<UserTool[]>([]);
  const [addresses, setAddresses] = useState<AddressData[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);

  const [selectedTools, setSelectedTools] = useState<string[]>([]);
  const [frequency, setFrequency] = useState(30);
  const [deliveryOption, setDeliveryOption] = useState<string>('coleta_entrega');
  const [selectedAddress, setSelectedAddress] = useState('');
  const [timeSlot, setTimeSlot] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (user) loadData();
  }, [user]);

  const loadData = async () => {
    if (!user) return;
    try {
      const [schedulesRes, toolsRes, addressesRes] = await Promise.all([
        (supabase as any).from('recurring_schedules')
          .select('*')
          .eq('user_id', user.id)
          .order('created_at', { ascending: false }),
        supabase.from('user_tools')
          .select('id, generated_name, custom_name, tool_categories (name)')
          .eq('user_id', user.id),
        supabase.from('addresses')
          .select('id, label, street, number, city')
          .eq('user_id', user.id),
      ]);

      if (schedulesRes.data) setSchedules(schedulesRes.data as Schedule[]);
      if (toolsRes.data) setUserTools(toolsRes.data as unknown as UserTool[]);
      if (addressesRes.data) setAddresses(addressesRes.data as AddressData[]);
    } catch (error) {
      console.error('Error loading data:', error);
    } finally {
      setLoading(false);
    }
  };

  const getToolName = (toolId: string) => {
    const tool = userTools.find(t => t.id === toolId);
    if (!tool) return 'Ferramenta';
    return tool.generated_name || tool.custom_name || tool.tool_categories?.name || 'Ferramenta';
  };

  const toggleTool = (toolId: string) => {
    setSelectedTools(prev =>
      prev.includes(toolId) ? prev.filter(id => id !== toolId) : [...prev, toolId]
    );
  };

  const handleCreate = async () => {
    if (!user || selectedTools.length === 0) return;
    setSaving(true);
    try {
      const nextDate = addDays(new Date(), frequency);
      const { error } = await (supabase as any).from('recurring_schedules').insert({
        user_id: user.id,
        tool_ids: selectedTools,
        frequency_days: frequency,
        delivery_option: deliveryOption,
        address_id: selectedAddress || null,
        time_slot: timeSlot || null,
        next_order_date: format(nextDate, 'yyyy-MM-dd'),
      });
      if (error) throw error;
      toast({ title: 'Agendamento criado!', description: `Próximo pedido em ${format(nextDate, "dd 'de' MMMM", { locale: ptBR })}` });
      setDialogOpen(false);
      setSelectedTools([]);
      loadData();
    } catch (error) {
      console.error('Error creating schedule:', error);
      toast({ title: 'Erro', description: 'Não foi possível criar o agendamento', variant: 'destructive' });
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = async (scheduleId: string, currentActive: boolean) => {
    try {
      const { error } = await (supabase as any).from('recurring_schedules')
        .update({ is_active: !currentActive, updated_at: new Date().toISOString() })
        .eq('id', scheduleId);
      if (error) throw error;
      setSchedules(prev => prev.map(s => s.id === scheduleId ? { ...s, is_active: !currentActive } : s));
      toast({ title: !currentActive ? 'Agendamento ativado' : 'Agendamento pausado' });
    } catch (error) {
      console.error('Error toggling schedule:', error);
    }
  };

  const deleteSchedule = async (scheduleId: string) => {
    try {
      const { error } = await (supabase as any).from('recurring_schedules').delete().eq('id', scheduleId);
      if (error) throw error;
      setSchedules(prev => prev.filter(s => s.id !== scheduleId));
      toast({ title: 'Agendamento removido' });
    } catch (error) {
      console.error('Error deleting schedule:', error);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-background pb-24">
        <Header title="Agendamentos Recorrentes" showBack />
        <div className="flex items-center justify-center pt-32">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
        </div>
        <BottomNav />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background pb-24">
      <Header title="Agendamentos Recorrentes" showBack />
      <main className="pt-16 px-4 max-w-lg mx-auto">
        <Card className="mb-4 border-primary/20 bg-primary/5">
          <CardContent className="p-4 flex gap-3">
            <CalendarClock className="w-5 h-5 text-primary flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-foreground">Agende afiações automáticas</p>
              <p className="text-xs text-muted-foreground">Configure a frequência e nós criamos o pedido automaticamente.</p>
            </div>
          </CardContent>
        </Card>

        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogTrigger asChild>
            <Button className="w-full mb-6" size="lg">
              <Plus className="w-4 h-4 mr-2" />
              Novo Agendamento
            </Button>
          </DialogTrigger>
          <DialogContent className="max-h-[85vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>Novo Agendamento Recorrente</DialogTitle>
            </DialogHeader>
            <div className="space-y-5 pt-2">
              <div>
                <Label className="text-sm font-medium mb-2 block">Ferramentas</Label>
                {userTools.length === 0 ? (
                  <p className="text-sm text-muted-foreground">Cadastre ferramentas primeiro</p>
                ) : (
                  <div className="space-y-2 max-h-40 overflow-y-auto">
                    {userTools.map(tool => (
                      <label key={tool.id} className="flex items-center gap-3 p-2 rounded-lg hover:bg-muted cursor-pointer">
                        <Checkbox checked={selectedTools.includes(tool.id)} onCheckedChange={() => toggleTool(tool.id)} />
                        <div className="flex items-center gap-2">
                          <Wrench className="w-4 h-4 text-muted-foreground" />
                          <span className="text-sm">{tool.generated_name || tool.custom_name || tool.tool_categories?.name}</span>
                        </div>
                      </label>
                    ))}
                  </div>
                )}
              </div>
              <div>
                <Label className="text-sm font-medium mb-2 block">Frequência</Label>
                <Select value={String(frequency)} onValueChange={v => setFrequency(Number(v))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {FREQUENCY_OPTIONS.map(opt => (
                      <SelectItem key={opt.value} value={String(opt.value)}>{opt.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="text-sm font-medium mb-2 block">Entrega</Label>
                <Select value={deliveryOption} onValueChange={setDeliveryOption}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {Object.entries(DELIVERY_OPTIONS).map(([key, opt]) => (
                      <SelectItem key={key} value={key}>{opt.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {deliveryOption !== 'balcao' && addresses.length > 0 && (
                <div>
                  <Label className="text-sm font-medium mb-2 block">Endereço</Label>
                  <Select value={selectedAddress} onValueChange={setSelectedAddress}>
                    <SelectTrigger><SelectValue placeholder="Selecione" /></SelectTrigger>
                    <SelectContent>
                      {addresses.map(addr => (
                        <SelectItem key={addr.id} value={addr.id}>{addr.label} - {addr.street}, {addr.number}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              {deliveryOption !== 'balcao' && (
                <div>
                  <Label className="text-sm font-medium mb-2 block">Período</Label>
                  <Select value={timeSlot} onValueChange={setTimeSlot}>
                    <SelectTrigger><SelectValue placeholder="Selecione" /></SelectTrigger>
                    <SelectContent>
                      {TIME_SLOTS.map(slot => (
                        <SelectItem key={slot.id} value={slot.id}>{slot.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
              <Button className="w-full" onClick={handleCreate} disabled={saving || selectedTools.length === 0}>
                {saving ? <Loader2 className="w-4 h-4 mr-2 animate-spin" /> : <CalendarClock className="w-4 h-4 mr-2" />}
                Criar Agendamento
              </Button>
            </div>
          </DialogContent>
        </Dialog>

        {schedules.length === 0 ? (
          <div className="text-center py-12">
            <CalendarClock className="w-12 h-12 text-muted-foreground/30 mx-auto mb-3" />
            <p className="text-muted-foreground">Nenhum agendamento recorrente</p>
            <p className="text-sm text-muted-foreground/70">Crie um para receber pedidos automaticamente</p>
          </div>
        ) : (
          <div className="space-y-3">
            {schedules.map(schedule => {
              const freq = FREQUENCY_OPTIONS.find(f => f.value === schedule.frequency_days);
              return (
                <Card key={schedule.id} className={!schedule.is_active ? 'opacity-60' : ''}>
                  <CardContent className="p-4">
                    <div className="flex items-start justify-between mb-3">
                      <div>
                        <div className="flex items-center gap-2 mb-1">
                          <Badge variant={schedule.is_active ? 'default' : 'secondary'}>
                            {schedule.is_active ? 'Ativo' : 'Pausado'}
                          </Badge>
                          <span className="text-xs text-muted-foreground">{freq?.label || `${schedule.frequency_days} dias`}</span>
                        </div>
                        <p className="text-sm text-muted-foreground">
                          Próximo: {format(new Date(schedule.next_order_date), "dd 'de' MMMM", { locale: ptBR })}
                        </p>
                      </div>
                      <div className="flex items-center gap-1">
                        <Button variant="ghost" size="icon" onClick={() => toggleActive(schedule.id, schedule.is_active)}>
                          {schedule.is_active ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
                        </Button>
                        <Button variant="ghost" size="icon" onClick={() => deleteSchedule(schedule.id)}>
                          <Trash2 className="w-4 h-4 text-destructive" />
                        </Button>
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {schedule.tool_ids.map(toolId => (
                        <Badge key={toolId} variant="outline" className="text-xs">
                          <Wrench className="w-3 h-3 mr-1" />
                          {getToolName(toolId)}
                        </Badge>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </main>
      <BottomNav />
    </div>
  );
};

export default RecurringSchedules;
