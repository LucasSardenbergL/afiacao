// Painel Iceberg — aba de Governança (programa "back to basics").
// Portfólio de iniciativas: pipeline maturando ("abaixo da linha d'água") ×
// ganho recorrente comprovado ("acima"). Nenhum valor é fabricado: iniciativa
// sem estimativa/valor fica CONTADA à parte, nunca somada como zero.
import { useEffect, useMemo, useRef, useState } from 'react';
import { MountainSnow, Pencil, Plus, Trash2, Waves } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { EmptyState } from '@/components/EmptyState';
import { IniciativaDialog } from '@/components/governanca/IniciativaDialog';
import { useAuth } from '@/contexts/AuthContext';
import { COMPANIES } from '@/contexts/CompanyContext';
import { useStaffUsersWithDept } from '@/hooks/useDepartmentsAdmin';
import { useUrlState } from '@/hooks/useUrlState';
import {
  ALAVANCA_INICIATIVA,
  STATUS_INICIATIVA,
  STATUS_PIPELINE,
  resumirIceberg,
  useIniciativaMutations,
  useIniciativasIceberg,
  type IniciativaIceberg,
  type StatusIniciativa,
} from '@/hooks/useIniciativasIceberg';
import { formatBRL, formatDate } from '@/lib/reposicao';
import { track } from '@/lib/analytics';

const STATUS_BADGE: Record<StatusIniciativa, string> = {
  ideia: 'text-muted-foreground border-border',
  em_execucao: 'text-status-info border-status-info/40',
  maturando: 'text-status-info border-status-info/40',
  recorrente: 'text-status-success border-status-success/40',
  pausada: 'text-status-warning border-status-warning/40',
  cancelada: 'text-muted-foreground border-border line-through',
};

export default function GovernanceIniciativas() {
  const { user, isMaster } = useAuth();
  const { data: iniciativas, isLoading, error } = useIniciativasIceberg();
  const { data: staff } = useStaffUsersWithDept();
  const { excluir } = useIniciativaMutations();

  const [filtros, setFiltros] = useUrlState({ ini_empresa: 'todas', ini_status: 'ativas' });
  const [dialogAberto, setDialogAberto] = useState(false);
  const [editando, setEditando] = useState<IniciativaIceberg | null>(null);
  const [excluindo, setExcluindo] = useState<IniciativaIceberg | null>(null);

  const nomeDono = useMemo(() => {
    const map = new Map<string, string>();
    (staff ?? []).forEach((s) => map.set(s.user_id, s.name ?? s.email ?? '—'));
    return map;
  }, [staff]);

  const daEmpresa = useMemo(
    () =>
      (iniciativas ?? []).filter(
        (i) => filtros.ini_empresa === 'todas' || i.empresa === filtros.ini_empresa,
      ),
    [iniciativas, filtros.ini_empresa],
  );

  // KPIs refletem o portfólio da empresa filtrada; o filtro de status refina só a tabela.
  const resumo = useMemo(() => resumirIceberg(daEmpresa), [daEmpresa]);

  const visiveis = useMemo(() => {
    if (filtros.ini_status === 'todas') return daEmpresa;
    if (filtros.ini_status === 'ativas') {
      return daEmpresa.filter((i) => i.status !== 'pausada' && i.status !== 'cancelada');
    }
    return daEmpresa.filter((i) => i.status === filtros.ini_status);
  }, [daEmpresa, filtros.ini_status]);

  // Adoção: 1 evento por montagem com dados (não por re-render).
  const jaTrackeou = useRef(false);
  useEffect(() => {
    if (iniciativas && !jaTrackeou.current) {
      jaTrackeou.current = true;
      track('governanca.iceberg_aberto', { total: iniciativas.length });
    }
  }, [iniciativas]);

  if (isLoading) return <PageSkeleton variant="cockpit" />;

  if (error) {
    return (
      <EmptyState
        icon={MountainSnow}
        title="Não deu para carregar as iniciativas"
        description={error instanceof Error ? error.message : 'Erro ao consultar o banco.'}
      />
    );
  }

  const ativas = STATUS_PIPELINE.reduce((n, s) => n + resumo.porStatus[s], 0);
  // null = bucket habitado sem nenhum valor conhecido → "—" (nunca R$0 fabricado).
  const valorMensal = (v: number | null) => (v === null ? '—' : `${formatBRL(v)}/mês`);

  const kpis = [
    {
      label: 'Recorrente comprovado',
      value: valorMensal(resumo.recorrenteMensal),
      sub:
        resumo.recorrentesSemValor > 0
          ? `${resumo.recorrentesSemValor} recorrente(s) sem valor registrado`
          : 'Acima da linha d’água',
      icon: MountainSnow,
    },
    {
      label: 'Pipeline maturando',
      value: valorMensal(resumo.pipelineMensal),
      sub:
        resumo.pipelineSemEstimativa > 0
          ? `${resumo.pipelineSemEstimativa} sem estimativa (não somam)`
          : 'Abaixo da linha d’água',
      icon: Waves,
    },
    { label: 'Em andamento', value: String(ativas), sub: 'ideia · execução · maturando', icon: null },
    {
      label: 'Recorrentes',
      value: String(resumo.porStatus.recorrente),
      sub: 'com evidência registrada',
      icon: null,
    },
  ];

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {kpis.map((k) => (
          <Card key={k.label} className="border-border">
            <CardContent className="pt-4">
              <div className="flex items-center justify-between">
                <div className="text-xs text-muted-foreground">{k.label}</div>
                {k.icon && <k.icon className="h-4 w-4 text-muted-foreground opacity-60" />}
              </div>
              <div className="text-xl font-bold mt-1">{k.value}</div>
              <div className="text-[11px] text-muted-foreground mt-0.5">{k.sub}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="flex flex-col sm:flex-row gap-2 sm:items-center justify-between">
        <div className="flex gap-2">
          <Select
            value={filtros.ini_empresa}
            onValueChange={(v) => setFiltros({ ini_empresa: v })}
          >
            <SelectTrigger className="w-[150px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="todas">Todas as empresas</SelectItem>
              {(Object.keys(COMPANIES) as Array<keyof typeof COMPANIES>).map((c) => (
                <SelectItem key={c} value={c}>
                  {COMPANIES[c].name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={filtros.ini_status} onValueChange={(v) => setFiltros({ ini_status: v })}>
            <SelectTrigger className="w-[150px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ativas">Ativas</SelectItem>
              <SelectItem value="todas">Todas</SelectItem>
              {Object.entries(STATUS_INICIATIVA).map(([k, label]) => (
                <SelectItem key={k} value={k}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {isMaster && (
          <Button
            size="sm"
            onClick={() => {
              setEditando(null);
              setDialogAberto(true);
            }}
          >
            <Plus className="w-4 h-4 mr-1" />
            Nova iniciativa
          </Button>
        )}
      </div>

      {visiveis.length === 0 ? (
        <EmptyState
          icon={MountainSnow}
          title="Nenhuma iniciativa aqui"
          description={
            isMaster
              ? 'Cadastre a primeira iniciativa do iceberg: o que está sendo construído e quanto deve render por mês.'
              : 'Nenhuma iniciativa cadastrada para este filtro.'
          }
          actionLabel={isMaster ? 'Nova iniciativa' : undefined}
          onAction={
            isMaster
              ? () => {
                  setEditando(null);
                  setDialogAberto(true);
                }
              : undefined
          }
        />
      ) : (
        <div className="border border-border rounded-lg overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Iniciativa</TableHead>
                <TableHead>Empresa</TableHead>
                <TableHead>Dono</TableHead>
                <TableHead className="text-right">Esperado/mês</TableHead>
                <TableHead className="text-right">Recorrente/mês</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Início</TableHead>
                <TableHead className="w-[88px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {visiveis.map((i) => {
                const podeEditar = isMaster || (user?.id != null && i.dono_id === user.id);
                return (
                  <TableRow key={i.id}>
                    <TableCell className="max-w-[260px]">
                      <div className="font-medium truncate" title={i.descricao ?? i.titulo}>
                        {i.titulo}
                      </div>
                      <div className="text-[11px] text-muted-foreground">
                        {ALAVANCA_INICIATIVA[i.alavanca as keyof typeof ALAVANCA_INICIATIVA] ??
                          i.alavanca}
                        {i.evidencia && (
                          <span title={i.evidencia}> · evidência registrada</span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-xs">
                      {COMPANIES[i.empresa as keyof typeof COMPANIES]?.name ?? i.empresa}
                    </TableCell>
                    <TableCell className="text-xs">
                      {i.dono_id ? nomeDono.get(i.dono_id) ?? '—' : '—'}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-xs">
                      {formatBRL(i.ganho_esperado_mensal)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-xs font-medium">
                      {formatBRL(i.ganho_recorrente_mensal)}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant="outline"
                        className={STATUS_BADGE[i.status as StatusIniciativa] ?? ''}
                      >
                        {STATUS_INICIATIVA[i.status as StatusIniciativa] ?? i.status}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {i.inicio_em ? formatDate(i.inicio_em) : '—'}
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-1 justify-end">
                        {podeEditar && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7"
                            onClick={() => {
                              setEditando(i);
                              setDialogAberto(true);
                            }}
                          >
                            <Pencil className="w-3.5 h-3.5" />
                          </Button>
                        )}
                        {isMaster && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-status-error"
                            onClick={() => setExcluindo(i)}
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      <IniciativaDialog open={dialogAberto} onOpenChange={setDialogAberto} iniciativa={editando} />

      <AlertDialog open={excluindo !== null} onOpenChange={(o) => !o && setExcluindo(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir iniciativa?</AlertDialogTitle>
            <AlertDialogDescription>
              "{excluindo?.titulo}" será removida do painel. Se ela só saiu do ar temporariamente,
              prefira o status "Pausada".
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (!excluindo) return;
                excluir.mutate(excluindo.id, {
                  onSuccess: () => {
                    toast.success('Iniciativa excluída.');
                    track('governanca.iniciativa_excluida', { empresa: excluindo.empresa });
                  },
                  onError: (e: Error) => toast.error(`Falha ao excluir: ${e.message}`),
                });
                setExcluindo(null);
              }}
            >
              Excluir
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
