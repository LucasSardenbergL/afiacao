// Painel de crédito — crédito-IA PR 8 (spec 2026-11-20 §5.7/§5.8). Só leitura, gestor/master: o gate é a
// RPC `credito_painel_resumo` (SECURITY DEFINER + pode_ver_carteira_completa); a rota só fica no RequireStaff.
// Ausente ≠ zero: bloco sem fonte mostra "sem dado ainda" + o motivo que o banco devolveu, nunca 0.
import { useEffect } from 'react';
import { AlertTriangle, CircleSlash, Lock, ShieldCheck } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { EmptyState } from '@/components/EmptyState';
import { useUrlState } from '@/hooks/useUrlState';
import { track } from '@/lib/analytics';
import {
  PERIODOS_PAINEL, useCreditoPainel, type PeriodoPainel,
} from '@/lib/credito-painel/useCreditoPainel';
import {
  brl, int, NOME_EMPRESA, type Indisponivel, type PainelCredito,
} from '@/lib/credito-painel/parse';

const ACAO_LABEL: Record<string, string> = {
  bloqueado: 'Bloqueado (piso)',
  bloqueado_edicao: 'Bloqueado na edição',
  liberado_excecao: 'Liberado por exceção',
  gate_indisponivel: 'Gate indisponível',
};
const VIA_LABEL: Record<string, string> = {
  piso: 'piso', excecao: 'exceção', gate_v2: '🟢 gate v2', gate_indisponivel: 'gate indisponível',
};

function SemDado({ motivo }: { motivo: string }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-dashed p-3 text-sm text-muted-foreground">
      <CircleSlash className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <div>
        <span className="font-medium text-foreground">Sem dado ainda.</span> {motivo}
      </div>
    </div>
  );
}

function Kpi({ rotulo, valor, detalhe, tom }: { rotulo: string; valor: string; detalhe?: string; tom?: 'error' | 'warning' }) {
  const cor = tom === 'error' ? 'text-status-error' : tom === 'warning' ? 'text-status-warning' : 'text-foreground';
  return (
    <div className="rounded-md border p-3">
      <div className="text-xs text-muted-foreground">{rotulo}</div>
      <div className={`text-lg font-semibold tabular-nums ${cor}`}>{valor}</div>
      {detalhe && <div className="text-xs text-muted-foreground">{detalhe}</div>}
    </div>
  );
}

const ind = (b: { disponivel: boolean }): b is Indisponivel => b.disponivel === false;

function BlocoExposicao({ p }: { p: PainelCredito }) {
  const { totais, grupos, reservas, naoConsolidados, gruposOmitidos } = p.exposicao;
  const parcialTot = (totais.titulosIndeterminados ?? 0) > 0;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Exposição por grupo × limite</CardTitle>
        <CardDescription>
          Títulos abertos das 3 empresas somados por grupo (Oben + Colacor + Colacor SC). Limite = vigente aprovado.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Kpi rotulo="Aberto (conhecido)" valor={brl(totais.abertoConhecido, parcialTot)}
               detalhe={`${int(totais.grupos)} grupos`} />
          <Kpi rotulo="Vencido" valor={brl(totais.vencidoConhecido, parcialTot)} tom="warning" />
          <Kpi rotulo="Vencido ≥ 60 d" valor={brl(totais.vencido60Conhecido, parcialTot)} tom="error"
               detalhe={`${int(totais.gruposVencido60)} grupos no piso`} />
          <Kpi rotulo="Grupos com limite" valor={int(totais.gruposComLimite)} />
        </div>
        {ind(p.limites) && <SemDado motivo={p.limites.motivo} />}
        {ind(reservas) && <SemDado motivo={reservas.motivo} />}
        {naoConsolidados.length > 0 && (
          <div className="flex items-start gap-2 text-sm text-status-warning">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <span>
              Fora de qualquer grupo:{' '}
              {naoConsolidados.map((n) => `${int(n.pares)} par(es) ${n.motivo === 'grupo_conflito' ? 'em conflito' : 'sem dono único'} (${brl(n.abertoConhecido, (n.titulosIndeterminados ?? 0) > 0)})`).join(' · ')}
            </span>
          </div>
        )}
        {grupos.length === 0 ? (
          <EmptyState icon={ShieldCheck} tone="operational" title="Nenhum título aberto"
                      description="O espelho de contas a receber não tem título aberto em nenhum grupo." />
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Grupo</TableHead>
                  <TableHead className="text-right">Aberto</TableHead>
                  <TableHead className="text-right">Vencido</TableHead>
                  <TableHead className="text-right">Maior atraso</TableHead>
                  <TableHead className="text-right">Reservado</TableHead>
                  <TableHead className="text-right">Limite</TableHead>
                  <TableHead className="text-right">Uso</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {grupos.map((g) => {
                  const parcial = (g.titulosIndeterminados ?? 0) > 0;
                  return (
                    <TableRow key={g.grupoUserId}>
                      <TableCell>
                        <div className="font-medium">{g.nome ?? 'Sem nome no título'}</div>
                        <div className="flex flex-wrap gap-1 text-xs text-muted-foreground">
                          {g.empresas.map((e) => NOME_EMPRESA[e] ?? e).join(' + ')}
                          {g.parcialColacorSc && (
                            <Badge variant="outline" className="h-4 px-1 text-[10px]"
                                   title="Colacor SC não tem pedido no app: só títulos, sem trânsito nem decisões">
                              parcial SC
                            </Badge>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{brl(g.abertoConhecido, parcial)}</TableCell>
                      <TableCell className={`text-right tabular-nums ${(g.vencido60Conhecido ?? 0) > 0 ? 'text-status-error' : (g.vencidoConhecido ?? 0) > 0 ? 'text-status-warning' : ''}`}>
                        {brl(g.vencidoConhecido, parcial)}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {g.diasMaiorAtraso === null ? '—' : `${g.diasMaiorAtraso} d`}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{brl(g.reservado)}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {g.limiteBrl === null ? <span className="text-muted-foreground">sem limite</span> : brl(g.limiteBrl)}
                      </TableCell>
                      <TableCell className={`text-right tabular-nums ${(g.usoPct ?? 0) > 100 ? 'text-status-error' : ''}`}>
                        {g.usoPct === null ? '—' : `${g.usoPct.toLocaleString('pt-BR')}%`}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            {(gruposOmitidos ?? 0) > 0 && (
              <p className="mt-2 text-xs text-muted-foreground">
                Mostrando os 200 maiores por exposição (+ todos com limite); {int(gruposOmitidos)} grupos menores omitidos.
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function BlocoBloqueios({ p }: { p: PainelCredito }) {
  const b = p.bloqueios;
  const denom = Object.entries(b.pedidosAppPeriodo);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Bloqueios</CardTitle>
        <CardDescription>
          Piso (vencido ≥ 60 d no grupo) registrado no log da trava · denominador: pedidos criados no app no período
          {denom.length > 0 && ` (${denom.map(([k, v]) => `${NOME_EMPRESA[k] ?? k} ${int(v)}`).join(', ')})`}.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {b.porAcao.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nenhum evento da trava no período ({int(b.logTotalHistorico)} no histórico inteiro do log).
          </p>
        ) : (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {b.porAcao.map((a) => (
              <Kpi key={a.acao} rotulo={ACAO_LABEL[a.acao] ?? a.acao} valor={int(a.eventos)}
                   detalhe={`vencido ${brl(a.vencidoConhecido, (a.semValor ?? 0) > 0)}`}
                   tom={a.acao.startsWith('bloqueado') ? 'error' : a.acao === 'gate_indisponivel' ? 'warning' : undefined} />
            ))}
          </div>
        )}
        {b.recentes.length > 0 && (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Quando</TableHead><TableHead>Cliente</TableHead><TableHead>Ação</TableHead>
                  <TableHead className="text-right">Vencido</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {b.recentes.map((r, i) => (
                  <TableRow key={`${r.createdAt}-${i}`}>
                    <TableCell className="whitespace-nowrap">{r.createdAt ? new Date(r.createdAt).toLocaleString('pt-BR') : '—'}</TableCell>
                    <TableCell>{r.nome ?? `${NOME_EMPRESA[r.company] ?? r.company} #${r.omieCodigoCliente ?? '?'}`}</TableCell>
                    <TableCell>{ACAO_LABEL[r.acao] ?? r.acao}</TableCell>
                    <TableCell className="text-right tabular-nums">{brl(r.vencido)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
        {ind(b.gateV2) ? <SemDado motivo={b.gateV2.motivo} /> : (
          <div className="text-sm">
            <div className="font-medium">Gate v2 (efetivo) — 🔴/🟡 por motivo</div>
            {b.gateV2.porMotivo.length === 0
              ? <p className="text-muted-foreground">Nenhum 🔴/🟡 efetivo no período.</p>
              : b.gateV2.porMotivo.map((m) => <div key={`${m.faixa}-${m.motivo}`}>{m.faixa} · {m.motivo}: {int(m.decisoes)}</div>)}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function BlocoConcordancia({ p }: { p: PainelCredito }) {
  const c = p.concordancia;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Concordância IA × regra</CardTitle>
        <CardDescription>A IA ainda não decide pedido (backtest IA × regra é a fatia 5b). Hoje: gate v2 em sombra (PR 5) — faixas e concordância com o piso atual.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {ind(c.concordancia) && <SemDado motivo={c.concordancia.motivo} />}
        {ind(c.sombra) ? <SemDado motivo={c.sombra.motivo} /> : (
          <div className="text-sm">
            <div className="font-medium">Faixas em sombra (estado atual por pedido)</div>
            {c.sombra.porFaixa.length === 0
              ? <p className="text-muted-foreground">Nenhum pedido avaliado em sombra ainda.</p>
              : c.sombra.porFaixa.map((m) => <div key={`${m.faixa}-${m.motivo}`}>{m.faixa} · {m.motivo}: {int(m.decisoes)}</div>)}
            <div className="mt-2 font-medium">Gate v2 × piso atual ({int(c.sombra.pvs)} pedidos, carga inicial fora)</div>
            {c.sombra.v2XPiso.length === 0
              ? <p className="text-muted-foreground">Sem pedido para comparar ainda.</p>
              : c.sombra.v2XPiso.map((m) => (
                <div key={`${m.faixa}-${String(m.pisoBloqueado)}`}>
                  v2 {m.faixa} · piso {m.pisoBloqueado === null ? 'sem informação' : m.pisoBloqueado ? 'bloqueou' : 'liberou'}: {int(m.decisoes)}
                </div>
              ))}
          </div>
        )}
        {ind(p.fila) ? <SemDado motivo={p.fila.motivo} /> : (
          <div className="grid grid-cols-2 gap-3">
            <Kpi rotulo="Fila 🟡 aberta" valor={int(p.fila.abertas)}
                 detalhe={p.fila.abertaMaisAntiga ? `mais antiga: ${new Date(p.fila.abertaMaisAntiga).toLocaleString('pt-BR')}` : undefined}
                 tom={(p.fila.abertas ?? 0) > 0 ? 'warning' : undefined} />
            <Kpi rotulo="Decididas no período" valor={int(p.fila.decididasPeriodo)} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function BlocoLiberados({ p }: { p: PainelCredito }) {
  const l = p.liberados;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Liberados que depois atrasaram</CardTitle>
        <CardDescription>{l.definicao ?? '—'}.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {l.coberturaParcial && (
          <Badge variant="outline" className="text-status-warning">parcial · {l.coberturaMotivo ?? 'cobertura incompleta'}</Badge>
        )}
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Kpi rotulo="Liberados no período" valor={int(l.liberados)} detalhe={brl(l.liberadosValor)} />
          <Kpi rotulo="Com título vencido > 15 d" valor={int(l.maturados)} detalhe={`${int(l.comTitulo)} com título`} />
          <Kpi rotulo="Atrasaram" valor={int(l.atrasados)} tom={(l.atrasados ?? 0) > 0 ? 'error' : undefined}
               detalhe={brl(l.saldoAtrasadoConhecido, (l.titulosAtrasadosSemSaldo ?? 0) > 0)} />
          <Kpi rotulo="Taxa de atraso"
               valor={l.taxaAtrasoPct === null ? '—' : `${l.taxaAtrasoPct.toLocaleString('pt-BR')}%`}
               detalhe={l.taxaAtrasoPct === null ? 'sem pedido maturado: sem denominador' : 'atrasados ÷ maturados'} />
        </div>
        {l.lista.length > 0 && (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>PV</TableHead><TableHead>Empresa</TableHead><TableHead>Via</TableHead>
                  <TableHead className="text-right">Em atraso</TableHead><TableHead className="text-right">Dias</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {l.lista.map((x) => (
                  <TableRow key={x.salesOrderId}>
                    <TableCell className="tabular-nums">{x.omieNumeroPedido?.replace(/^0+/, '') ?? '—'}</TableCell>
                    <TableCell>{NOME_EMPRESA[x.company] ?? x.company}</TableCell>
                    <TableCell>{VIA_LABEL[x.via] ?? x.via}</TableCell>
                    <TableCell className="text-right tabular-nums">{brl(x.saldoAtrasado)}</TableCell>
                    <TableCell className="text-right tabular-nums">{x.diasAtraso === null ? '—' : x.diasAtraso}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function CreditoPainel() {
  const [estado, setEstado] = useUrlState({ dias: 90 });
  const dias: PeriodoPainel = (PERIODOS_PAINEL as readonly number[]).includes(estado.dias)
    ? (estado.dias as PeriodoPainel) : 90;
  const q = useCreditoPainel(dias);

  useEffect(() => { track('credito.painel_aberto', { dias }); }, [dias]);

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl">Painel de crédito</h1>
          <p className="text-sm text-muted-foreground">
            Leitura para gestor/master. {q.data?.hojeSp && `Hoje (SP): ${new Date(`${q.data.hojeSp}T12:00:00`).toLocaleDateString('pt-BR')}.`}
          </p>
        </div>
        <div className="flex gap-1" role="group" aria-label="Período">
          {PERIODOS_PAINEL.map((d) => (
            <Button key={d} size="sm" variant={d === dias ? 'default' : 'outline'} onClick={() => setEstado({ dias: d })}>
              {d} d
            </Button>
          ))}
        </div>
      </div>

      {q.isLoading ? <PageSkeleton variant="cockpit" /> : q.isError ? (
        q.error.code === '42501'
          ? <EmptyState icon={Lock} tone="operational" title="Sem acesso"
                        description="O painel de crédito é só para gestor e master." />
          : <EmptyState icon={AlertTriangle} tone="operational" title="Não consegui carregar o painel"
                        description={q.error.message} actionLabel="Tentar de novo" onAction={() => void q.refetch()} />
      ) : q.data ? (
        <>
          {Object.keys(q.data.frescorCr).length > 0 && (
            <p className="text-xs text-muted-foreground">
              Espelho de contas a receber atualizado em:{' '}
              {Object.entries(q.data.frescorCr).map(([k, v]) => `${NOME_EMPRESA[k] ?? k} ${v ? new Date(v).toLocaleString('pt-BR') : '—'}`).join(' · ')}
            </p>
          )}
          <BlocoExposicao p={q.data} />
          <div className="grid gap-4 lg:grid-cols-2">
            <BlocoBloqueios p={q.data} />
            <BlocoConcordancia p={q.data} />
          </div>
          <BlocoLiberados p={q.data} />
        </>
      ) : null}
    </div>
  );
}
