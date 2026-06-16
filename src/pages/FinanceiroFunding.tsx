// src/pages/FinanceiroFunding.tsx
// Cockpit "Custo Marginal de Funding" — decide se vale antecipar recebíveis.
// Espelha FinanceiroRegimeTributario.tsx: mesma estrutura de header, loading, gate master, layout.
import { useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useCompany, COMPANIES } from '@/contexts/CompanyContext';
import { useFunding } from '@/hooks/useFunding';
import { FundingInputsDialog } from '@/components/financeiro/FundingInputsDialog';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { EmptyState } from '@/components/EmptyState';
import { Banknote } from 'lucide-react';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { DecisaoTitulo, TipoFonte, PlanoCobertura } from '@/lib/financeiro/funding-helpers';

// ─── Helpers de formatação ────────────────────────────────────────────────────

const brl = (x: number | null | undefined) =>
  x == null
    ? '—'
    : x.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });

const pctAA = (x: number | null | undefined) =>
  x == null ? '—' : `${(x * 100).toFixed(1)}% a.a.`;

// ─── Badges ───────────────────────────────────────────────────────────────────

function ContextoBadge({ contexto }: { contexto: 'gap' | 'sobra' | 'indefinido' }) {
  if (contexto === 'gap') {
    return (
      <span className="text-xs px-1.5 py-0.5 rounded text-status-error bg-status-error-bg">
        gap
      </span>
    );
  }
  if (contexto === 'sobra') {
    return (
      <span className="text-xs px-1.5 py-0.5 rounded text-status-success bg-status-success-bg">
        sobra
      </span>
    );
  }
  return (
    <span className="text-xs px-1.5 py-0.5 rounded text-muted-foreground bg-muted">
      indefinido
    </span>
  );
}

function RecomendacaoBadge({ rec }: { rec: 'antecipar' | 'nao_antecipar' | 'falta_dado' }) {
  if (rec === 'antecipar') {
    return (
      <span className="text-xs px-1.5 py-0.5 rounded text-status-success bg-status-success-bg font-medium">
        Antecipar
      </span>
    );
  }
  if (rec === 'nao_antecipar') {
    return (
      <span className="text-xs px-1.5 py-0.5 rounded text-muted-foreground bg-muted">
        Não antecipar
      </span>
    );
  }
  return (
    <span className="text-xs px-1.5 py-0.5 rounded text-status-warning bg-status-warning-bg">
      Falta dado
    </span>
  );
}

const FLAG_LABEL: Record<string, string> = {
  coobrigacao: 'coobrigação',
  cria_vale_em_T: 'cria vale',
  estrutural: 'estrutural',
  concentracao_sacado: 'conc. sacado',
  sem_projecao: 'sem projeção',
  sem_taxa_antecipacao: 'sem taxa',
  sem_custo_capital: 'sem custo capital',
};

function FlagChips({ flags }: { flags: string[] }) {
  if (flags.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {flags.map((f) => (
        <span
          key={f}
          className="text-[10px] px-1 py-0.5 rounded bg-muted text-muted-foreground"
        >
          {FLAG_LABEL[f] ?? f}
        </span>
      ))}
    </div>
  );
}

// ─── Planejador de cobertura de gap ──────────────────────────────────────────

const FONTE_LABEL: Record<TipoFonte, string> = {
  caixa_proprio: 'Caixa próprio',
  antecipacao: 'Antecipação',
  capital_giro: 'Capital de giro',
  cheque_especial: 'Cheque especial',
};

interface PlanejadorProps {
  plano: PlanoCobertura;
  retorno_marginal: number | null;
}

function PlanejadorCobertura({ plano, retorno_marginal }: PlanejadorProps) {
  // null-safe: custo_inercia_rs pode ser null (sem taxa de cheque → inércia desconhecida, não 0).
  const inerciaEhPior = plano.custo_inercia_rs != null && plano.custo_inercia_rs > plano.custo_total_rs;

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-2">
        <CardTitle className="text-base">Planejador de cobertura de gap</CardTitle>
        {/* Só o "melhor uso do caixa" (A4) como contexto. NÃO mostra "caixa livre": ele NÃO é fonte do
            plano (já está embutido na projeção que gerou o gap) — exibi-lo aqui sugeriria que cobre o gap. */}
        {retorno_marginal != null && (
          <span className="text-xs text-muted-foreground shrink-0">
            Melhor uso do caixa: {pctAA(retorno_marginal)}
          </span>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Linha de resumo */}
        <p className="text-sm">
          Gap de{' '}
          <span className="font-medium text-status-error">{brl(plano.gap_rs)}</span>
          {' '}a cobrir · horizonte{' '}
          <span className="font-medium">{plano.horizonte_dias} dias</span>
          {' '}(semana do vale)
        </p>

        {/* Stack de fontes */}
        {plano.stack.length > 0 && (
          <div className="space-y-1.5">
            {plano.stack.map((item, idx) => (
              <div
                key={item.fonte}
                className={`flex items-center justify-between rounded px-3 py-2 text-sm ${
                  idx === 0
                    ? 'bg-muted/60 border border-border font-medium'
                    : 'bg-muted/30'
                }`}
              >
                <div className="flex items-center gap-2">
                  <span>{FONTE_LABEL[item.fonte] ?? item.fonte}</span>
                  {item.flag === 'emergencia' && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded text-status-warning bg-status-warning-bg font-normal">
                      emergência
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-4 font-tabular text-xs text-muted-foreground">
                  <span>{brl(item.montante_rs)}</span>
                  <span className="text-status-error">custo {brl(item.custo_rs)}</span>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* Custo total vs inércia */}
        <div className="flex flex-wrap gap-4 pt-1 border-t border-border text-sm">
          <div>
            <span className="text-muted-foreground text-xs">Cobrir agora</span>
            <p className="font-medium font-tabular">{brl(plano.custo_total_rs)}</p>
          </div>
          <div>
            <span className="text-muted-foreground text-xs">Não fazer nada (conta garantida)</span>
            <p
              className={`font-medium font-tabular ${
                inerciaEhPior ? 'text-status-error' : ''
              }`}
            >
              {brl(plano.custo_inercia_rs)}
              {inerciaEhPior && (
                <span className="ml-1 text-[10px] font-normal text-status-error">
                  mais caro
                </span>
              )}
            </p>
          </div>
        </div>

        {/* Motivos / alertas */}
        {plano.motivos.length > 0 && (
          <ul className="list-disc pl-4 space-y-0.5">
            {plano.motivos.map((m, i) => (
              <li key={i} className="text-xs text-status-warning">
                {m}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

// ─── Linha da tabela de títulos ───────────────────────────────────────────────

function TituloRow({ t }: { t: DecisaoTitulo }) {
  const netClass =
    t.net_rs == null
      ? 'text-muted-foreground'
      : t.net_rs > 0
        ? 'text-status-success font-medium'
        : 'text-status-error font-medium';

  const tooltipParts = [
    t.custo_rs_antecipacao > 0 ? `Custo antecipação: ${brl(t.custo_rs_antecipacao)}` : null,
    t.custo_rs_benchmark != null ? `Benchmark (${t.benchmark_fonte ?? '—'}): ${brl(t.custo_rs_benchmark)}` : null,
    t.net_rs != null ? `Net R$: ${brl(t.net_rs)}` : null,
  ]
    .filter(Boolean)
    .join(' | ');

  return (
    <TableRow>
      <TableCell className="font-medium">
        {t.titulo.nome_cliente ?? '—'}
      </TableCell>
      <TableCell className="text-right font-tabular">
        {brl(t.titulo.valor)}
      </TableCell>
      <TableCell className="text-right font-tabular">
        {t.titulo.dias}d
      </TableCell>
      <TableCell className="text-right font-tabular">
        {brl(t.v_liq)}
      </TableCell>
      <TableCell className="text-right font-tabular">
        {brl(t.custo_rs_antecipacao)}
      </TableCell>
      <TableCell className="text-right font-tabular text-muted-foreground text-xs">
        {pctAA(t.taxa_efetiva_aa)}
      </TableCell>
      <TableCell>
        <ContextoBadge contexto={t.contexto} />
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">
        {t.benchmark_fonte ?? '—'}
      </TableCell>
      <TableCell
        className={`text-right font-tabular ${netClass}`}
        title={tooltipParts}
      >
        {brl(t.net_rs)}
      </TableCell>
      <TableCell>
        <RecomendacaoBadge rec={t.recomendacao} />
      </TableCell>
      <TableCell>
        <FlagChips flags={t.flags} />
      </TableCell>
    </TableRow>
  );
}

// ─── Painel de confiança ──────────────────────────────────────────────────────

function nivelClasses(n: 'alta' | 'media' | 'baixa') {
  if (n === 'alta') return 'text-status-success bg-status-success-bg';
  if (n === 'media') return 'text-status-warning bg-status-warning-bg';
  return 'text-status-error bg-status-error-bg';
}

// ─── Página principal ─────────────────────────────────────────────────────────

export default function FinanceiroFunding() {
  const { isMaster } = useAuth();
  const { activeCompany } = useCompany();
  const [selectedCompany, setSelectedCompany] = useState<string>(activeCompany ?? 'colacor');
  const { data, isLoading, error } = useFunding(selectedCompany);

  if (!isMaster) {
    return (
      <div className="p-6">
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            Acesso restrito — Custo de Funding é visível apenas para master.
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="p-4 lg:p-6 space-y-4">
      {/* ── Header ── */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="font-display text-3xl">Custo de Funding</h1>
          <p className="text-sm text-muted-foreground">
            Vale antecipar este recebível? Compara custo da antecipação com o benchmark do gap de caixa.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {/* Seletor de empresa (espelha FinanceiroRegimeTributario) */}
          <select
            className="text-sm border border-border rounded px-2 py-1 bg-background"
            value={selectedCompany}
            onChange={(e) => setSelectedCompany(e.target.value)}
          >
            {Object.values(COMPANIES).map((c) => (
              <option key={c.id} value={c.id}>
                {c.shortName}
              </option>
            ))}
          </select>
          <FundingInputsDialog company={selectedCompany} />
        </div>
      </div>

      {/* ── Aviso metodológico ── */}
      <Card className="border-status-warning/40">
        <CardContent className="py-3 text-sm text-status-warning">
          Recomenda, não decide. Antecipar com recorrência é rolagem de dívida — resolva primeiro o
          gap estrutural via prazo de fornecedor/cliente, margem ou dívida de prazo adequado.
        </CardContent>
      </Card>

      {/* ── Loading ── */}
      {isLoading && <PageSkeleton variant="cockpit" />}

      {/* ── Erro ── */}
      {error && (
        <Card>
          <CardContent className="py-6 text-sm text-status-error">
            Erro ao carregar funding: {error instanceof Error ? error.message : String(error)}
          </CardContent>
        </Card>
      )}

      {/* ── Conteúdo ── */}
      {!isLoading && !error && data && (
        <>
          {/* Banner estrutural */}
          {data.estrutural && (
            <Card className="border-status-warning/60 bg-status-warning-bg/30">
              <CardContent className="py-3 text-sm text-status-warning">
                <strong>Gap recorrente nas próximas semanas — situação estrutural.</strong> Antecipar
                recebível neste cenário é rolagem de dívida. Priorize renegociar prazo de
                fornecedor/cliente, ajustar preço/margem ou contratar dívida de prazo adequado.
              </CardContent>
            </Card>
          )}

          {/* Aviso de degradação — sem projeção de 13 semanas */}
          {!data.tem_projecao && (
            <Card className="border-muted">
              <CardContent className="py-3 text-sm text-muted-foreground">
                Projeção de 13 semanas indisponível — a decisão usa o custo de oportunidade do
                caixa (cm_anual) e não detecta gap/sobra nem vale futuro. Execute o cron de
                projeção para habilitar a análise completa.
              </CardContent>
            </Card>
          )}

          {/* KPIs topo */}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <Card>
              <CardContent className="py-3">
                <p className="text-xs text-muted-foreground">Custo marginal (cm_anual)</p>
                <p className="kpi-value text-xl mt-0.5">
                  {data.cm_anual != null ? pctAA(data.cm_anual) : '—'}
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="py-3">
                <p className="text-xs text-muted-foreground">Reserva mínima</p>
                <p className="kpi-value text-xl mt-0.5">{brl(data.reserva_rs)}</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="py-3 flex items-center justify-between">
                <div>
                  <p className="text-xs text-muted-foreground">Confiança</p>
                  <p className="text-sm font-medium mt-0.5 capitalize">{data.confianca.nivel}</p>
                </div>
                <span
                  className={`text-xs px-2 py-0.5 rounded ${nivelClasses(data.confianca.nivel)}`}
                >
                  {data.confianca.nivel}
                </span>
              </CardContent>
            </Card>
          </div>

          {/* Motivos de confiança */}
          {data.confianca.motivos.length > 0 && (
            <details className="text-xs text-muted-foreground">
              <summary>Por que essa confiança?</summary>
              <ul className="list-disc pl-4 mt-1">
                {data.confianca.motivos.map((m, i) => (
                  <li key={i}>{m}</li>
                ))}
              </ul>
            </details>
          )}

          {/* Planejador de cobertura de gap */}
          {data.tem_projecao && data.plano_cobertura != null && (
            <PlanejadorCobertura
              plano={data.plano_cobertura}
              retorno_marginal={data.retorno_marginal}
            />
          )}
          {data.tem_projecao && data.plano_cobertura == null && (
            <p className="text-sm text-muted-foreground">
              Sem gap de caixa previsto nas próximas 13 semanas — nenhuma cobertura necessária.
            </p>
          )}

          {/* Tabela de títulos */}
          {data.titulos.length === 0 ? (
            <EmptyState
              icon={Banknote}
              tone="operational"
              title="Nenhum recebível disponível"
              description={`Nenhum recebível em aberto com vencimento futuro para ${selectedCompany}.`}
            />
          ) : (
            <Card>
              <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
                <CardTitle className="text-base">
                  Títulos antecipáveis ({data.titulos.length})
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0 overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Cliente</TableHead>
                      <TableHead className="text-right">Valor</TableHead>
                      <TableHead className="text-right">Vence em</TableHead>
                      <TableHead className="text-right">Líquido hoje</TableHead>
                      <TableHead className="text-right">Custo antecip.</TableHead>
                      <TableHead className="text-right">Taxa efetiva</TableHead>
                      <TableHead>Contexto</TableHead>
                      <TableHead>Benchmark</TableHead>
                      <TableHead className="text-right">Net R$</TableHead>
                      <TableHead>Recomendação</TableHead>
                      <TableHead>Flags</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.titulos.map((t) => (
                      <TituloRow key={t.titulo.id} t={t} />
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          )}

          <p className="text-xs text-muted-foreground">
            Gerado em {new Date(data.gerado_em).toLocaleString('pt-BR')}.
          </p>
        </>
      )}
    </div>
  );
}
