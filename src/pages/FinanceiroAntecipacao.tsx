// src/pages/FinanceiroAntecipacao.tsx
// F4 — página master-only: registro de antecipações + medidor de custo (Job A) + calculadora de
// funding (Job B). Espelha FinanceiroEndividamento (header, seletor de empresa, PageSkeleton, Table).
// Soft delete (deleted_at) — o histórico de custo nunca é apagado.
import { useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useCompany, COMPANIES } from '@/contexts/CompanyContext';
import { useAntecipacoes, useSoftDeleteAntecipacao } from '@/hooks/useAntecipacoes';
import { custoOperacao } from '@/lib/financeiro/antecipacao-helpers';
import { AntecipacaoFormDialog } from '@/components/financeiro/antecipacao/AntecipacaoFormDialog';
import { MedidorCustoCard } from '@/components/financeiro/antecipacao/MedidorCustoCard';
import { CalculadoraFunding } from '@/components/financeiro/antecipacao/CalculadoraFunding';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
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
import { Banknote, Plus, Pencil, Trash2, AlertTriangle } from 'lucide-react';
import { fmt, fmtDate } from '@/components/financeiro/dashboard/format';
import type { Antecipacao, Company, TipoAntecipacao } from '@/lib/financeiro/antecipacao-types';

const TIPO_LABEL: Record<TipoAntecipacao, string> = {
  duplicata: 'Duplicata',
  linha: 'Linha',
};

export default function FinanceiroAntecipacao() {
  const { isMaster } = useAuth();
  const { activeCompany } = useCompany();
  const [selectedCompany, setSelectedCompany] = useState<Company>(activeCompany ?? 'oben');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editando, setEditando] = useState<Antecipacao | null>(null);
  const [excluindo, setExcluindo] = useState<Antecipacao | null>(null);

  const { data: ops, isLoading, error } = useAntecipacoes(selectedCompany);
  const softDelete = useSoftDeleteAntecipacao();

  if (!isMaster) {
    return (
      <div className="p-6">
        <EmptyState
          icon={Banknote}
          tone="operational"
          title="Acesso restrito"
          description="O módulo de antecipação de recebíveis é visível apenas para master."
        />
      </div>
    );
  }

  const lista = ops ?? [];
  const abrirNova = () => {
    setEditando(null);
    setDialogOpen(true);
  };
  const abrirEdicao = (a: Antecipacao) => {
    setEditando(a);
    setDialogOpen(true);
  };

  return (
    <div className="p-4 lg:p-6 space-y-4">
      {/* ── Header ── */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="font-display text-3xl">Antecipação de recebíveis</h1>
          <p className="text-sm text-muted-foreground">
            Registro manual das operações de antecipação. Mede o custo real (R$ + taxa) e compara o funding —
            não substitui o extrato do banco.
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
            Nova antecipação
          </Button>
        </div>
      </div>

      {isLoading ? (
        <PageSkeleton variant="cockpit" />
      ) : error ? (
        // §5: erro de leitura/RLS NÃO é "sem operações" — surfacear distinto (nunca confundir).
        <Card>
          <CardContent className="flex items-start gap-3 py-4">
            <AlertTriangle className="w-5 h-5 text-status-warning mt-0.5 shrink-0" />
            <p className="text-sm text-muted-foreground">
              Não foi possível carregar as antecipações. Se a migração{' '}
              <code className="text-xs">fin_antecipacoes</code> ainda não foi aplicada, aplique-a primeiro.
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          {/* Job A — medidor */}
          <MedidorCustoCard ops={lista} />

          {/* Job B — calculadora de funding */}
          <CalculadoraFunding company={selectedCompany} />

          {/* Lista de operações */}
          {lista.length === 0 ? (
            <EmptyState
              icon={Banknote}
              tone="operational"
              title="Nenhuma antecipação registrada"
              description={`Registre as operações de ${COMPANIES[selectedCompany].name} para medir o custo.`}
            />
          ) : (
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">
                  Operações de {COMPANIES[selectedCompany].shortName} ({lista.length})
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0 overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Banco</TableHead>
                      <TableHead>Tipo</TableHead>
                      <TableHead className="text-right">Face</TableHead>
                      <TableHead className="text-right">Líquido</TableHead>
                      <TableHead className="text-right">Custo</TableHead>
                      <TableHead className="text-right">Dias</TableHead>
                      <TableHead>Vencimento</TableHead>
                      <TableHead className="text-right">Ações</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {lista.map((a) => {
                      const c = custoOperacao(a);
                      return (
                        <TableRow key={a.id}>
                          <TableCell className="font-medium">{a.banco ?? '—'}</TableCell>
                          <TableCell className="text-muted-foreground">
                            {TIPO_LABEL[a.tipo] ?? a.tipo}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">{fmt(a.valor_bruto)}</TableCell>
                          <TableCell className="text-right tabular-nums">{fmt(a.valor_liquido)}</TableCell>
                          <TableCell className="text-right tabular-nums">
                            {c.motivo === 'ok' && c.custo != null ? (
                              fmt(c.custo)
                            ) : (
                              <Badge variant="outline" className="text-[10px] text-status-error border-status-error/40">
                                inválida
                              </Badge>
                            )}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">{c.dias ?? '—'}</TableCell>
                          <TableCell>{fmtDate(a.data_vencimento)}</TableCell>
                          <TableCell className="text-right">
                            <div className="flex items-center justify-end gap-1">
                              <Button
                                size="icon"
                                variant="ghost"
                                className="h-8 w-8"
                                onClick={() => abrirEdicao(a)}
                                aria-label="Editar operação"
                              >
                                <Pencil className="w-3.5 h-3.5" />
                              </Button>
                              <Button
                                size="icon"
                                variant="ghost"
                                className="h-8 w-8"
                                onClick={() => setExcluindo(a)}
                                aria-label="Remover operação"
                              >
                                <Trash2 className="w-3.5 h-3.5 text-status-error" />
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}
        </>
      )}

      {/* ── Dialog de cadastro/edição ── */}
      <AntecipacaoFormDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        antecipacao={editando}
        defaultCompany={selectedCompany}
        operacoes={lista}
      />

      {/* ── Confirmação de remoção (soft delete) ── */}
      <AlertDialog open={excluindo != null} onOpenChange={(o) => !o && setExcluindo(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remover operação?</AlertDialogTitle>
            <AlertDialogDescription>
              {excluindo
                ? `A operação ${excluindo.banco ? `no ${excluindo.banco} ` : ''}sai da lista e dos totais. O histórico de custo é preservado (soft delete).`
                : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                // P2-a: invalida o cache da empresa DA OPERAÇÃO (não do seletor, que pode ter mudado).
                if (excluindo) softDelete.mutate({ id: excluindo.id, company: excluindo.company });
                setExcluindo(null);
              }}
            >
              Remover
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
