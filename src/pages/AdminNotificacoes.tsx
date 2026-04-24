import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import {
  Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle,
} from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Zap, Mail, Calendar as CalendarIcon, ExternalLink, AlertCircle } from 'lucide-react';
import { toast } from 'sonner';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';

type AlertaRow = {
  id: number;
  tipo_alerta: string | null;
  tipo: string;
  titulo: string;
  mensagem: string | null;
  status: string | null;
  tentativas: number | null;
  criado_em: string;
  notificado_em: string | null;
  gmail_message_id: string | null;
  calendar_event_id: string | null;
  erro_notificacao: string | null;
  metadata: Record<string, unknown> | null;
  data_evento: string | null;
};

const TIPO_VARIANT: Record<string, 'default' | 'secondary' | 'destructive' | 'success' | 'warning' | 'info' | 'purple' | 'indigo'> = {
  promocao_suspensa: 'destructive',
  aumento_anunciado: 'warning',
  promocao_nova: 'success',
  polling_erro: 'destructive',
  mapeamento_pendente: 'info',
  oportunidade_calculada: 'purple',
  outro: 'secondary',
};

function relTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const min = Math.round(diff / 60000);
  if (min < 1) return 'agora';
  if (min < 60) return `há ${min}m`;
  const h = Math.round(min / 60);
  if (h < 24) return `há ${h}h`;
  const d = Math.round(h / 24);
  return `há ${d}d`;
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

export default function AdminNotificacoes() {
  const qc = useQueryClient();
  const [filtroTipo, setFiltroTipo] = useState<string>('__all__');
  const [drawerAlerta, setDrawerAlerta] = useState<AlertaRow | null>(null);

  // Pendentes
  const { data: pendentes, isLoading: loadingPend } = useQuery({
    queryKey: ['notificacoes', 'pendentes'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('fornecedor_alerta')
        .select('id, tipo_alerta, tipo, titulo, mensagem, status, tentativas, criado_em, notificado_em, gmail_message_id, calendar_event_id, erro_notificacao, metadata, data_evento')
        .eq('status', 'pendente_notificacao')
        .order('criado_em', { ascending: false })
        .limit(200);
      if (error) throw error;
      return data as AlertaRow[];
    },
    refetchInterval: 30_000,
  });

  // Histórico (30 dias)
  const { data: historico, isLoading: loadingHist } = useQuery({
    queryKey: ['notificacoes', 'historico'],
    queryFn: async () => {
      const since = new Date(Date.now() - 30 * 24 * 3600_000).toISOString();
      const { data, error } = await supabase
        .from('fornecedor_alerta')
        .select('id, tipo_alerta, tipo, titulo, mensagem, status, tentativas, criado_em, notificado_em, gmail_message_id, calendar_event_id, erro_notificacao, metadata, data_evento')
        .in('status', ['notificado', 'falha_notificacao'])
        .gte('criado_em', since)
        .order('notificado_em', { ascending: false, nullsFirst: false })
        .limit(500);
      if (error) throw error;
      return data as AlertaRow[];
    },
    refetchInterval: 60_000,
  });

  // Estatísticas
  const { data: stats } = useQuery({
    queryKey: ['notificacoes', 'stats'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('v_notificacoes_status' as any)
        .select('*')
        .gte('dia', new Date(Date.now() - 30 * 24 * 3600_000).toISOString().slice(0, 10))
        .order('dia', { ascending: true });
      if (error) throw error;
      return data as Array<{ dia: string; status: string; total: number; esgotados: number; com_calendar_event: number }>;
    },
    refetchInterval: 60_000,
  });

  const tiposDisponiveis = useMemo(() => {
    const set = new Set<string>();
    pendentes?.forEach((r) => r.tipo_alerta && set.add(r.tipo_alerta));
    return Array.from(set).sort();
  }, [pendentes]);

  const pendentesFiltrados = useMemo(() => {
    if (!pendentes) return [];
    if (filtroTipo === '__all__') return pendentes;
    return pendentes.filter((r) => r.tipo_alerta === filtroTipo);
  }, [pendentes, filtroTipo]);

  // Resumo (cards)
  const resumo = useMemo(() => {
    if (!stats) return { total7d: 0, taxa: 0, esgotados: 0 };
    const since7 = new Date(Date.now() - 7 * 24 * 3600_000).toISOString().slice(0, 10);
    const last7 = stats.filter((s) => s.dia >= since7);
    const total7d = last7.reduce((acc, s) => acc + Number(s.total), 0);
    const sucesso = last7.filter((s) => s.status === 'notificado').reduce((a, s) => a + Number(s.total), 0);
    const taxa = total7d > 0 ? Math.round((sucesso / total7d) * 100) : 0;
    const esgotados = stats.reduce((a, s) => a + Number(s.esgotados ?? 0), 0);
    return { total7d, taxa, esgotados };
  }, [stats]);

  // Dados gráfico
  const chartData = useMemo(() => {
    if (!stats) return [];
    const map = new Map<string, { dia: string; notificado: number; pendente: number; falha: number }>();
    stats.forEach((s) => {
      const cur = map.get(s.dia) ?? { dia: s.dia, notificado: 0, pendente: 0, falha: 0 };
      if (s.status === 'notificado') cur.notificado = Number(s.total);
      else if (s.status === 'pendente_notificacao') cur.pendente = Number(s.total);
      else if (s.status === 'falha_notificacao') cur.falha = Number(s.total);
      map.set(s.dia, cur);
    });
    return Array.from(map.values()).sort((a, b) => a.dia.localeCompare(b.dia));
  }, [stats]);

  // Disparo manual
  const dispararMutation = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke('dispatch-notifications', {
        body: {},
      });
      if (error) throw error;
      return data as { processados: number; sucesso?: number; falhas?: number };
    },
    onSuccess: (data) => {
      toast.success(
        `${data.processados} processados — ${data.sucesso ?? 0} sucesso, ${data.falhas ?? 0} falhas`,
      );
      qc.invalidateQueries({ queryKey: ['notificacoes'] });
    },
    onError: (err) => {
      toast.error(`Falha no disparo: ${err instanceof Error ? err.message : String(err)}`);
    },
  });

  return (
    <div className="container mx-auto p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Notificações</h1>
          <p className="text-sm text-muted-foreground">Email + Google Calendar para alertas de fornecedores</p>
        </div>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button disabled={dispararMutation.isPending} size="lg">
              <Zap className="mr-2 h-4 w-4" />
              {dispararMutation.isPending ? 'Disparando…' : 'Disparar agora'}
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Disparar notificações pendentes</AlertDialogTitle>
              <AlertDialogDescription>
                Isso vai processar todos os alertas pendentes imediatamente. Confirma?
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancelar</AlertDialogCancel>
              <AlertDialogAction onClick={() => dispararMutation.mutate()}>Confirmar</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>

      {/* Cards de resumo */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">Últimos 7 dias</CardTitle></CardHeader>
          <CardContent><div className="text-3xl font-bold">{resumo.total7d}</div></CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">Taxa de sucesso</CardTitle></CardHeader>
          <CardContent><div className="text-3xl font-bold">{resumo.taxa}%</div></CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm font-medium text-muted-foreground">Esgotados (3 tentativas)</CardTitle></CardHeader>
          <CardContent><div className="text-3xl font-bold text-destructive">{resumo.esgotados}</div></CardContent>
        </Card>
      </div>

      <Tabs defaultValue="pendentes">
        <TabsList>
          <TabsTrigger value="pendentes">Pendentes ({pendentes?.length ?? 0})</TabsTrigger>
          <TabsTrigger value="historico">Histórico (30d)</TabsTrigger>
          <TabsTrigger value="estatisticas">Estatísticas</TabsTrigger>
        </TabsList>

        {/* Pendentes */}
        <TabsContent value="pendentes" className="space-y-4">
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">Tipo:</span>
            <Select value={filtroTipo} onValueChange={setFiltroTipo}>
              <SelectTrigger className="w-[260px]"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">Todos</SelectItem>
                {tiposDisponiveis.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <Card>
            <CardContent className="p-0">
              {loadingPend ? <Skeleton className="h-64 m-4" /> : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Tipo</TableHead>
                      <TableHead>Título</TableHead>
                      <TableHead>Criado</TableHead>
                      <TableHead className="text-right">Tentativas</TableHead>
                      <TableHead></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {pendentesFiltrados.length === 0 ? (
                      <TableRow><TableCell colSpan={5} className="text-center py-8 text-muted-foreground">Nenhum alerta pendente</TableCell></TableRow>
                    ) : pendentesFiltrados.map((a) => (
                      <TableRow key={a.id}>
                        <TableCell><Badge variant={TIPO_VARIANT[a.tipo_alerta ?? a.tipo] ?? 'secondary'}>{a.tipo_alerta ?? a.tipo}</Badge></TableCell>
                        <TableCell className="max-w-md truncate">{a.titulo}</TableCell>
                        <TableCell className="text-sm text-muted-foreground">{relTime(a.criado_em)}</TableCell>
                        <TableCell className="text-right">{a.tentativas ?? 0}/3</TableCell>
                        <TableCell><Button variant="ghost" size="sm" onClick={() => setDrawerAlerta(a)}>Ver</Button></TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Histórico */}
        <TabsContent value="historico">
          <Card>
            <CardContent className="p-0">
              {loadingHist ? <Skeleton className="h-64 m-4" /> : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Status</TableHead>
                      <TableHead>Tipo</TableHead>
                      <TableHead>Título</TableHead>
                      <TableHead>Notificado em</TableHead>
                      <TableHead></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(!historico || historico.length === 0) ? (
                      <TableRow><TableCell colSpan={5} className="text-center py-8 text-muted-foreground">Sem histórico nos últimos 30 dias</TableCell></TableRow>
                    ) : historico.map((a) => (
                      <TableRow key={a.id}>
                        <TableCell>
                          <Badge variant={a.status === 'notificado' ? 'success' : 'destructive'}>
                            {a.status === 'notificado' ? 'Notificado' : 'Falha'}
                          </Badge>
                        </TableCell>
                        <TableCell><Badge variant={TIPO_VARIANT[a.tipo_alerta ?? a.tipo] ?? 'secondary'}>{a.tipo_alerta ?? a.tipo}</Badge></TableCell>
                        <TableCell className="max-w-md truncate">{a.titulo}</TableCell>
                        <TableCell className="text-sm">{fmtDate(a.notificado_em)}</TableCell>
                        <TableCell><Button variant="ghost" size="sm" onClick={() => setDrawerAlerta(a)}>Ver detalhes</Button></TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Estatísticas */}
        <TabsContent value="estatisticas">
          <Card>
            <CardHeader><CardTitle>Distribuição por dia (30 dias)</CardTitle></CardHeader>
            <CardContent>
              <div className="h-[400px]">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={chartData}>
                    <CartesianGrid strokeDasharray="3 3" />
                    <XAxis dataKey="dia" tick={{ fontSize: 11 }} />
                    <YAxis />
                    <Tooltip />
                    <Legend />
                    <Bar dataKey="notificado" stackId="a" fill="hsl(var(--primary))" name="Notificado" />
                    <Bar dataKey="pendente" stackId="a" fill="hsl(45 90% 55%)" name="Pendente" />
                    <Bar dataKey="falha" stackId="a" fill="hsl(var(--destructive))" name="Falha" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Drawer de detalhes */}
      <Sheet open={!!drawerAlerta} onOpenChange={(o) => !o && setDrawerAlerta(null)}>
        <SheetContent className="w-full sm:max-w-xl overflow-y-auto">
          {drawerAlerta && (
            <>
              <SheetHeader>
                <SheetTitle>{drawerAlerta.titulo}</SheetTitle>
                <SheetDescription>
                  <Badge variant={TIPO_VARIANT[drawerAlerta.tipo_alerta ?? drawerAlerta.tipo] ?? 'secondary'}>
                    {drawerAlerta.tipo_alerta ?? drawerAlerta.tipo}
                  </Badge>
                  <span className="ml-2 text-xs">Alerta #{drawerAlerta.id}</span>
                </SheetDescription>
              </SheetHeader>
              <div className="space-y-4 mt-6 text-sm">
                <div>
                  <h4 className="font-semibold mb-1">Mensagem</h4>
                  <p className="whitespace-pre-wrap text-muted-foreground">{drawerAlerta.mensagem || '—'}</p>
                </div>
                {drawerAlerta.data_evento && (
                  <div>
                    <h4 className="font-semibold mb-1">Evento agendado</h4>
                    <p className="text-muted-foreground">{fmtDate(drawerAlerta.data_evento)}</p>
                  </div>
                )}
                {drawerAlerta.metadata && Object.keys(drawerAlerta.metadata).length > 0 && (
                  <div>
                    <h4 className="font-semibold mb-1">Metadata</h4>
                    <pre className="bg-muted p-3 rounded text-xs overflow-auto">{JSON.stringify(drawerAlerta.metadata, null, 2)}</pre>
                  </div>
                )}
                <div className="space-y-2 pt-2 border-t">
                  {drawerAlerta.gmail_message_id && (
                    <a
                      href={`https://mail.google.com/mail/u/0/#all/${drawerAlerta.gmail_message_id}`}
                      target="_blank" rel="noreferrer"
                      className="flex items-center gap-2 text-primary hover:underline"
                    >
                      <Mail className="h-4 w-4" /> Abrir email no Gmail <ExternalLink className="h-3 w-3" />
                    </a>
                  )}
                  {drawerAlerta.calendar_event_id && (
                    <a
                      href={`https://calendar.google.com/calendar/u/0/r/eventedit/${drawerAlerta.calendar_event_id}`}
                      target="_blank" rel="noreferrer"
                      className="flex items-center gap-2 text-primary hover:underline"
                    >
                      <CalendarIcon className="h-4 w-4" /> Abrir evento no Calendar <ExternalLink className="h-3 w-3" />
                    </a>
                  )}
                </div>
                {drawerAlerta.erro_notificacao && (
                  <div className="bg-destructive/10 border border-destructive/30 rounded p-3">
                    <h4 className="font-semibold mb-1 flex items-center gap-2 text-destructive">
                      <AlertCircle className="h-4 w-4" /> Erro
                    </h4>
                    <pre className="text-xs whitespace-pre-wrap text-destructive">{drawerAlerta.erro_notificacao}</pre>
                  </div>
                )}
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
