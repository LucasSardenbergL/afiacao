import { useMemo, useState } from 'react';
import { formatDistanceToNow } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { CircleDollarSign, HeartPulse, Info, ListPlus, TrendingDown } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { EmptyState } from '@/components/EmptyState';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { CriarTarefaDialog } from '@/components/tarefas/CriarTarefaDialog';
import { useCompany } from '@/contexts/CompanyContext';
import { useUrlState } from '@/hooks/useUrlState';
import { useUtiContas, UTI_CRITERIOS, type SinalUti, type UtiConta } from '@/hooks/useUtiContas';
import { formatBRL } from '@/lib/reposicao';
import { formatDoc } from '@/lib/grupos/format';
import { track } from '@/lib/analytics';

function FrescorBadge({ label, at }: { label: string; at: string | null }) {
  return (
    <Badge variant="outline" className="text-[10px] font-normal text-muted-foreground">
      {label}:{' '}
      {at ? formatDistanceToNow(new Date(at), { locale: ptBR, addSuffix: true }) : 'sem registro'}
    </Badge>
  );
}

function SinalBadge({ ativo, label }: { ativo: SinalUti; label: string }) {
  if (ativo === null) {
    return <Badge variant="outline" className="text-[10px] text-muted-foreground border-dashed">{label}: sem dado</Badge>;
  }
  if (!ativo) {
    return <Badge variant="outline" className="text-[10px] text-muted-foreground">{label} ok</Badge>;
  }
  return <Badge className="text-[10px] bg-status-error/10 text-status-error border-status-error/30">{label}</Badge>;
}

export function IntelligenceUtiTab() {
  const { activeCompany } = useCompany();
  const { data, isLoading, error } = useUtiContas(true);
  const [filtros, setFiltros] = useUrlState({ lista: 'uti' });
  // Busca fica FORA da URL: pode conter CNPJ (PII não vai pra search params/logs).
  const [busca, setBusca] = useState('');
  const [tarefaCliente, setTarefaCliente] = useState<UtiConta | null>(null);

  const { uti, observacao, exposicao } = useMemo(() => {
    const contas = data?.contas ?? [];
    const utiRows = contas.filter((c) => c.status === 'uti');
    return {
      uti: utiRows,
      observacao: contas.filter((c) => c.status === 'observacao'),
      exposicao: utiRows.reduce((acc, c) => acc + c.vencido31, 0),
    };
  }, [data]);

  const visiveis = useMemo(() => {
    const base = filtros.lista === 'observacao' ? observacao : uti;
    const q = busca.trim().toLowerCase();
    if (!q) return base;
    const qDoc = q.replace(/\D/g, '');
    return base.filter((c) => c.nome.toLowerCase().includes(q) || (qDoc.length > 0 && (c.documento ?? '').includes(qDoc)));
  }, [uti, observacao, filtros.lista, busca]);

  if (isLoading) return <PageSkeleton variant="cockpit" />;
  if (error) {
    return <p className="text-sm text-status-error">Não consegui carregar a UTI: {error instanceof Error ? error.message : 'erro'}.</p>;
  }

  return (
    <div className="space-y-4">
      {/* Critérios explícitos — entrada e alta são determinísticos, não score mágico */}
      <div className="flex items-start gap-2 rounded-md border border-status-info/30 bg-status-info/5 px-3 py-2 text-xs text-muted-foreground">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-status-info" />
        <span>
          <strong>Entrada na UTI:</strong> {UTI_CRITERIOS.sinaisParaEntrar}+ sinais ativos entre churn (risco ≥ {UTI_CRITERIOS.churnRiskMin} ou saúde crítica),
          inadimplência (vencido há {UTI_CRITERIOS.diasVencidoMin}+ dias) e positivação (elegível sem pedido há {UTI_CRITERIOS.mesesSemPedidoMin}+ meses).{' '}
          <strong>Alta:</strong> nenhum sinal ativo. Sinal sem dado na fonte aparece como "sem dado" — não conta a favor nem contra.
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <FrescorBadge label="Scores" at={data?.frescor.scoresCalculatedAt ?? null} />
        <FrescorBadge label="Recebíveis (Omie)" at={data?.frescor.receberSyncAt ?? null} />
        <Badge variant="outline" className="text-[10px] font-normal text-muted-foreground">
          Positivação: {data?.frescor.positivacaoMes ? `mês ${data.frescor.positivacaoMes.slice(0, 7)}` : 'sem snapshot'}
        </Badge>
      </div>

      <div className="grid grid-cols-3 gap-2">
        <Card>
          <CardContent className="p-3">
            <p className="text-xs text-muted-foreground">Na UTI</p>
            <p className="mt-0.5 text-lg font-semibold tabular-nums text-status-error">{uti.length}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3">
            <p className="text-xs text-muted-foreground">Em observação</p>
            <p className="mt-0.5 text-lg font-semibold tabular-nums text-status-warning">{observacao.length}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3">
            <p className="text-xs text-muted-foreground">Exposição vencida 31+ (UTI)</p>
            <p className="mt-0.5 text-lg font-semibold tabular-nums">{formatBRL(exposicao)}</p>
          </CardContent>
        </Card>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant={filtros.lista !== 'observacao' ? 'default' : 'outline'}
            className="h-7 text-xs"
            onClick={() => setFiltros({ lista: 'uti' })}
          >
            UTI ({uti.length})
          </Button>
          <Button
            size="sm"
            variant={filtros.lista === 'observacao' ? 'default' : 'outline'}
            className="h-7 text-xs"
            onClick={() => setFiltros({ lista: 'observacao' })}
          >
            Observação ({observacao.length})
          </Button>
        </div>
        <Input
          placeholder="Buscar por nome ou CNPJ…"
          value={busca}
          onChange={(e) => setBusca(e.target.value)}
          className="h-7 w-56 text-xs"
        />
      </div>

      {visiveis.length === 0 ? (
        <EmptyState
          icon={HeartPulse}
          title={busca ? 'Nenhum cliente encontrado' : filtros.lista === 'observacao' ? 'Ninguém em observação' : 'UTI vazia'}
          description={
            busca
              ? 'Ajuste a busca ou troque de lista.'
              : 'Nenhum cliente atende os critérios de entrada no momento.'
          }
          tone="operational"
        />
      ) : (
        <div className="rounded-md border overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-xs">Cliente</TableHead>
                <TableHead className="text-xs">Sinais</TableHead>
                <TableHead className="text-xs text-right">Churn</TableHead>
                <TableHead className="text-xs text-right">Vencido 31+</TableHead>
                <TableHead className="text-xs text-right">Meses s/ pedido</TableHead>
                <TableHead className="text-xs text-right">Dias s/ comprar</TableHead>
                <TableHead className="text-xs text-right">Ação</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visiveis.map((c) => (
                <TableRow key={c.customerUserId}>
                  <TableCell className="py-1.5">
                    <p className="text-sm font-medium leading-tight">{c.nome}</p>
                    {c.documento && <p className="text-[11px] text-muted-foreground font-mono">{formatDoc(c.documento)}</p>}
                  </TableCell>
                  <TableCell className="py-1.5">
                    <div className="flex flex-wrap gap-1">
                      <SinalBadge ativo={c.sinalChurn} label="Churn" />
                      <SinalBadge ativo={c.sinalInadimplencia} label="Inadimpl." />
                      <SinalBadge ativo={c.sinalPositivacao} label="Positiv." />
                    </div>
                  </TableCell>
                  <TableCell className="py-1.5 text-right tabular-nums text-sm">
                    {c.churnRisk != null ? `${Math.round(c.churnRisk)}%` : '—'}
                  </TableCell>
                  <TableCell className={`py-1.5 text-right tabular-nums text-sm ${c.vencido31 > 0 ? 'text-status-error font-medium' : ''}`}>
                    {c.sinalInadimplencia === null ? 'sem dado' : formatBRL(c.vencido31)}
                  </TableCell>
                  <TableCell className="py-1.5 text-right tabular-nums text-sm">{c.mesesSemPedido ?? '—'}</TableCell>
                  <TableCell className="py-1.5 text-right tabular-nums text-sm">{c.diasSemComprar ?? '—'}</TableCell>
                  <TableCell className="py-1.5 text-right">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-6 text-xs"
                      onClick={() => {
                        track('inteligencia.uti_criar_tarefa', { sinais: c.sinaisAtivos });
                        setTarefaCliente(c);
                      }}
                    >
                      <ListPlus className="w-3 h-3 mr-1" /> Tarefa
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1"><HeartPulse className="w-3 h-3" /> churn = scores de carteira</span>
        <span className="inline-flex items-center gap-1"><CircleDollarSign className="w-3 h-3" /> inadimplência = títulos Omie por CNPJ</span>
        <span className="inline-flex items-center gap-1"><TrendingDown className="w-3 h-3" /> positivação = snapshot mensal</span>
      </div>

      <CriarTarefaDialog
        open={tarefaCliente !== null}
        onOpenChange={(o) => { if (!o) setTarefaCliente(null); }}
        cliente={tarefaCliente ? { customer_user_id: tarefaCliente.customerUserId, nome: tarefaCliente.nome } : null}
        assignedTo={tarefaCliente?.farmerId ?? ''}
        empresa={activeCompany}
      />
    </div>
  );
}
