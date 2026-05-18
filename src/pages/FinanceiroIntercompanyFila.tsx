import { useState } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  useIcMatches,
  useResolveIcMatch,
  useReconcileIcNow,
  type IcMatch,
} from '@/hooks/useIcMatches';
import { toast } from 'sonner';
import { RefreshCw, CheckCircle2, Ban } from 'lucide-react';

const STATUS_LABELS: Record<IcMatch['status'], string> = {
  auto_matched: 'Auto',
  manual_matched: 'Manual',
  divergencia_valor: 'Diff valor',
  divergencia_data: 'Diff data',
  sem_contrapartida: 'Sem par',
  duplicidade_possivel: 'Duplicidade',
  desconsiderado: 'Ignorado',
};

const STATUS_VARIANT: Record<
  IcMatch['status'],
  'default' | 'secondary' | 'destructive' | 'outline'
> = {
  auto_matched: 'default',
  manual_matched: 'default',
  divergencia_valor: 'destructive',
  divergencia_data: 'destructive',
  sem_contrapartida: 'destructive',
  duplicidade_possivel: 'destructive',
  desconsiderado: 'outline',
};

export default function FinanceiroIntercompanyFila() {
  const [tab, setTab] = useState<IcMatch['status'] | 'all'>('divergencia_valor');
  const { data, isLoading } = useIcMatches(tab === 'all' ? undefined : tab);
  const resolve = useResolveIcMatch();
  const reconcile = useReconcileIcNow();

  const handleReconcile = async () => {
    try {
      const r = await reconcile.mutateAsync();
      const total = (r as { total_matches?: number })?.total_matches ?? 0;
      toast.success(`Reconciliado: ${total} matches`);
    } catch (err) {
      toast.error(`Falha: ${String((err as Error).message ?? err)}`);
    }
  };

  const handleResolve = async (
    id: string,
    status: IcMatch['status'],
    obs?: string
  ) => {
    try {
      await resolve.mutateAsync({ id, status, observacao: obs });
      const actionLabel =
        status === 'manual_matched'
          ? 'Aprovado'
          : status === 'desconsiderado'
            ? 'Ignorado'
            : 'Atualizado';
      toast.success(actionLabel);
    } catch (err) {
      toast.error(`Erro: ${String((err as Error).message ?? err)}`);
    }
  };

  return (
    <div className="container mx-auto py-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-display font-medium">
            Fila de Reconciliação IC
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Gerenciar matches entre contas a receber e contas a pagar
            intercompany
          </p>
        </div>
        <Button
          onClick={handleReconcile}
          disabled={reconcile.isPending}
          size="sm"
          variant="outline"
        >
          <RefreshCw className="mr-2 h-4 w-4" />
          {reconcile.isPending ? 'Reconciliando…' : 'Reconciliar agora'}
        </Button>
      </div>

      <Tabs
        value={tab}
        onValueChange={(v) => setTab(v as IcMatch['status'] | 'all')}
      >
        <TabsList>
          <TabsTrigger value="divergencia_valor">Diff valor</TabsTrigger>
          <TabsTrigger value="divergencia_data">Diff data</TabsTrigger>
          <TabsTrigger value="sem_contrapartida">Sem par</TabsTrigger>
          <TabsTrigger value="duplicidade_possivel">Duplicidade</TabsTrigger>
          <TabsTrigger value="auto_matched">OK</TabsTrigger>
          <TabsTrigger value="all">Tudo</TabsTrigger>
        </TabsList>
        <TabsContent value={tab}>
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">
                {data?.length ?? 0} registros
              </CardTitle>
            </CardHeader>
            <CardContent>
              {isLoading && (
                <div className="text-sm text-muted-foreground">
                  Carregando…
                </div>
              )}
              {!isLoading && (!data || data.length === 0) && (
                <div className="text-sm text-muted-foreground py-8 text-center">
                  Nenhum registro encontrado
                </div>
              )}
              {data && data.length > 0 && (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Origem → Destino</TableHead>
                      <TableHead>Valor origem</TableHead>
                      <TableHead>Valor destino</TableHead>
                      <TableHead>Diff</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Ações</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.map((m) => (
                      <TableRow key={m.id}>
                        <TableCell className="font-mono text-xs">
                          {m.empresa_origem} → {m.empresa_destino}
                        </TableCell>
                        <TableCell className="font-tabular text-sm">
                          {m.valor_origem?.toLocaleString('pt-BR', {
                            minimumFractionDigits: 2,
                            maximumFractionDigits: 2,
                          }) ?? '—'}
                        </TableCell>
                        <TableCell className="font-tabular text-sm">
                          {m.valor_destino?.toLocaleString('pt-BR', {
                            minimumFractionDigits: 2,
                            maximumFractionDigits: 2,
                          }) ?? '—'}
                        </TableCell>
                        <TableCell className="font-tabular text-sm">
                          {m.diff_valor.toLocaleString('pt-BR', {
                            minimumFractionDigits: 2,
                            maximumFractionDigits: 2,
                          })}
                        </TableCell>
                        <TableCell>
                          <Badge variant={STATUS_VARIANT[m.status]}>
                            {STATUS_LABELS[m.status]}
                          </Badge>
                        </TableCell>
                        <TableCell className="text-right">
                          {m.status !== 'manual_matched' &&
                            m.status !== 'desconsiderado' && (
                              <div className="flex gap-1 justify-end">
                                <Button
                                  size="sm"
                                  variant="outline"
                                  onClick={() =>
                                    handleResolve(m.id, 'manual_matched')
                                  }
                                  disabled={resolve.isPending}
                                  className="h-7 text-xs"
                                >
                                  <CheckCircle2 className="mr-1 h-3 w-3" />
                                  Aprovar
                                </Button>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  onClick={() =>
                                    handleResolve(m.id, 'desconsiderado')
                                  }
                                  disabled={resolve.isPending}
                                  className="h-7 text-xs"
                                >
                                  <Ban className="mr-1 h-3 w-3" />
                                  Ignorar
                                </Button>
                              </div>
                            )}
                          {(m.status === 'manual_matched' ||
                            m.status === 'desconsiderado') && (
                            <div className="text-xs text-muted-foreground">
                              {m.status === 'manual_matched'
                                ? 'Aprovado'
                                : 'Ignorado'}
                            </div>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}
