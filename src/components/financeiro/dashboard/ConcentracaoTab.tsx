// F5 — Concentração de recebíveis abertos por código Omie (sacado), por empresa.
// Spec: docs/superpowers/specs/2026-07-05-concentracao-recebiveis-design.md
// Monitor de concentração de crédito. Money-path: estados honestos (fonte
// indisponível/parcial nunca vira "sem concentração"); v1 mostra código ("Cliente #N"),
// nome rico é próxima iteração; copy explícita "não consolida grupo econômico".
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { EmptyState } from '@/components/EmptyState';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { AlertTriangle, Users, Layers } from 'lucide-react';
import { COMPANIES, ALL_COMPANIES } from '@/contexts/CompanyContext';
import { fmt } from '@/components/financeiro/dashboard/format';
import { useConcentracaoRecebiveis } from '@/hooks/useConcentracaoRecebiveis';
import type { Company, ConcentracaoResult, ImpactoAbsoluto } from '@/lib/financeiro/concentracao-types';

const IMPACTO: Record<ImpactoAbsoluto, { label: string; cls: string }> = {
  baixo: { label: 'Impacto baixo', cls: 'bg-status-success-bg text-status-success border-transparent' },
  moderado: { label: 'Impacto moderado', cls: 'bg-status-warning-bg text-status-warning border-transparent' },
  alto: { label: 'Impacto alto', cls: 'bg-status-error-bg text-status-error border-transparent' },
};

const pct = (x: number | null) => (x == null ? '—' : `${(x * 100).toFixed(1)}%`);

function Metric({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-lg font-semibold tabular-nums">{value}</div>
      {hint && <div className="text-[10px] text-muted-foreground/70">{hint}</div>}
    </div>
  );
}

function EmpresaCard({ company, r }: { company: Company; r: ConcentracaoResult }) {
  const nome = COMPANIES[company].shortName;

  if (r.motivo === 'fonte_indisponivel') {
    return (
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">{nome}</CardTitle></CardHeader>
        <CardContent>
          <EmptyState
            icon={AlertTriangle}
            tone="operational"
            title="Não foi possível ler a carteira"
            description="A leitura de recebíveis falhou (sem dados / RLS / timeout). Isto NÃO é ausência de concentração — sincronize e tente de novo."
          />
        </CardContent>
      </Card>
    );
  }

  if (r.motivo === 'sem_carteira') {
    return (
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">{nome}</CardTitle></CardHeader>
        <CardContent>
          <EmptyState
            icon={Users}
            tone="operational"
            title="Sem recebíveis abertos"
            description="Nenhum título em aberto nesta empresa hoje."
          />
        </CardContent>
      </Card>
    );
  }

  const imp = r.impactoAbsoluto ? IMPACTO[r.impactoAbsoluto] : null;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-base flex items-center gap-2 flex-wrap">
          {nome}
          {imp && <Badge className={imp.cls}>{imp.label}</Badge>}
          {r.motivo === 'fonte_parcial' && (
            <Badge variant="outline" className="text-status-warning border-status-warning/40">
              Leitura parcial{r.linhasInvalidas > 0 ? ` · ${r.linhasInvalidas} inválida(s)` : ''}
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Metric label="Maior exposição" value={fmt(r.maiorExposicao ?? 0)} />
          <Metric label="Top-5" value={pct(r.top5Pct)} />
          <Metric
            label="C50"
            value={r.c50 == null ? '—' : `${r.c50} cliente${r.c50 === 1 ? '' : 's'}`}
            hint="somam 50% da carteira"
          />
          <Metric label="Carteira aberta" value={fmt(r.totalAberto ?? 0)} />
        </div>

        {r.topN.length > 0 && (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Sacado (código Omie)</TableHead>
                  <TableHead className="text-right">Aberto</TableHead>
                  <TableHead className="text-right">Vencido</TableHead>
                  <TableHead className="text-right">% venc.</TableHead>
                  <TableHead className="text-right">Share</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {r.topN.map((l) => (
                  <TableRow key={l.codigo}>
                    <TableCell className="font-mono text-xs">Cliente #{l.codigo}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmt(l.saldo)}</TableCell>
                    <TableCell
                      className={`text-right tabular-nums ${l.vencido > 0 ? 'text-status-error' : 'text-muted-foreground'}`}
                    >
                      {l.vencido > 0 ? fmt(l.vencido) : '—'}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      {(l.pctVencidoProprio * 100).toFixed(0)}%
                    </TableCell>
                    <TableCell className="text-right tabular-nums font-medium">
                      {(l.share * 100).toFixed(1)}%
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}

        {/* Secundário — tendência/sanidade (nunca headline). */}
        <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground">
          <span>Top-1: <b className="text-foreground">{pct(r.top1Pct)}</b></span>
          <span>Nº efetivo de clientes: <b className="text-foreground">{r.nEfetivo == null ? '—' : r.nEfetivo.toFixed(0)}</b></span>
          <span>HHI: <b className="text-foreground">{r.hhi == null ? '—' : r.hhi.toFixed(3)}</b></span>
          <span>Clientes: <b className="text-foreground">{r.clientes ?? '—'}</b></span>
        </div>
      </CardContent>
    </Card>
  );
}

export function ConcentracaoTab() {
  const { data, isLoading } = useConcentracaoRecebiveis();

  if (isLoading || !data) return <PageSkeleton variant="cockpit" />;

  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2 text-xs text-muted-foreground">
        <Layers className="w-4 h-4 mt-0.5 shrink-0 opacity-60" />
        <p>
          Concentração de crédito por <b>código Omie (sacado)</b> sobre os recebíveis em aberto —{' '}
          <b>não consolida grupo econômico</b>. Ranqueado por exposição absoluta; o tom de impacto é
          keyed na maior exposição (política 25k/75k, tunável). Identificação por nome: próxima iteração.
        </p>
      </div>
      {ALL_COMPANIES.map((co) => (
        <EmpresaCard key={co} company={co} r={data[co]} />
      ))}
    </div>
  );
}
