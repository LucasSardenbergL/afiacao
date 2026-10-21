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
import { estadoDeLeitura, naoConsegui } from '@/lib/leitura/estado-de-leitura';
import { acoesDaLinhaIc } from '@/lib/financeiro/fila-intercompany';
import { useAuth } from '@/contexts/AuthContext';
import { AvisoLeituraFalhou } from '@/components/leitura/AvisoLeituraFalhou';
import { toast } from 'sonner';
import { RefreshCw, CheckCircle2, Ban, Gift, Undo2 } from 'lucide-react';

const STATUS_LABELS: Record<IcMatch['status'], string> = {
  auto_matched: 'Auto',
  manual_matched: 'Manual',
  divergencia_valor: 'Diff valor',
  divergencia_data: 'Diff data',
  sem_contrapartida: 'Sem par',
  duplicidade_possivel: 'Duplicidade',
  desconsiderado: 'Ignorado',
  intragrupo_sem_cobranca: 'Sem cobrança',
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
  intragrupo_sem_cobranca: 'secondary',
};

const TOAST_ACAO: Partial<Record<IcMatch['status'], string>> = {
  manual_matched: 'Aprovado',
  desconsiderado: 'Ignorado',
  intragrupo_sem_cobranca: 'Marcado como venda sem cobrança — o DRE consolidado elimina o CP do CMV do destino',
  sem_contrapartida: 'Marcação desfeita — a próxima reconciliação refaz a linha',
};

export default function FinanceiroIntercompanyFila() {
  const [tab, setTab] = useState<IcMatch['status'] | 'all'>('divergencia_valor');
  const filaQuery = useIcMatches(tab === 'all' ? undefined : tab);
  const { data, isLoading } = filaQuery;
  // O sub-tipo que MENTE: `!data || data.length === 0` casa tanto o vazio real quanto a
  // leitura que não aconteceu, e a tela AFIRMA "Nenhum registro encontrado" nos dois casos.
  // Sumir é ambíguo; afirmar o vazio sobre uma fila de reconciliação é uma frase falsa.
  const estadoFila = estadoDeLeitura(filaQuery);
  const resolve = useResolveIcMatch();
  const reconcile = useReconcileIcNow();
  // A marcação "sem cobrança" é decisão do founder: o trigger do banco exige master; a tela só não oferece.
  const { isMaster } = useAuth();

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
      toast.success(TOAST_ACAO[status] ?? 'Atualizado');
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
          <TabsTrigger value="intragrupo_sem_cobranca">Sem cobrança</TabsTrigger>
          <TabsTrigger value="auto_matched">OK</TabsTrigger>
          <TabsTrigger value="all">Tudo</TabsTrigger>
        </TabsList>
        <TabsContent value={tab}>
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">
                {/* `{data?.length ?? 0}` fabricava um zero a partir de ausência
                    (`Number(null) === 0`) — o contador é a mesma mentira em números. */}
                {naoConsegui(estadoFila) ? '—' : data?.length ?? 0} registros
              </CardTitle>
            </CardHeader>
            <CardContent>
              {naoConsegui(estadoFila) && (
                <AvisoLeituraFalhou
                  oque="a fila de reconciliação intercompany"
                  estado={estadoFila}
                  variante="bloco"
                  testId="aviso-ic-fila"
                  className="mb-0"
                />
              )}
              {isLoading && (
                <div className="text-sm text-muted-foreground">
                  Carregando…
                </div>
              )}
              {!naoConsegui(estadoFila) && !isLoading && (!data || data.length === 0) && (
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
                          {(() => {
                            const acoes = acoesDaLinhaIc(m, isMaster);
                            if (acoes.length === 0) {
                              return (
                                <div className="text-xs text-muted-foreground">
                                  {m.status === 'manual_matched'
                                    ? 'Aprovado'
                                    : m.status === 'intragrupo_sem_cobranca'
                                      ? 'Sem cobrança (decisão do founder)'
                                      : 'Ignorado'}
                                </div>
                              );
                            }
                            return (
                              <div className="flex gap-1 justify-end">
                                {acoes.includes('aprovar') && (
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() => handleResolve(m.id, 'manual_matched')}
                                    disabled={resolve.isPending}
                                    className="h-7 text-xs"
                                  >
                                    <CheckCircle2 className="mr-1 h-3 w-3" />
                                    Aprovar
                                  </Button>
                                )}
                                {acoes.includes('sem_cobranca') && (
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() =>
                                      handleResolve(
                                        m.id,
                                        'intragrupo_sem_cobranca',
                                        'venda intragrupo sem cobrança (decisão do founder)'
                                      )
                                    }
                                    disabled={resolve.isPending}
                                    className="h-7 text-xs"
                                    title="Venda entre empresas do grupo que não será cobrada: o DRE consolidado elimina este CP do CMV do destino e o resultado do grupo sobe esse valor"
                                  >
                                    <Gift className="mr-1 h-3 w-3" />
                                    Sem cobrança
                                  </Button>
                                )}
                                {acoes.includes('ignorar') && (
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() => handleResolve(m.id, 'desconsiderado')}
                                    disabled={resolve.isPending}
                                    className="h-7 text-xs"
                                  >
                                    <Ban className="mr-1 h-3 w-3" />
                                    Ignorar
                                  </Button>
                                )}
                                {acoes.includes('desfazer_sem_cobranca') && (
                                  <Button
                                    size="sm"
                                    variant="ghost"
                                    onClick={() => handleResolve(m.id, 'sem_contrapartida')}
                                    disabled={resolve.isPending}
                                    className="h-7 text-xs"
                                  >
                                    <Undo2 className="mr-1 h-3 w-3" />
                                    Desfazer
                                  </Button>
                                )}
                              </div>
                            );
                          })()}
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
