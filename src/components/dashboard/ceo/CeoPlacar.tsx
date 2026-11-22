/**
 * Placar da "Visão do CEO": 5 números que respondem quanto o grupo vendeu, com que margem e
 * quanto dinheiro a operação tem e exige. KPIs e ordem: parecer Codex 2026-11-20.
 *
 * - Vendas em pedidos MTD vs mesmos dias do mês anterior (`useTeamKpis`, segue o seletor). É
 *   PEDIDO, não receita contábil — o rótulo diz isso.
 * - Margem bruta do último mês fechado comum (DRE, regime visível) — com a composição (receita, CMV,
 *   lucro, mês anterior e confiança do mapeamento) por empresa num card próprio —, só das empresas de
 *   mercadoria — a Colacor SC só presta serviço e aparece como "serviço", não como 100%.
 * - Saldo bancário líquido (soma dos CNPJs) + quais CNPJs estão negativos — caixa não é
 *   fungível entre CNPJs, então o total nunca aparece sozinho como "disponível".
 * - Falta de caixa nas 13 semanas: soma dos déficits no pior saldo de cada CNPJ (sem abater a
 *   sobra de outro), com quem já está negativo ou a partir de quando, e a semana do pior saldo.
 * - Recebíveis vencidos em R$ e % da carteira aberta; numa empresa, o clique abre a fila dela em
 *   /cobranca (a fila é por empresa credora); no grupo, o cockpit consolidado.
 * - "Cobrar primeiro": maiores vencidos por empresa credora × cliente no Omie (nunca por nome), com
 *   responsável e promessa vencida — mesma RPC da tela de cobrança.
 * - NCG (necessidade de capital de giro) com data do snapshot; a leitura do sinal (folga ×
 *   capital preso) só aparece com a NCG completa — sem estoque até o sinal pode virar.
 *
 * Ausente ≠ zero em todos: leitura que falha ou CNPJ faltando → "—". Falha de leitura diz
 * "leitura falhou" (nunca se disfarça de "sem dado"); CMV zerado → margem "—" com o motivo.
 */
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { track } from '@/lib/analytics';
import { useCompany, COMPANIES, type Company } from '@/contexts/CompanyContext';
import { useTeamKpis } from '@/hooks/useTeamKpis';
import { useCeoPlacar } from '@/components/financeiro/cockpit/useCeoPlacar';
import { formatBRL, formatarFracaoPct } from '@/components/customer360/format';
import { formatarBRLCompacto } from '@/lib/dashboard/ceo-formato';

const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];

type KpiId = 'vendas' | 'margem' | 'caixa' | 'caixa13' | 'vencidos' | 'ncg';

function Kpi({
  id,
  rotulo,
  valor,
  titulo,
  detalhe,
  para,
  carregando,
}: {
  id: KpiId;
  rotulo: string;
  valor: string;
  titulo?: string;
  detalhe?: ReactNode;
  para: string;
  carregando: boolean;
}) {
  return (
    <Link
      to={para}
      onClick={() => track('dashboard.ceo.kpi_click', { kpi: id })}
      className="group rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      data-testid={`ceo-kpi-${id}`}
    >
      <Card className="h-full p-4 transition-colors group-hover:border-foreground/20">
        <div className="text-2xs uppercase tracking-wide text-muted-foreground">{rotulo}</div>
        <div className="mt-1.5 text-2xl font-semibold tabular-nums tracking-tight" title={titulo}>
          {carregando ? '…' : valor}
        </div>
        {detalhe && !carregando && <div className="mt-1 text-2xs leading-snug text-muted-foreground">{detalhe}</div>}
      </Card>
    </Link>
  );
}

function Variacao({ v }: { v: number | null | undefined }) {
  if (v === null || v === undefined) return <>sem base no mês anterior</>;
  if (v === 0) return <>= mesmos dias do mês anterior</>;
  return (
    <>
      <span className={cn('font-medium', v > 0 ? 'text-status-success' : 'text-status-error')}>
        {v > 0 ? '▲' : '▼'} {formatarFracaoPct(Math.abs(v))}
      </span>{' '}
      vs mesmos dias do mês anterior
    </>
  );
}

function rotuloMes(mes: number | null): string {
  return mes === null ? '' : MESES[mes - 1];
}

function nomes(empresas: readonly Company[]): string {
  return empresas.map((e) => COMPANIES[e].shortName).join(', ');
}

/** NCG ≤ 0 = passivo operacional financia o giro (mesma régua do cockpit financeiro). */
function leituraNcg(valor: number, completa: boolean): string {
  if (!completa) return 'parcial · snapshot sem estoque';
  return valor <= 0 ? 'folga: fornecedores financiam o giro' : 'capital preso no giro';
}

// Tipos pela ponte `useCeoPlacar` (o dashboard não importa a lib do financeiro — gate de fronteiras).
type CaixaProjetado = ReturnType<typeof useCeoPlacar>['caixaProjetado'];
type MotivoSemProjecao = NonNullable<CaixaProjetado['porEmpresa'][number]['motivo']>;

const MOTIVO_SEM_PROJECAO: Record<MotivoSemProjecao, string> = {
  ausente: 'sem projeção',
  desatualizada: 'projeção desatualizada',
  incompleta: 'projeção incompleta',
};

/** Quem fica negativo, desde quando e o pior saldo — caixa não é fungível entre CNPJs. */
function detalheCaixa13(c: CaixaProjetado, grupo: boolean): ReactNode {
  const sem = c.porEmpresa.filter((r) => r.motivo !== null);
  if (c.falta === null) {
    if (sem.length === 0) return 'projeção indisponível';
    const motivo = MOTIVO_SEM_PROJECAO[sem[0].motivo as MotivoSemProjecao];
    return grupo ? `${motivo}: ${nomes(sem.map((r) => r.empresa))}` : motivo;
  }
  // Coorte antiga: "já negativa" passaria por hoje — data o estado pelo snapshot.
  const defasada = c.diasDefasagem !== null && c.diasDefasagem > 1;
  const dataSnap = dataCurta(c.porEmpresa[0]?.snapshot ?? null);
  const sufixo = defasada ? ` · projeção de ${dataSnap}` : '';
  const negativas = c.porEmpresa.filter((r) => r.pior !== null && r.pior.saldo < 0);
  if (c.falta === 0 || negativas.length === 0) return `nenhum CNPJ fica negativo${sufixo}`;
  const quem = negativas
    .map((r) => {
      const quando = r.negativaHoje
        ? defasada ? `negativa em ${dataSnap}` : 'já negativa'
        : `negativa a partir de ${dataCurta(r.primeiraNegativa)}`;
      return grupo ? `${COMPANIES[r.empresa].shortName} ${quando}` : quando;
    })
    .join('; ');
  // A soma não tem UMA data: só cita a semana do pior quando é a mesma em todos (Codex P3).
  const semanasPior = new Set(negativas.map((r) => (r.pior as { inicio: string }).inicio));
  const pior = semanasPior.size === 1 ? ` · pior em ${dataCurta([...semanasPior][0])}` : '';
  return (
    <span className="text-status-warning">
      {quem}
      {pior}
      {sufixo}
    </span>
  );
}

function dataCurta(iso: string | null): string {
  if (!iso) return '';
  const [, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}`;
}

type CobrancaCeo = ReturnType<typeof useCeoPlacar>['cobranca'];

/** A fila de /cobranca é POR empresa credora (default oben): todo link leva a empresa junto. */
const linkCobranca = (co: Company) => `/cobranca?empresa=${co}`;

/** Quem cobrar primeiro: promessa vencida, depois a contatar até 1 ano por saldo; antigos no fim. */
function CardCobranca({ c, erro, carregando, empresas }: {
  c: CobrancaCeo; erro: boolean; carregando: boolean; empresas: readonly Company[];
}) {
  const grupo = empresas.length > 1;
  const clique = (origem: string) => () => track('dashboard.ceo.cobranca_click', { origem });
  const resumo = c && (
    <p className="mt-1.5 text-xs text-muted-foreground">
      {c.devedores} {c.devedores === 1 ? 'cliente' : 'clientes'} com vencido
      {c.semResponsavel.n > 0 && (
        <span className="text-status-warning">
          {' '}· {c.semResponsavel.n} sem responsável ({formatarBRLCompacto(c.semResponsavel.valor)})
        </span>
      )}
      {c.promessasVencidas > 0 && (
        <span className="text-status-warning">
          {' '}· {c.promessasVencidas} {c.promessasVencidas === 1 ? 'promessa vencida' : 'promessas vencidas'}
        </span>
      )}
      {c.aguardando > 0 && <> · {c.aguardando} em pagamento informado, acordo ou disputa</>}
      {c.saldoDesconhecido > 0 && <> · {c.saldoDesconhecido} sem saldo conhecido</>}
    </p>
  );
  return (
    <Card className="p-4" data-testid="ceo-cobranca">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <div className="text-2xs uppercase tracking-wide text-muted-foreground">Cobrar primeiro</div>
        <div className="flex gap-3 text-xs text-muted-foreground">
          {grupo && <span>Abrir cobrança:</span>}
          {empresas.map((co) => (
            <Link
              key={co}
              to={linkCobranca(co)}
              onClick={clique('card')}
              className="underline-offset-2 hover:text-foreground hover:underline"
            >
              {grupo ? COMPANIES[co].shortName : 'Abrir cobrança →'}
            </Link>
          ))}
        </div>
      </div>
      {carregando ? (
        <p className="mt-2 text-xs text-muted-foreground">Lendo a fila de cobrança…</p>
      ) : erro || c === null ? (
        <p className="mt-2 text-xs text-status-error">
          Não consegui ler a fila de cobrança — a ausência aqui não quer dizer que ninguém deve.
        </p>
      ) : c.devedores === 0 && c.promessasVencidas === 0 && c.saldoDesconhecido === 0 ? (
        <p className="mt-2 text-xs text-muted-foreground">Nenhum cliente com título vencido.</p>
      ) : (
        <>
          {resumo}
          {c.top.length === 0 ? (
            <p className="mt-2 text-xs text-muted-foreground">Nenhum vencido pedindo contato agora.</p>
          ) : (
            <table className="mt-2 w-full text-xs tabular-nums">
              <caption className="sr-only">Clientes para cobrar primeiro</caption>
              <thead>
                <tr className="border-b border-border text-2xs uppercase tracking-wide text-muted-foreground">
                  <th scope="col" className="py-1.5 pr-3 text-left font-normal">Cliente</th>
                  <th scope="col" className="py-1.5 pr-3 text-right font-normal">Vencido</th>
                  <th scope="col" className="py-1.5 pr-3 text-right font-normal">Atraso</th>
                  <th scope="col" className="py-1.5 text-left font-normal">Responsável</th>
                </tr>
              </thead>
              <tbody>
                {c.top.map((d) => (
                  <tr key={`${d.company}-${d.codigo}`} className="border-b border-border last:border-0">
                    <th scope="row" className="py-1.5 pr-3 text-left font-medium">
                      <Link to={linkCobranca(d.company)} onClick={clique('linha')} className="hover:underline">
                        {d.nome ?? `cód. ${d.codigo}`}
                      </Link>
                      {grupo && <span className="ml-1 font-normal text-muted-foreground">{COMPANIES[d.company].shortName}</span>}
                    </th>
                    <td className="py-1.5 pr-3 text-right" title={d.saldoVencido === null ? undefined : formatBRL(d.saldoVencido)}>
                      {formatarBRLCompacto(d.saldoVencido)}
                    </td>
                    <td className="py-1.5 pr-3 text-right">
                      {d.diasMax === null ? '—' : `${d.diasMax} d`}
                      {d.antigo && (
                        <span className="ml-1 text-muted-foreground" title="Mais de 1 ano: provável perda">antigo</span>
                      )}
                    </td>
                    <td className="py-1.5 text-left">
                      {d.responsavel ?? <span className="text-status-warning">sem responsável</span>}
                      {d.promessaVencida && <span className="ml-1 text-status-warning">· promessa vencida</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </Card>
  );
}

type ComposicaoMargemCeo = ReturnType<typeof useCeoPlacar>['composicaoMargem'];

/** De onde vem a margem do tile: receita, CMV e lucro (receita − CMV) por empresa de mercadoria, com o mapeamento da DRE. */
function CardComposicaoMargem({ c, regime }: { c: ComposicaoMargemCeo; regime: string }) {
  if (c.mes === null || c.linhas.length === 0) return null;
  return (
    <Card className="overflow-x-auto p-4" data-testid="ceo-composicao-margem">
      <div className="flex items-baseline justify-between gap-3">
        <div className="text-2xs uppercase tracking-wide text-muted-foreground">
          Como a margem se forma · {rotuloMes(c.mes)} · DRE {regime === 'caixa' ? 'caixa' : 'competência'}
        </div>
        <Link
          to="/financeiro/cockpit"
          onClick={() => track('dashboard.ceo.kpi_click', { kpi: 'composicao_margem' })}
          className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          Abrir DRE →
        </Link>
      </div>
      <table className="mt-2 w-full text-xs tabular-nums">
        <caption className="sr-only">Composição da margem bruta por empresa</caption>
        <thead>
          <tr className="border-b border-border text-2xs uppercase tracking-wide text-muted-foreground">
            <th scope="col" className="py-1.5 pr-3 text-left font-normal">Empresa</th>
            <th scope="col" className="py-1.5 pr-3 text-right font-normal">Receita líquida</th>
            <th scope="col" className="py-1.5 pr-3 text-right font-normal">CMV</th>
            <th scope="col" className="py-1.5 pr-3 text-right font-normal">Lucro bruto</th>
            <th scope="col" className="py-1.5 pr-3 text-right font-normal">Margem</th>
            <th scope="col" className="py-1.5 pr-3 text-right font-normal">Mês anterior</th>
            <th scope="col" className="py-1.5 text-left font-normal">Mapeamento da DRE</th>
          </tr>
        </thead>
        <tbody>
          {c.linhas.map((l) => (
            <tr key={l.empresa} className="border-b border-border last:border-0">
              <th scope="row" className="py-1.5 pr-3 text-left font-medium">{COMPANIES[l.empresa].shortName}</th>
              <td className="py-1.5 pr-3 text-right" title={formatBRL(l.receitaLiquida)}>{formatarBRLCompacto(l.receitaLiquida)}</td>
              <td className="py-1.5 pr-3 text-right" title={formatBRL(l.cmv)}>{formatarBRLCompacto(l.cmv)}</td>
              <td className="py-1.5 pr-3 text-right" title={formatBRL(l.lucroBruto)}>{formatarBRLCompacto(l.lucroBruto)}</td>
              <td className="py-1.5 pr-3 text-right font-medium">{formatarFracaoPct(l.margem)}</td>
              <td className="py-1.5 pr-3 text-right text-muted-foreground">{formatarFracaoPct(l.margemAnterior)}</td>
              <td className="py-1.5 text-left">
                {l.semMapeamento !== null && l.semMapeamento > 0 ? (
                  <span
                    className="text-status-warning"
                    title="Categorias da DRE inteira (não só do CMV) classificadas pela descrição, sem mapeamento explícito"
                  >
                    {l.semMapeamento} {l.semMapeamento === 1 ? 'categoria' : 'categorias'} sem mapeamento
                  </span>
                ) : l.semMapeamento === null ? (
                  <span className="text-muted-foreground">não informada</span>
                ) : (
                  <span className="text-muted-foreground">mapeada</span>
                )}
                {l.provisorio && (
                  <span className="ml-1 text-status-warning" title="Há lançamentos fora da DRE no mês">
                    · DRE provisória
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

export function CeoPlacar() {
  const { selection, companyInfo } = useCompany();
  const vendas = useTeamKpis();
  const p = useCeoPlacar();
  const escopo = selection === 'all' ? 'Grupo (3 empresas)' : companyInfo.shortName;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Kpi
          id="vendas"
          rotulo="Vendas no mês · pedidos"
          valor={vendas.isError ? '—' : formatarBRLCompacto(vendas.data?.receitaMes)}
          titulo={vendas.data ? formatBRL(vendas.data.receitaMes) : undefined}
          detalhe={vendas.isError ? 'leitura falhou' : <Variacao v={vendas.data?.variacaoMes} />}
          para="/meu-dia"
          carregando={vendas.isLoading}
        />
        <Kpi
          id="margem"
          rotulo="Margem bruta"
          valor={formatarFracaoPct(p.margem.valor)}
          detalhe={
            p.erro.dre
              ? 'leitura da DRE falhou'
              : selection !== 'all' && p.margem.servicoFora.length > 0
                ? 'só serviço: custo nas despesas, sem margem bruta'
                : p.margem.semCmv.length > 0
                  ? `${rotuloMes(p.margem.mes)}: CMV não classificado em ${nomes(p.margem.semCmv)}`
                  : p.margem.mes === null
                    ? 'sem mês anterior com receita em todas'
                    : `${rotuloMes(p.margem.mes)} · DRE ${p.regime === 'caixa' ? 'caixa' : 'competência'}${
                        p.margem.servicoFora.length > 0 ? ` · sem ${nomes(p.margem.servicoFora)} (serviço)` : ''
                      }`
          }
          para="/financeiro/cockpit"
          carregando={p.carregando.dre}
        />
        <Kpi
          id="caixa"
          rotulo={selection === 'all' ? 'Saldo bancário líquido' : 'Saldo bancário'}
          valor={formatarBRLCompacto(p.caixa.saldo)}
          titulo={p.caixa.saldo === null ? undefined : formatBRL(p.caixa.saldo)}
          detalhe={
            p.erro.resumo
              ? 'leitura falhou'
              : p.caixa.saldo === null
                ? 'saldo de alguma conta indisponível'
                : p.caixa.empresasNegativas.length > 0
                  ? (
                      <span className="text-status-warning">
                        {selection === 'all' ? `compensa saldo negativo: ${nomes(p.caixa.empresasNegativas)}` : 'conta no negativo'}
                      </span>
                    )
                  : 'soma das contas bancárias'
          }
          para="/financeiro/cockpit"
          carregando={p.carregando.resumo}
        />
        <Kpi
          id="caixa13"
          rotulo="Falta de caixa · 13 semanas"
          valor={p.caixaProjetado.falta === 0 ? 'nenhuma' : formatarBRLCompacto(p.caixaProjetado.falta)}
          titulo={p.caixaProjetado.falta ? formatBRL(p.caixaProjetado.falta) : undefined}
          detalhe={p.erro.ncg ? 'leitura falhou' : detalheCaixa13(p.caixaProjetado, selection === 'all')}
          para="/financeiro/capital-giro?aba=fluxo"
          carregando={p.carregando.ncg}
        />
        <Kpi
          id="vencidos"
          rotulo="Recebíveis vencidos"
          valor={formatarBRLCompacto(p.vencidos.valor)}
          titulo={p.vencidos.valor === null ? undefined : formatBRL(p.vencidos.valor)}
          detalhe={
            p.erro.resumo
              ? 'leitura falhou'
              : p.vencidos.pct === null
                ? 'títulos indisponíveis'
                : `${formatarFracaoPct(p.vencidos.pct)} da carteira aberta`
          }
          para={selection === 'all' ? '/financeiro/cockpit' : `/cobranca?empresa=${selection}`}
          carregando={p.carregando.resumo}
        />
        <Kpi
          id="ncg"
          rotulo="Capital de giro (NCG)"
          valor={formatarBRLCompacto(p.ncg.valor)}
          titulo={p.ncg.valor === null ? undefined : formatBRL(p.ncg.valor)}
          detalhe={
            p.erro.ncg
              ? 'leitura falhou'
              : p.ncg.valor === null
                ? 'snapshot ausente em alguma empresa'
                : `${leituraNcg(p.ncg.valor, p.ncg.completa)} · ${dataCurta(p.ncg.dataReferencia)}`
          }
          para="/financeiro/capital-giro"
          carregando={p.carregando.ncg}
        />
      </div>

      {p.porEmpresa.length > 0 && (
        <Card className="overflow-x-auto">
          <table className="w-full text-xs tabular-nums" data-testid="ceo-por-empresa">
            <caption className="sr-only">Placar por empresa</caption>
            <thead>
              <tr className="border-b border-border text-2xs uppercase tracking-wide text-muted-foreground">
                <th scope="col" className="px-4 py-2 text-left font-normal">Empresa</th>
                <th scope="col" className="px-4 py-2 text-right font-normal">Margem bruta</th>
                <th scope="col" className="px-4 py-2 text-right font-normal">Caixa</th>
                <th scope="col" className="px-4 py-2 text-right font-normal">Pior saldo · 13 sem</th>
                <th scope="col" className="px-4 py-2 text-right font-normal">Vencidos</th>
                <th scope="col" className="px-4 py-2 text-right font-normal">NCG</th>
              </tr>
            </thead>
            <tbody>
              {p.porEmpresa.map((l) => (
                <tr key={l.empresa} className="border-b border-border last:border-0">
                  <th scope="row" className="px-4 py-2 text-left font-medium">{COMPANIES[l.empresa].shortName}</th>
                  <td className="px-4 py-2 text-right">
                    {l.margem.servicoFora.length > 0 ? (
                      <span className="text-muted-foreground" title="Só presta serviço: sem CMV, o custo está nas despesas operacionais">serviço</span>
                    ) : l.margem.semCmv.length > 0 ? (
                      <span className="text-status-warning" title="CMV não classificado no mês — margem não calculada">sem CMV</span>
                    ) : (
                      formatarFracaoPct(l.margem.valor)
                    )}
                    {l.margem.mes !== null && <span className="ml-1 text-muted-foreground">{rotuloMes(l.margem.mes)}</span>}
                  </td>
                  <td className={cn('px-4 py-2 text-right', l.caixa.saldo !== null && l.caixa.saldo < 0 && 'text-status-warning')}>
                    {formatarBRLCompacto(l.caixa.saldo)}
                  </td>
                  {(() => {
                    const r = p.caixaProjetado.porEmpresa.find((e) => e.empresa === l.empresa);
                    const pior = r?.pior ?? null;
                    return (
                      <td className={cn('px-4 py-2 text-right', pior !== null && pior.saldo < 0 && 'text-status-warning')}>
                        {formatarBRLCompacto(pior ? pior.saldo : null)}
                        {pior && <span className="ml-1 text-muted-foreground">{dataCurta(pior.inicio)}</span>}
                      </td>
                    );
                  })()}
                  <td className="px-4 py-2 text-right">
                    {formatarBRLCompacto(l.vencidos.valor)}
                    {l.vencidos.pct !== null && (
                      <span className="ml-1 text-muted-foreground">{formatarFracaoPct(l.vencidos.pct)}</span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-right">
                    {formatarBRLCompacto(l.ncg.valor)}
                    {l.ncg.valor !== null && !l.ncg.completa && <span className="ml-1 text-muted-foreground">parcial</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      <CardComposicaoMargem c={p.composicaoMargem} regime={p.regime} />

      <CardCobranca
        c={p.cobranca}
        erro={p.erro.cobranca}
        carregando={p.carregando.cobranca}
        empresas={selection === 'all' ? (['oben', 'colacor', 'colacor_sc'] as const) : [selection]}
      />

      <p className="text-2xs text-muted-foreground">
        Escopo: {escopo}. Todos os números seguem o seletor de empresa; o cockpit financeiro de destino mostra o grupo.
      </p>
    </div>
  );
}
