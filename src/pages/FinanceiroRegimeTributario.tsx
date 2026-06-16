// src/pages/FinanceiroRegimeTributario.tsx
import { useAuth } from '@/contexts/AuthContext';
import { useRegimeTributario } from '@/hooks/useRegimeTributario';
import { RegimeInputsDialog } from '@/components/financeiro/RegimeInputsDialog';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import type {
  RegimeEmpresaResult,
  RegimeComparado,
  RegimeNome,
  StatusRecomendacao,
} from '@/services/financeiroService';

const NOME: Record<string, string> = { colacor: 'Colacor', oben: 'Oben', colacor_sc: 'Colacor SC' };
const REGIME_LABEL: Record<RegimeNome, string> = { simples: 'Simples Nacional', presumido: 'Lucro Presumido', real: 'Lucro Real' };

const STATUS_LABEL: Record<StatusRecomendacao, string> = {
  recomenda: 'Recomenda troca de regime',
  empate_tecnico: 'Empate técnico — diferença marginal',
  manter: 'Manter regime atual',
  incompleto: 'Dados incompletos — recomendação parcial',
};

const pct = (x: number | null | undefined) => (x == null ? '—' : `${(x * 100).toFixed(1)}%`);
const brl = (x: number | null | undefined) =>
  x == null ? '—' : x.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });

function nivelClasses(n: 'alta' | 'media' | 'baixa') {
  if (n === 'alta') return 'text-status-success bg-status-success-bg';
  if (n === 'media') return 'text-status-warning bg-status-warning-bg';
  return 'text-status-error bg-status-error-bg';
}

function statusClasses(s: StatusRecomendacao) {
  if (s === 'recomenda') return 'text-status-success';
  if (s === 'empate_tecnico') return 'text-status-warning';
  if (s === 'incompleto') return 'text-status-warning';
  return 'text-muted-foreground';
}

function ComparadoRow({ row, atual, recomendado, status }: { row: RegimeComparado; atual: RegimeNome; recomendado: RegimeNome | null; status: StatusRecomendacao }) {
  const isAtual = row.regime === atual;
  // "Recomendado" só quando a recomendação é confiável (recomenda/empate). Em 'incompleto' não fabricamos badge.
  const isRecomendado =
    recomendado != null && row.regime === recomendado && (status === 'recomenda' || status === 'empate_tecnico');
  // Em 'manter', o regime atual já é o melhor — sinalizamos como "Atual (melhor)" em vez de "Recomendado".
  const isAtualMelhor = isAtual && status === 'manter';
  return (
    <tr className={`border-b border-border last:border-0 ${!row.elegivel ? 'text-muted-foreground' : ''} ${isAtual ? 'bg-muted/40' : ''}`}>
      <td className="py-1.5 pr-2">
        <span className={isAtual ? 'font-medium' : ''}>{REGIME_LABEL[row.regime]}</span>
        {isAtual && <span className="ml-1 text-xs text-muted-foreground">(atual)</span>}
        {isRecomendado && (
          <span className="ml-1 text-xs px-1.5 py-0.5 rounded text-status-success bg-status-success-bg">Recomendado</span>
        )}
        {isAtualMelhor && (
          <span className="ml-1 text-xs px-1.5 py-0.5 rounded text-status-success bg-status-success-bg">Atual (melhor)</span>
        )}
      </td>
      <td className="py-1.5 px-2 text-right font-mono">{row.elegivel ? brl(row.total_federal_cpp) : '—'}</td>
      <td className="py-1.5 px-2 text-right font-mono">{row.elegivel ? pct(row.aliquota_efetiva) : '—'}</td>
      <td className="py-1.5 pl-2 text-xs">
        {!row.elegivel ? (
          <span className="text-status-warning">{row.motivo_inelegivel ?? 'inelegível'}</span>
        ) : (
          <span className="text-muted-foreground">
            {row.aproximado && <span className="text-status-warning">aprox. </span>}
            {row.flags.join(' · ')}
          </span>
        )}
      </td>
    </tr>
  );
}

function EmpresaCard({ emp }: { emp: RegimeEmpresaResult }) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base">
          {NOME[emp.empresa] ?? emp.empresa}{' '}
          <span className="text-xs text-muted-foreground">(atual: {REGIME_LABEL[emp.regime_atual]} · TTM {emp.ttm.meses}m)</span>
        </CardTitle>
        <span className={`text-xs px-2 py-0.5 rounded ${nivelClasses(emp.confianca.nivel)}`}>confiança {emp.confianca.nivel}</span>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-xs text-muted-foreground">
              <th className="py-1 pr-2 text-left font-medium">Regime</th>
              <th className="py-1 px-2 text-right font-medium">Imposto anual</th>
              <th className="py-1 px-2 text-right font-medium">Alíq. efetiva</th>
              <th className="py-1 pl-2 text-left font-medium">Observações</th>
            </tr>
          </thead>
          <tbody>
            {emp.comparados.map((row) => (
              <ComparadoRow key={row.regime} row={row} atual={emp.regime_atual} recomendado={emp.recomendado} status={emp.status} />
            ))}
          </tbody>
        </table>

        <div className="space-y-1">
          <p className={`font-medium ${statusClasses(emp.status)}`}>{STATUS_LABEL[emp.status]}</p>
          {emp.status === 'incompleto' && (
            <p className="text-xs text-status-warning">
              Estimativa incompleta — informe a folha / 12 meses de DRE para a recomendação.
            </p>
          )}
          {emp.economia_anual != null && emp.economia_anual > 0 && (
            <p className="text-status-success">
              Economia anual estimada: <span className="kpi-value">{brl(emp.economia_anual)}</span>
            </p>
          )}
        </div>

        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
          <span className="text-muted-foreground">Break-even (margem real × presumido)</span>
          <span className="text-right font-mono">{pct(emp.break_even.margem_real_vs_presumido)}</span>
          <span className="text-muted-foreground">Fator-r (limiar)</span>
          <span className="text-right font-mono">{pct(emp.break_even.fator_r)}</span>
          <span className="text-muted-foreground">Eixo indireto (ICMS/ISS/IPI no Simples)</span>
          <span className="text-right font-mono">{brl(emp.eixo_indireto.icms_iss_ipi_simples)}</span>
        </div>
        {emp.eixo_indireto.observacao && <p className="text-xs text-muted-foreground">{emp.eixo_indireto.observacao}</p>}

        {emp.confianca.motivos.length > 0 && (
          <details className="text-xs text-muted-foreground">
            <summary>Por que essa confiança?</summary>
            <ul className="list-disc pl-4 mt-1">
              {emp.confianca.motivos.map((m, i) => (
                <li key={i}>{m}</li>
              ))}
            </ul>
          </details>
        )}

        <RegimeInputsDialog company={emp.empresa} atual={emp.regime_inputs} />
      </CardContent>
    </Card>
  );
}

export default function FinanceiroRegimeTributario() {
  const { isMaster } = useAuth();
  const { data, isLoading, error } = useRegimeTributario();

  if (!isMaster) {
    return (
      <div className="p-6">
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            Acesso restrito — Regime Tributário é visível apenas para master.
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="p-4 lg:p-6 space-y-4">
      <div>
        <h1 className="font-display text-3xl">Regime Tributário</h1>
        <p className="text-sm text-muted-foreground">
          Comparação Simples Nacional × Lucro Presumido × Lucro Real por empresa, com recomendação e economia anual estimada.
        </p>
      </div>

      <Card className="border-status-warning/40">
        <CardContent className="py-3 text-sm text-status-warning">
          Recomenda, não declara. Troca de regime exige validação do contador + substância econômica.
        </CardContent>
      </Card>

      {isLoading && <PageSkeleton variant="detail" />}

      {error && (
        <Card>
          <CardContent className="py-6 text-sm text-status-error">
            Erro ao carregar regime tributário: {error instanceof Error ? error.message : String(error)}
          </CardContent>
        </Card>
      )}

      {!isLoading && !error && data && data.por_empresa.length === 0 && (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            Nenhuma empresa com dados suficientes para comparar regimes.
          </CardContent>
        </Card>
      )}

      {!isLoading && !error && data && data.por_empresa.length > 0 && (
        <>
          <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
            {data.por_empresa.map((emp) => (
              <EmpresaCard key={emp.empresa} emp={emp} />
            ))}
          </div>

          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0">
              <CardTitle className="text-base">Consolidado (3 empresas)</CardTitle>
              <span className={`text-xs px-2 py-0.5 rounded ${nivelClasses(data.consolidado.confianca)}`}>
                confiança {data.consolidado.confianca}
              </span>
            </CardHeader>
            <CardContent className="text-sm">
              <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                <span className="text-muted-foreground">Imposto atual total</span>
                <span className="text-right font-mono">{brl(data.consolidado.imposto_atual_total)}</span>
                <span className="text-muted-foreground">Imposto otimizado total</span>
                <span className="text-right font-mono">{brl(data.consolidado.imposto_otimizado_total)}</span>
                <span className="text-muted-foreground">Economia total estimada</span>
                <span
                  className={`text-right kpi-value ${
                    data.consolidado.economia_total > 0 ? 'text-status-success' : 'text-muted-foreground'
                  }`}
                >
                  {brl(data.consolidado.economia_total)}
                </span>
              </div>
            </CardContent>
          </Card>

          <p className="text-xs text-muted-foreground">Gerado em {new Date(data.gerado_em).toLocaleString('pt-BR')}.</p>
        </>
      )}
    </div>
  );
}
