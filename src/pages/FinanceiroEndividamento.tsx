// src/pages/FinanceiroEndividamento.tsx
// F1 Módulo de Endividamento — página master-only: cadastro de dívidas + indicadores + DSCR-caixa.
// Espelha FinanceiroFunding.tsx (header, seletor de empresa, PageSkeleton, Card/Table, brl).
import { useMemo, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useCompany, COMPANIES } from '@/contexts/CompanyContext';
import { useCashflowProjection } from '@/hooks/useCashflowProjection';
import {
  useDividas,
  useParcelas,
  useCompletude,
  useDeleteDivida,
  useSetCompletude,
} from '@/hooks/useEndividamento';
import { DividaFormDialog } from '@/components/financeiro/endividamento/DividaFormDialog';
import { IndicadoresEndividamento } from '@/components/financeiro/endividamento/IndicadoresEndividamento';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { EmptyState } from '@/components/EmptyState';
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
import { Landmark, Plus, Pencil, Trash2, CheckCircle2 } from 'lucide-react';
import { saldoDevedorEmAberto } from '@/lib/financeiro/endividamento-helpers';
import type {
  Divida,
  Company,
  TipoDivida,
  CpInclusionStatus,
} from '@/lib/financeiro/endividamento-types';

const brl = (x: number | null | undefined) =>
  x == null
    ? '—'
    : x.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });

const TIPO_LABEL: Record<TipoDivida, string> = {
  capital_giro: 'Capital de giro',
  financiamento: 'Financiamento',
  antecipacao_recorrente: 'Antecipação recorrente',
  outro: 'Outro',
};

function CpBadge({ status }: { status: CpInclusionStatus }) {
  const map: Record<CpInclusionStatus, { cls: string; label: string }> = {
    sim: { cls: 'text-status-success bg-status-success-bg', label: 'no CP' },
    nao: { cls: 'text-status-info bg-status-info-bg', label: 'fora do CP' },
    parcial: { cls: 'text-status-warning bg-status-warning-bg', label: 'CP parcial' },
    nao_sei: { cls: 'text-status-error bg-status-error-bg', label: 'CP? não sei' },
  };
  const { cls, label } = map[status];
  return <span className={`text-xs px-1.5 py-0.5 rounded ${cls}`}>{label}</span>;
}

export default function FinanceiroEndividamento() {
  const { isMaster } = useAuth();
  const { activeCompany } = useCompany();
  const [selectedCompany, setSelectedCompany] = useState<Company>(activeCompany ?? 'colacor');

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editando, setEditando] = useState<Divida | null>(null);
  const [excluindo, setExcluindo] = useState<Divida | null>(null);

  const { data: dividas, isLoading: loadingDividas } = useDividas(selectedCompany);
  const dividaIds = useMemo(() => (dividas ?? []).map((d) => d.id), [dividas]);
  const { data: parcelas } = useParcelas(dividaIds);
  const { data: completude } = useCompletude(selectedCompany);
  const { data: cashflow } = useCashflowProjection(selectedCompany);

  const deleteDivida = useDeleteDivida();
  const setCompletude = useSetCompletude();

  // Geração operacional A1 e horizonte, derivados da projeção de 13 semanas.
  // ausente/erro → null (o painel degrada para "inconclusivo", nunca fabrica).
  const semanas = cashflow?.semanas ?? [];
  const geracaoOperacionalA1 =
    semanas.length > 0
      ? semanas.reduce((s, w) => s + w.total_entradas - w.total_saidas, 0)
      : null;
  const hojeISO = semanas[0]?.inicio ?? '';
  const fimISO = semanas[semanas.length - 1]?.fim ?? '';

  const completo = completude?.completo === true;

  const abrirNova = () => {
    setEditando(null);
    setDialogOpen(true);
  };
  const abrirEdicao = (d: Divida) => {
    setEditando(d);
    setDialogOpen(true);
  };

  const parcelasDaEdicao = useMemo(
    () => (editando ? (parcelas ?? []).filter((p) => p.divida_id === editando.id) : []),
    [editando, parcelas],
  );

  if (!isMaster) {
    return (
      <div className="p-6">
        <EmptyState
          icon={Landmark}
          tone="operational"
          title="Acesso restrito"
          description="O módulo de endividamento é visível apenas para master."
        />
      </div>
    );
  }

  return (
    <div className="p-4 lg:p-6 space-y-4">
      {/* ── Header ── */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="font-display text-3xl">Endividamento</h1>
          <p className="text-sm text-muted-foreground">
            Cadastro das dívidas e serviço da dívida no horizonte de caixa. Direcional — não
            substitui balanço.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <select
            className="text-sm border border-border rounded px-2 py-1 bg-background"
            value={selectedCompany}
            onChange={(e) => setSelectedCompany(e.target.value as Company)}
          >
            {Object.values(COMPANIES).map((c) => (
              <option key={c.id} value={c.id}>
                {c.shortName}
              </option>
            ))}
          </select>
          <Button size="sm" onClick={abrirNova}>
            <Plus className="w-4 h-4 mr-1" />
            Nova dívida
          </Button>
        </div>
      </div>

      {/* ── Barra de completude ── */}
      <Card className={completo ? 'border-status-success/40' : 'border-status-warning/40'}>
        <CardContent className="py-3 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <p className="text-sm">
            {completo ? (
              <span className="text-status-success inline-flex items-center gap-1.5">
                <CheckCircle2 className="w-4 h-4" />
                Cadastro marcado como completo — o DSCR-caixa pode ser calculado.
              </span>
            ) : (
              <span className="text-status-warning">
                Cadastro incompleto. O DSCR-caixa fica inconclusivo até você marcá-lo como completo e
                responder, em cada dívida, se ela já está no contas-a-pagar.
              </span>
            )}
          </p>
          <Button
            size="sm"
            variant={completo ? 'outline' : 'default'}
            disabled={setCompletude.isPending}
            onClick={() =>
              setCompletude.mutate({ company: selectedCompany, completo: !completo })
            }
          >
            {completo ? 'Reabrir cadastro' : 'Marcar cadastro completo'}
          </Button>
        </CardContent>
      </Card>

      {/* ── Loading ── */}
      {loadingDividas && <PageSkeleton variant="cockpit" />}

      {/* ── Conteúdo ── */}
      {!loadingDividas && (
        <>
          {/* Indicadores */}
          <IndicadoresEndividamento
            dividas={dividas ?? []}
            parcelas={parcelas ?? []}
            completo={completo}
            geracaoOperacionalA1={geracaoOperacionalA1}
            hojeISO={hojeISO}
            fimISO={fimISO}
          />

          {/* Lista de dívidas */}
          {(dividas ?? []).length === 0 ? (
            <EmptyState
              icon={Landmark}
              tone="operational"
              title="Nenhuma dívida cadastrada"
              description={`Cadastre as dívidas de ${COMPANIES[selectedCompany].name} para acompanhar o serviço da dívida.`}
            />
          ) : (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">
                  Dívidas de {COMPANIES[selectedCompany].shortName} ({(dividas ?? []).length})
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0 overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Credor</TableHead>
                      <TableHead>Tipo</TableHead>
                      <TableHead className="text-right">Saldo devedor</TableHead>
                      <TableHead>No contas-a-pagar?</TableHead>
                      <TableHead className="text-right">Ações</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {(dividas ?? []).map((d) => (
                      <TableRow key={d.id} className={d.ativo ? '' : 'opacity-60'}>
                        <TableCell className="font-medium">{d.credor}</TableCell>
                        <TableCell className="text-muted-foreground">
                          {TIPO_LABEL[d.tipo] ?? d.tipo}
                        </TableCell>
                        <TableCell className="text-right font-tabular">
                          {brl(saldoDevedorEmAberto(d, parcelas ?? []))}
                        </TableCell>
                        <TableCell>
                          <CpBadge status={d.cp_inclusion_status} />
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-1">
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-8 w-8"
                              onClick={() => abrirEdicao(d)}
                              aria-label="Editar dívida"
                            >
                              <Pencil className="w-3.5 h-3.5" />
                            </Button>
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-8 w-8"
                              onClick={() => setExcluindo(d)}
                              aria-label="Excluir dívida"
                            >
                              <Trash2 className="w-3.5 h-3.5 text-status-error" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}
        </>
      )}

      {/* ── Dialog de cadastro/edição ── */}
      <DividaFormDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        divida={editando}
        parcelas={parcelasDaEdicao}
        defaultCompany={selectedCompany}
      />

      {/* ── Confirmação de exclusão ── */}
      <AlertDialog open={excluindo != null} onOpenChange={(o) => !o && setExcluindo(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Excluir dívida?</AlertDialogTitle>
            <AlertDialogDescription>
              {excluindo
                ? `"${excluindo.credor}" e todas as suas parcelas serão removidas. Esta ação não pode ser desfeita.`
                : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (excluindo) {
                  deleteDivida.mutate({ id: excluindo.id, company: selectedCompany });
                }
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
