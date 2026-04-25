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
  Sheet, SheetContent, SheetHeader, SheetTitle,
} from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Zap, Mail, Calendar as CalendarIcon, ExternalLink, AlertCircle } from 'lucide-react';
import { toast } from 'sonner';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';

type Severidade = 'info' | 'atencao' | 'urgente';

type AlertaRow = {
  id: number;
  empresa: string;
  fornecedor_nome: string | null;
  tipo: string;
  severidade: Severidade;
  titulo: string;
  mensagem: string | null;
  status: string | null;
  tentativas: number | null;
  criado_em: string;
  notificado_em: string | null;
  gmail_message_id: string | null;
  calendar_evento_id: string | null;
  erro_notificacao: string | null;
  metadata: Record<string, unknown> | null;
  data_evento: string | null;
};

const SELECT_COLUMNS =
  'id, empresa, fornecedor_nome, tipo, severidade, titulo, mensagem, status, tentativas, criado_em, notificado_em, gmail_message_id, calendar_evento_id, erro_notificacao, metadata, data_evento';

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

function SeveridadeBadge({ s }: { s: Severidade }) {
  if (s === 'urgente') return <Badge className="bg-destructive text-destructive-foreground">urgente</Badge>;
  if (s === 'atencao') return <Badge className="bg-yellow-500 text-white">atenção</Badge>;
  return <Badge variant="secondary">info</Badge>;
}

function StatusBadge({ s }: { s: string | null }) {
  if (s === 'notificado') return <Badge className="bg-green-600 text-white">notificado</Badge>;
  if (s === 'falha_notificacao') return <Badge variant="destructive">falha</Badge>;
  return <Badge variant="outline">{s ?? '—'}</Badge>;
}

export default function AdminNotificacoes() {
  const qc = useQueryClient();
  const [drawerAlerta, setDrawerAlerta] = useState<AlertaRow | null>(null);

  const [filtroSev, setFiltroSev] = useState<string>('__all__');
  const [filtroEmpresa, setFiltroEmpresa] = useState<string>('__all__');
  const [filtroTipo, setFiltroTipo] = useState<string>('__all__');

  // Pendentes
  const { data: pendentes, isLoading: loadingPend } = useQuery({
    queryKey: ['notificacoes', 'pendentes'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('fornecedor_alerta')
        .select(SELECT_COLUMNS)
        .eq('status', 'pendente_notificacao')
        .order('criado_em', { ascending: false })
        .limit(200);
      if (error) throw error;
      return data as unknown as AlertaRow[];
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
        .select(SELECT_COLUMNS)
        .in('status', ['notificado', 'falha_notificacao'])
        .gte('criado_em', since)
        .order('notificado_em', { ascending: false, nullsFirst: false })
        .limit(500);
      if (error) throw error;
      return data as unknown as AlertaRow[];
    },
    refetchInterval: 60_000,
  });

  // Estatísticas (30 dias completos para gráfico)
  const { data: stats30, isLoading: loadingStats } = useQuery({
    queryKey: ['notificacoes', 'stats30'],
    queryFn: async () => {
      const since = new Date(Date.now() - 30 * 24 * 3600_000).toISOString();
      const { data, error } = await supabase
        .from('fornecedor_alerta')
        .select('id, status, criado_em, tentativas')
        .gte('criado_em', since)
        .limit(5000);
      if (error) throw error;
      return data as Array<{ id: number; status: string | null; criado_em: string; tentativas: number | null }>;
    },
    refetchInterval: 60_000,
  });

  const dispatchMut = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke('dispatch-notifications', {
        body: {},
      });
      if (error) throw error;
      return data as { processados: number; sucesso?: number; falhas?: number };
    },
    onSuccess: (data) => {
      const proc = data?.processados ?? 0;
      const ok = data?.sucesso ?? 0;
      const fail = data?.falhas ?? 0;
      toast.success(`${proc} processados, ${ok} sucesso, ${fail} falhas`);
      qc.invalidateQueries({ queryKey: ['notificacoes'] });
    },
    onError: (err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Falha ao disparar: ${msg}`);
    },
  });

  // Opções dos filtros (derivadas de pendentes)
  const empresasOpts = useMemo(
    () => Array.from(new Set((pendentes ?? []).map((a) => a.empresa).filter(Boolean))),
    [pendentes],
  );
  const tiposOpts = useMemo(
    () => Array.from(new Set((pendentes ?? []).map((a) => a.tipo).filter(Boolean))),
    [pendentes],
  );

  const pendentesFiltrados = useMemo(() => {
    return (pendentes ?? []).filter((a) => {
      if (filtroSev !== '__all__' && a.severidade !== filtroSev) return false;
      if (filtroEmpresa !== '__all__' && a.empresa !== filtroEmpresa) return false;
      if (filtroTipo !== '__all__' && a.tipo !== filtroTipo) return false;
      return true;
    });
  }, [pendentes, filtroSev, filtroEmpresa, filtroTipo]);

  // Stats
  const total7d = useMemo(() => {
    const cutoff = Date.now() - 7 * 24 * 3600_000;
    return (stats30 ?? []).filter((a) => new Date(a.criado_em).getTime() >= cutoff).length;
  }, [stats30]);

  const taxaSucesso = useMemo(() => {
    const finais = (stats30 ?? []).filter((a) => a.status === 'notificado' || a.status === 'falha_notificacao');
    if (finais.length === 0) return 0;
    const ok = finais.filter((a) => a.status === 'notificado').length;
    return Math.round((ok / finais.length) * 100);
  }, [stats30]);

  const esgotados = useMemo(() => {
    return (stats30 ?? []).filter((a) => a.status === 'falha_notificacao' && (a.tentativas ?? 0) >= 3).length;
  }, [stats30]);

  // Stack chart data por dia
  const chartData = useMemo(() => {
    const buckets: Record<string, { dia: string; notificado: number; pendente: number; falha: number }> = {};
    for (let i = 29; i >= 0; i--) {
      const d = new Date(Date.now() - i * 24 * 3600_000);
      const key = d.toISOString().slice(0, 10);
      buckets[key] = { dia: key.slice(5), notificado: 0, pendente: 0, falha: 0 };
    }
    for (const a of stats30 ?? []) {
      const key = a.criado_em.slice(0, 10);
      const b = buckets[key];
      if (!b) continue;
      if (a.status === 'notificado') b.notificado++;
      else if (a.status === 'falha_notificacao') b.falha++;
      else b.pendente++;
    }
    return Object.values(buckets);
  }, [stats30]);

  return (
    <div className="container mx-auto p-4 lg:p-6 space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Notificações</h1>
          <p className="text-sm text-muted-foreground">
            Disparo de alertas via Gmail + Google Calendar (sobre fornecedor_alerta).
          </p>
        </div>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button disabled={dispatchMut.isPending}>
              <Zap className="w-4 h-4 mr-2" />
              {dispatchMut.isPending ? 'Disparando...' : 'Disparar agora'}
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Disparar notificações</AlertDialogTitle>
              <AlertDialogDescription>
                Isso vai processar todos os alertas pendentes imediatamente. Confirma?
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancelar</AlertDialogCancel>
              <AlertDialogAction onClick={() => dispatchMut.mutate()}>Disparar</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>

      <Tabs defaultValue="pendentes">
        <TabsList>
          <TabsTrigger value="pendentes">
            Pendentes {pendentes ? `(${pendentes.length})` : ''}
          </TabsTrigger>
          <TabsTrigger value="historico">Histórico</TabsTrigger>
          <TabsTrigger value="stats">Estatísticas</TabsTrigger>
        </TabsList>

        {/* PENDENTES */}
        <TabsContent value="pendentes" className="space-y-4">
          <Card>
            <CardHeader className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <CardTitle className="text-base">Alertas pendentes</CardTitle>
              <div className="flex flex-wrap gap-2">
                <Select value={filtroSev} onValueChange={setFiltroSev}>
                  <SelectTrigger className="w-[150px]"><SelectValue placeholder="Severidade" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__all__">Todas severidades</SelectItem>
                    <SelectItem value="info">info</SelectItem>
                    <SelectItem value="atencao">atenção</SelectItem>
                    <SelectItem value="urgente">urgente</SelectItem>
                  </SelectContent>
                </Select>
                <Select value={filtroEmpresa} onValueChange={setFiltroEmpresa}>
                  <SelectTrigger className="w-[150px]"><SelectValue placeholder="Empresa" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__all__">Todas empresas</SelectItem>
                    {empresasOpts.map((e) => <SelectItem key={e} value={e}>{e}</SelectItem>)}
                  </SelectContent>
                </Select>
                <Select value={filtroTipo} onValueChange={setFiltroTipo}>
                  <SelectTrigger className="w-[180px]"><SelectValue placeholder="Tipo" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__all__">Todos tipos</SelectItem>
                    {tiposOpts.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </CardHeader>
            <CardContent>
              {loadingPend ? (
                <Skeleton className="h-40 w-full" />
              ) : pendentesFiltrados.length === 0 ? (
                <p className="text-sm text-muted-foreground py-6 text-center">Nenhum alerta pendente.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Severidade</TableHead>
                      <TableHead>Empresa</TableHead>
                      <TableHead>Tipo</TableHead>
                      <TableHead>Título</TableHead>
                      <TableHead>Fornecedor</TableHead>
                      <TableHead>Criado</TableHead>
                      <TableHead className="text-right">Tentativas</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {pendentesFiltrados.map((a) => (
                      <TableRow
                        key={a.id}
                        className="cursor-pointer"
                        onClick={() => setDrawerAlerta(a)}
                      >
                        <TableCell><SeveridadeBadge s={a.severidade} /></TableCell>
                        <TableCell><Badge variant="outline">{a.empresa}</Badge></TableCell>
                        <TableCell className="text-xs">{a.tipo}</TableCell>
                        <TableCell className="max-w-[320px] truncate">{a.titulo}</TableCell>
                        <TableCell className="text-xs">{a.fornecedor_nome ?? '—'}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">{relTime(a.criado_em)}</TableCell>
                        <TableCell className="text-right">{a.tentativas ?? 0}/3</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* HISTÓRICO */}
        <TabsContent value="historico" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Histórico (últimos 30 dias)</CardTitle>
            </CardHeader>
            <CardContent>
              {loadingHist ? (
                <Skeleton className="h-40 w-full" />
              ) : (historico ?? []).length === 0 ? (
                <p className="text-sm text-muted-foreground py-6 text-center">Sem histórico no período.</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Status</TableHead>
                      <TableHead>Severidade</TableHead>
                      <TableHead>Empresa</TableHead>
                      <TableHead>Tipo</TableHead>
                      <TableHead>Título</TableHead>
                      <TableHead>Notificado em</TableHead>
                      <TableHead className="text-right">Ações</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(historico ?? []).map((a) => (
                      <TableRow key={a.id}>
                        <TableCell><StatusBadge s={a.status} /></TableCell>
                        <TableCell><SeveridadeBadge s={a.severidade} /></TableCell>
                        <TableCell><Badge variant="outline">{a.empresa}</Badge></TableCell>
                        <TableCell className="text-xs">{a.tipo}</TableCell>
                        <TableCell className="max-w-[320px] truncate">{a.titulo}</TableCell>
                        <TableCell className="text-xs">{fmtDate(a.notificado_em)}</TableCell>
                        <TableCell className="text-right">
                          <Button size="sm" variant="ghost" onClick={() => setDrawerAlerta(a)}>
                            Ver detalhes
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* STATS */}
        <TabsContent value="stats" className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <Card>
              <CardHeader><CardTitle className="text-sm">Total últimos 7 dias</CardTitle></CardHeader>
              <CardContent>
                {loadingStats ? <Skeleton className="h-8 w-20" /> : <div className="text-3xl font-bold">{total7d}</div>}
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle className="text-sm">Taxa de sucesso</CardTitle></CardHeader>
              <CardContent>
                {loadingStats ? <Skeleton className="h-8 w-20" /> : <div className="text-3xl font-bold">{taxaSucesso}%</div>}
              </CardContent>
            </Card>
            <Card>
              <CardHeader><CardTitle className="text-sm">Alertas esgotados (3 tentativas)</CardTitle></CardHeader>
              <CardContent>
                {loadingStats ? <Skeleton className="h-8 w-20" /> : <div className="text-3xl font-bold">{esgotados}</div>}
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader><CardTitle className="text-base">Distribuição diária (30 dias)</CardTitle></CardHeader>
            <CardContent style={{ height: 320 }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="dia" />
                  <YAxis />
                  <Tooltip />
                  <Legend />
                  <Bar dataKey="notificado" stackId="a" fill="hsl(142 71% 45%)" name="notificado" />
                  <Bar dataKey="pendente" stackId="a" fill="hsl(45 93% 47%)" name="pendente" />
                  <Bar dataKey="falha" stackId="a" fill="hsl(0 84% 60%)" name="falha" />
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* DRAWER */}
      <Sheet open={!!drawerAlerta} onOpenChange={(o) => !o && setDrawerAlerta(null)}>
        <SheetContent className="overflow-y-auto sm:max-w-lg">
          {drawerAlerta && (
            <>
              <SheetHeader>
                <SheetTitle className="flex items-center gap-2">
                  <SeveridadeBadge s={drawerAlerta.severidade} />
                  <span className="truncate">{drawerAlerta.titulo}</span>
                </SheetTitle>
              </SheetHeader>

              <div className="space-y-4 mt-4 text-sm">
                <div className="flex flex-wrap gap-2">
                  <Badge variant="outline">{drawerAlerta.empresa}</Badge>
                  <Badge variant="secondary">{drawerAlerta.tipo}</Badge>
                  <StatusBadge s={drawerAlerta.status} />
                </div>

                {drawerAlerta.fornecedor_nome && (
                  <div><span className="font-medium">Fornecedor: </span>{drawerAlerta.fornecedor_nome}</div>
                )}

                <div>
                  <div className="font-medium mb-1">Mensagem</div>
                  <div className="whitespace-pre-wrap text-muted-foreground">
                    {drawerAlerta.mensagem || '(sem mensagem)'}
                  </div>
                </div>

                {drawerAlerta.data_evento && (
                  <div>
                    <span className="font-medium">Evento agendado: </span>
                    {fmtDate(drawerAlerta.data_evento)}
                  </div>
                )}

                {drawerAlerta.metadata && Object.keys(drawerAlerta.metadata).length > 0 && (
                  <div>
                    <div className="font-medium mb-1">Metadata</div>
                    <pre className="bg-muted rounded p-2 text-xs overflow-x-auto">
                      {JSON.stringify(drawerAlerta.metadata, null, 2)}
                    </pre>
                  </div>
                )}

                <div className="grid grid-cols-2 gap-3 text-xs text-muted-foreground">
                  <div><div className="font-medium text-foreground">Criado</div>{fmtDate(drawerAlerta.criado_em)}</div>
                  <div><div className="font-medium text-foreground">Notificado</div>{fmtDate(drawerAlerta.notificado_em)}</div>
                  <div><div className="font-medium text-foreground">Tentativas</div>{drawerAlerta.tentativas ?? 0}/3</div>
                  <div><div className="font-medium text-foreground">Alerta ID</div>{drawerAlerta.id}</div>
                </div>

                <div className="flex flex-wrap gap-2 pt-2">
                  {drawerAlerta.gmail_message_id && (
                    <Button asChild variant="outline" size="sm">
                      <a
                        href={`https://mail.google.com/mail/u/0/#all/${drawerAlerta.gmail_message_id}`}
                        target="_blank" rel="noreferrer"
                      >
                        <Mail className="w-3 h-3 mr-1" /> Abrir no Gmail <ExternalLink className="w-3 h-3 ml-1" />
                      </a>
                    </Button>
                  )}
                  {drawerAlerta.calendar_evento_id && (
                    <Button asChild variant="outline" size="sm">
                      <a
                        href={`https://calendar.google.com/calendar/u/0/r/eventedit/${drawerAlerta.calendar_evento_id}`}
                        target="_blank" rel="noreferrer"
                      >
                        <CalendarIcon className="w-3 h-3 mr-1" /> Abrir no Calendar <ExternalLink className="w-3 h-3 ml-1" />
                      </a>
                    </Button>
                  )}
                </div>

                {drawerAlerta.erro_notificacao && (
                  <div className="border border-destructive/30 bg-destructive/5 rounded p-3">
                    <div className="flex items-center gap-2 font-medium text-destructive mb-1">
                      <AlertCircle className="w-4 h-4" /> Erro de notificação
                    </div>
                    <div className="text-xs text-destructive/80 whitespace-pre-wrap">
                      {drawerAlerta.erro_notificacao}
                    </div>
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
