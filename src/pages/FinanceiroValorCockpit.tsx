// src/pages/FinanceiroValorCockpit.tsx
// A3 — Cockpit de Valor Oben. Gate: gestor comercial (gerencial/estrategico/super_admin) ou master.
import { useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { useValorCockpit } from '@/hooks/useValorCockpit';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import type { CockpitRollupCliente, CockpitRollupSKU } from '@/services/financeiroService';

const brl = (x: number | null | undefined) =>
  x == null
    ? '—'
    : x.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });

function nivelClasses(n: 'alta' | 'media' | 'baixa') {
  if (n === 'alta') return 'text-status-success bg-status-success-bg';
  if (n === 'media') return 'text-status-warning bg-status-warning-bg';
  return 'text-status-error bg-status-error-bg';
}

export default function FinanceiroValorCockpit() {
  const { isMaster, isGestorComercial } = useAuth();
  const [aba, setAba] = useState<'cliente' | 'sku'>('cliente');
  const podeVer = isMaster || isGestorComercial;
  const { data, isLoading, error } = useValorCockpit(podeVer);

  if (!podeVer) {
    return (
      <div className="p-6">
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            Acesso restrito — Cockpit de Valor é visível a gestor comercial e master.
          </CardContent>
        </Card>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="p-6">
        <PageSkeleton variant="list" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6">
        <Card>
          <CardContent className="py-6 text-sm text-status-error">
            Erro: {error instanceof Error ? error.message : String(error)}
          </CardContent>
        </Card>
      </div>
    );
  }

  if (!data || data.vazio) {
    return (
      <div className="p-6">
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            {data?.motivo ?? 'Sem dados de venda no período.'}
          </CardContent>
        </Card>
      </div>
    );
  }

  const linhas: (CockpitRollupCliente | CockpitRollupSKU)[] =
    aba === 'cliente'
      ? [...data.porCliente].sort((a, b) => (a.evp ?? Infinity) - (b.evp ?? Infinity))
      : [...data.porSKU].sort((a, b) => (a.evp ?? Infinity) - (b.evp ?? Infinity));

  const recPorCliente = new Map(data.recomendacoesCliente.map((r) => [r.cliente, r.recomendacoes]));

  return (
    <div className="p-4 lg:p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-display text-3xl">Cockpit de Valor — Oben</h1>
          {data.k != null ? (
            <p className="text-sm text-muted-foreground">
              Lucro econômico (margem − custo do capital de giro @ {(data.k * 100).toFixed(1)}%) por cliente e SKU.
            </p>
          ) : (
            <p className="text-sm text-status-warning">
              Lucro econômico (EVP) indisponível — sem Ke/hurdle configurado. Configure em /financeiro/valor (só a margem é mostrada).
            </p>
          )}
        </div>
        <span className={`text-xs px-2 py-0.5 rounded font-medium ${nivelClasses(data.confianca.nivel)}`}>
          confiança {data.confianca.nivel}
        </span>
      </div>

      {data.k != null && (
        <p className="text-xs text-muted-foreground">
          EVP conhecido (capital medido): <span className="font-tabular text-foreground">{brl(data.empresa.evp_conhecido)}</span>
          {data.empresa.evp_teto_total != null && (
            <> · teto ≤ <span className="font-tabular">{brl(data.empresa.evp_teto_total)}</span></>
          )}
          {data.empresa.evp_perda_garantida != null && data.empresa.evp_perda_garantida < 0 && (
            <> · perda garantida <span className="font-tabular text-status-error">{brl(data.empresa.evp_perda_garantida)}</span></>
          )}
          {data.evp_omitido_otimista_receita_pct != null && data.evp_omitido_otimista_receita_pct > 0 && (
            <> · <span className="text-status-warning">{(data.evp_omitido_otimista_receita_pct * 100).toFixed(0)}% da receita com EVP omitido (capital não medido)</span></>
          )}
        </p>
      )}

      {data.hurdle_banda != null && data.empresa.capital_conhecido != null && data.empresa.evp_conhecido != null && (
        <p className="text-xs text-muted-foreground">
          Sensibilidade ao hurdle: a {(data.hurdle_banda.lo * 100).toFixed(0)}% <span className="font-tabular">{brl(data.empresa.evp_conhecido + (data.hurdle_banda.base - data.hurdle_banda.lo) * data.empresa.capital_conhecido)}</span>
          {' · '}<span className="font-tabular text-foreground">a {(data.hurdle_banda.base * 100).toFixed(0)}% {brl(data.empresa.evp_conhecido)}</span>
          {' · '}a {(data.hurdle_banda.hi * 100).toFixed(0)}% <span className="font-tabular">{brl(data.empresa.evp_conhecido + (data.hurdle_banda.base - data.hurdle_banda.hi) * data.empresa.capital_conhecido)}</span>
          {data.empresa.qtd_combos_sensiveis > 0 && (
            <> · <span className="text-status-warning">{data.empresa.qtd_combos_sensiveis} combo(s) no fio da navalha (recomendação frágil ao hurdle)</span></>
          )}
        </p>
      )}

      <div className="flex gap-2">
        <Button
          variant={aba === 'cliente' ? 'default' : 'outline'}
          size="sm"
          onClick={() => setAba('cliente')}
        >
          Por cliente
        </Button>
        <Button
          variant={aba === 'sku' ? 'default' : 'outline'}
          size="sm"
          onClick={() => setAba('sku')}
        >
          Por SKU
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Piores destruidores de valor primeiro</CardTitle>
        </CardHeader>
        <CardContent className="text-sm overflow-x-auto">
          <table className="w-full min-w-[600px]">
            <thead>
              <tr className="text-muted-foreground text-xs">
                <th className="text-left py-1">{aba === 'cliente' ? 'Cliente' : 'SKU'}</th>
                <th className="text-right">Receita</th>
                <th className="text-right">Margem</th>
                <th className="text-right">Encargo giro</th>
                <th className="text-right">Lucro econ.</th>
                <th className="text-left pl-3">Ação</th>
              </tr>
            </thead>
            <tbody>
              {linhas.slice(0, 50).map((row) => {
                const id =
                  aba === 'cliente'
                    ? (row as CockpitRollupCliente).cliente
                    : (row as CockpitRollupSKU).sku;
                const nome = aba === 'cliente' ? (row as CockpitRollupCliente).nome : (row as CockpitRollupSKU).descricao;
                const temNome = !!nome && nome !== id;
                const recs = aba === 'cliente' ? (recPorCliente.get(id) ?? []) : [];
                return (
                  <tr key={id} className="border-t border-border">
                    <td className="py-1">
                      <div className={temNome ? '' : 'font-tabular'}>{temNome ? nome : id}</div>
                      {temNome && !id.startsWith('app:') && <div className="text-xs text-muted-foreground font-tabular">{id}</div>}
                    </td>
                    <td className="text-right">{brl(row.receita)}</td>
                    <td className="text-right">{brl(row.cm)}</td>
                    <td className="text-right text-muted-foreground">{brl(row.encargo)}</td>
                    <td className="text-right">
                      <div
                        className={`kpi-value ${
                          row.evp == null
                            ? 'text-muted-foreground'
                            : row.evp < 0
                            ? 'text-status-error'
                            : 'text-status-success'
                        }`}
                      >
                        {brl(row.evp)}
                      </div>
                      {(row.evp_incompleto || row.perda_garantida) && (
                        <div className="text-[10px] leading-tight text-muted-foreground">
                          {row.evp_incompleto
                            ? `${row.evp == null ? 'capital não medido' : 'parcial'}${row.evp_teto != null ? ` · teto ≤ ${brl(row.evp_teto)}` : ''}`
                            : 'prejuízo real pode ser maior (teto)'}
                        </div>
                      )}
                      {row.qtd_combos_sensiveis > 0 && (
                        <div className="text-[10px] leading-tight text-status-warning">
                          {row.qtd_combos_sensiveis} frágil(eis) ao hurdle
                        </div>
                      )}
                    </td>
                    <td className="pl-3 text-xs">
                      {recs.map((r, i) => (
                        <div key={i}>
                          {r.acao}
                          {r.impacto_rs != null ? ` (~${brl(r.impacto_rs)})` : ''}
                        </div>
                      ))}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {data.confianca.motivos.length > 0 && (
            <details className="text-xs text-muted-foreground mt-3">
              <summary>
                Confiança ({(data.cobertura_receita * 100).toFixed(0)}% do AR explicado{data.cobertura_app_por_ar != null ? ` · ${(data.cobertura_app_por_ar * 100).toFixed(0)}% das vendas com AR` : ''})
              </summary>
              <ul className="list-disc pl-4 mt-1">
                {data.confianca.motivos.map((m, i) => (
                  <li key={i}>{m}</li>
                ))}
              </ul>
            </details>
          )}
        </CardContent>
      </Card>

      <p className="text-xs text-muted-foreground">
        Direcional: custo é médio atual (sem BOM), imposto estimado nível-empresa, estoque é snapshot run-rate. Escopo: Oben.
      </p>
    </div>
  );
}
