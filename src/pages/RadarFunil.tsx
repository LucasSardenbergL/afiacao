// Radar H — funil do lead empurrado: e-mail semanal e card "Prospectar hoje" até o cadastro no Omie, por vendedor e
// por semana (RPC radar_funil, migration 20261107233000). Só master e gestor comercial (o servidor confere de novo).
// "—" = o sensor não cobria a semana (ausente ≠ zero); 0 = medido e nada aconteceu.
// Pacote M (20261111134500): aba "Uso" — a adoção sobre o universo de elegíveis e o experimento da coorte.
import { useEffect, useMemo, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, Lock, RefreshCw } from 'lucide-react';
import { EmptyState } from '@/components/EmptyState';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAuth } from '@/contexts/AuthContext';
import { useUrlState } from '@/hooks/useUrlState';
import { track } from '@/lib/analytics';
import {
  coberturaDoPeriodo,
  etapasAdocao,
  fmtContagem,
  fmtTaxa,
  inconsistencias,
  linhasDaSemana,
  linhasDoVendedor,
  rotuloSemana,
  SENSOR_DA_COLUNA,
  taxa,
  totalizar,
  type CoberturaSemana,
  type Coluna,
  type Contagens,
  type EstadoSensor,
  type ExperimentoFunil,
  type PainelFunil,
  type SemanaFunil,
  type SensorFunil,
} from '@/lib/radar/funil';
import { useRadarFunil, useRadarFunilExperimento } from '@/queries/useRadarFunil';

const PERIODOS = [4, 8, 12, 26] as const;
const TODOS = '';
const ABAS = ['funil', 'uso'] as const;

const ESTADO_UI: Record<EstadoSensor, { rotulo: string; classe: string; dica: string }> = {
  ok: { rotulo: 'ok', classe: 'text-status-success border-status-success/40', dica: 'Gravou no período, sem falha registrada.' },
  falhou: { rotulo: 'falhou', classe: 'text-status-error border-status-error/40', dica: 'Há falha registrada no período: o número abaixo pode estar menor que o real.' },
  parcial: { rotulo: 'parcial', classe: 'text-status-warning border-status-warning/40', dica: 'O sensor começou no meio do período: antes disso é "—".' },
  sem_dado_no_periodo: { rotulo: 'sem registro no período', classe: 'text-muted-foreground', dica: 'Cobria o período e não gravou nada: ou ninguém usou, ou o sensor não foi chamado.' },
  sem_registro: { rotulo: 'nunca gravou', classe: 'text-muted-foreground', dica: 'Nenhum registro desde a instalação (ou sem escritor no app ainda): tudo dele é "—".' },
};

function fmtData(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Sao_Paulo' });
}

/** Contagem com a marca de cobertura parcial ("*": o sensor começou no meio do recorte). */
function Num({ n, cobertura }: { n: number | null; cobertura?: CoberturaSemana }) {
  const parcial = cobertura === 'parcial' && n !== null;
  return (
    <span
      className={n === null ? 'text-muted-foreground' : 'tabular-nums'}
      title={n === null ? 'Sem dado: o sensor não cobria este recorte' : parcial ? 'Parcial: o sensor começou no meio do recorte' : undefined}
    >
      {fmtContagem(n)}
      {parcial ? <sup className="text-status-warning">*</sup> : null}
    </span>
  );
}

/** "x de y (z %)" — sempre com o denominador à vista. */
function DeX({ num, den, cobNum, cobDen }: { num: number | null; den: number | null; cobNum?: CoberturaSemana; cobDen?: CoberturaSemana }) {
  return (
    <span className="whitespace-nowrap">
      <Num n={num} cobertura={cobNum} /> <span className="text-muted-foreground">de</span> <Num n={den} cobertura={cobDen} />{' '}
      <span className="text-muted-foreground">({fmtTaxa(taxa(num, den))})</span>
    </span>
  );
}

function Etapa({ titulo, children, nota }: { titulo: string; children: ReactNode; nota?: string }) {
  return (
    <div className="rounded-md border p-3">
      <div className="text-xs text-muted-foreground">{titulo}</div>
      <div className="mt-1 text-sm font-medium">{children}</div>
      {nota ? <div className="mt-1 text-xs text-muted-foreground">{nota}</div> : null}
    </div>
  );
}

function ResumoFunil({ t, painel }: { t: Contagens; painel: PainelFunil }) {
  const cob = (c: Coluna) => coberturaDoPeriodo(painel, c);
  const avisos = inconsistencias(t);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Funil do período</CardTitle>
        <CardDescription>
          Cada etapa mostra o denominador. Cliques e fichas do e-mail contam na semana em que o e-mail saiu; card,
          contato e cadastro, na semana em que aconteceram.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">E-mail semanal</div>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <Etapa titulo="E-mails entregues" nota={`${fmtContagem(t.email_falhos)} falho(s) · ${fmtContagem(t.email_pendentes)} pendente(s)`}>
              <DeX num={t.email_entregues} den={t.email_enviados} cobNum={cob('email_entregues')} cobDen={cob('email_enviados')} />
            </Etapa>
            <Etapa titulo="Leads clicados (dos leads entregues)">
              <DeX num={t.email_leads_clicados} den={t.email_leads_entregues} cobNum={cob('email_leads_clicados')} cobDen={cob('email_leads_entregues')} />
            </Etapa>
            <Etapa titulo="Fichas entregues (dos cliques no e-mail)" nota="Clique sem ficha = o lead não chegou ao navegador.">
              <DeX num={t.email_fichas} den={t.email_leads_clicados} cobNum={cob('email_fichas')} cobDen={cob('email_leads_clicados')} />
            </Etapa>
          </div>
        </div>
        <div>
          <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Card “Prospectar hoje”</div>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <Etapa titulo="Dias com o card servido"
              nota={t.card_leads_exibidos !== null
                ? `${fmtContagem(t.card_leads_exibidos)} lead(s) exibidos, reposição incluída`
                : `${fmtContagem(t.card_leads_servidos)} lead(s) na 1ª exibição do dia`}>
              <Num n={t.card_dias} cobertura={cob('card_dias')} />
            </Etapa>
            {t.card_leads_exibidos !== null ? (
              <Etapa titulo="Leads clicados (dos exibidos)" nota="Cada lead exibido conta, inclusive o que entra depois de um Assumir.">
                <DeX num={t.card_leads_clicados_exibidos} den={t.card_leads_exibidos}
                  cobNum={cob('card_leads_clicados_exibidos')} cobDen={cob('card_leads_exibidos')} />
              </Etapa>
            ) : (
              <Etapa titulo="Leads clicados (da 1ª exibição do dia)"
                nota="Sem o sensor de exibição: o lead que entra depois de um Assumir não está no denominador.">
                <DeX num={t.card_leads_clicados} den={t.card_leads_servidos} cobNum={cob('card_leads_clicados')} cobDen={cob('card_leads_servidos')} />
              </Etapa>
            )}
            <Etapa titulo="Fichas entregues (dos cliques no card)">
              <DeX num={t.card_fichas} den={t.card_leads_clicados} cobNum={cob('card_fichas')} cobDen={cob('card_leads_clicados')} />
            </Etapa>
          </div>
        </div>
        <div>
          <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">Depois da ficha</div>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <Etapa titulo="Intenções de contato" nota="Tocou em Ligar (celular), WhatsApp ou Copiar telefone na ficha: 1 por lead, canal e dia.">
              <Num n={t.intencoes} cobertura={cob('intencoes')} />
            </Etapa>
            <Etapa titulo="Contatos humanos em lead empurrado (do total de contatos)" nota="Toque registrado: sem resposta ou em conversa.">
              <DeX num={t.contatos_empurrados} den={t.contatos} cobNum={cob('contatos_empurrados')} cobDen={cob('contatos')} />
            </Etapa>
            <Etapa titulo="Clientes novos no Omie de lead empurrado (do total de novos)" nota={`${fmtContagem(t.cadastros_vinculo)} vínculo(s) com cliente que já existia`}>
              <DeX num={t.cadastros_novos_empurrados} den={t.cadastros_novos} cobNum={cob('cadastros_novos_empurrados')} cobDen={cob('cadastros_novos')} />
            </Etapa>
          </div>
        </div>
        {avisos.length > 0 ? (
          <div className="flex items-start gap-2 rounded-md border border-status-warning/40 p-3 text-sm text-status-warning">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <ul>{avisos.map((a) => <li key={a.etapa}>{a.detalhe}</li>)}</ul>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function SaudeSensores({ sensores }: { sensores: SensorFunil[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Saúde dos sensores</CardTitle>
        <CardDescription>
          Antes da instalação, o número é “—” (não 0). Falha registrada quer dizer que algum evento pode não ter
          entrado na conta.
        </CardDescription>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Sensor</TableHead>
              <TableHead>Estado</TableHead>
              <TableHead>Cobre desde</TableHead>
              <TableHead>Último registro</TableHead>
              <TableHead className="text-right">Registros no período</TableHead>
              <TableHead>Falhas no período</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sensores.map((s) => {
              const e = ESTADO_UI[s.estado];
              return (
                <TableRow key={s.sensor}>
                  <TableCell>
                    <div className="font-medium">{s.rotulo}</div>
                    <div className="text-xs text-muted-foreground">{s.fonte}</div>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className={e.classe} title={e.dica}>{e.rotulo}</Badge>
                  </TableCell>
                  <TableCell className="whitespace-nowrap">{fmtData(s.coberturaDesde)}</TableCell>
                  <TableCell className="whitespace-nowrap">{fmtData(s.ultimoRegistroEm)}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmtContagem(s.registrosPeriodo)}</TableCell>
                  <TableCell className="text-sm">
                    {s.falhas.length === 0 ? (
                      <span className="text-muted-foreground">nenhuma</span>
                    ) : (
                      s.falhas.map((f) => (
                        <div key={f.motivo} className="text-status-error">
                          {fmtContagem(f.n)} × {f.motivo.replace(/_/g, ' ')}
                        </div>
                      ))
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

/** As colunas das tabelas (semana e vendedor): o mesmo funil, compacto. */
function CelulasFunil({ c, cob }: { c: Contagens; cob: (col: Coluna) => CoberturaSemana }) {
  return (
    <>
      <TableCell className="text-right"><DeX num={c.email_entregues} den={c.email_enviados} cobNum={cob('email_entregues')} cobDen={cob('email_enviados')} /></TableCell>
      <TableCell className="text-right"><DeX num={c.email_leads_clicados} den={c.email_leads_entregues} cobNum={cob('email_leads_clicados')} cobDen={cob('email_leads_entregues')} /></TableCell>
      <TableCell className="text-right"><Num n={c.email_fichas} cobertura={cob('email_fichas')} /></TableCell>
      <TableCell className="text-right">
        {c.card_leads_exibidos !== null
          ? <DeX num={c.card_leads_clicados_exibidos} den={c.card_leads_exibidos} cobNum={cob('card_leads_clicados_exibidos')} cobDen={cob('card_leads_exibidos')} />
          : <DeX num={c.card_leads_clicados} den={c.card_leads_servidos} cobNum={cob('card_leads_clicados')} cobDen={cob('card_leads_servidos')} />}
      </TableCell>
      <TableCell className="text-right"><Num n={c.card_fichas} cobertura={cob('card_fichas')} /></TableCell>
      <TableCell className="text-right"><Num n={c.intencoes} cobertura={cob('intencoes')} /></TableCell>
      <TableCell className="text-right"><DeX num={c.contatos_empurrados} den={c.contatos} cobNum={cob('contatos_empurrados')} cobDen={cob('contatos')} /></TableCell>
      <TableCell className="text-right"><DeX num={c.cadastros_novos_empurrados} den={c.cadastros_novos} cobNum={cob('cadastros_novos_empurrados')} cobDen={cob('cadastros_novos')} /></TableCell>
    </>
  );
}

function CabecalhoFunil({ primeira }: { primeira: string }) {
  return (
    <TableHeader>
      <TableRow>
        <TableHead>{primeira}</TableHead>
        <TableHead className="text-right">E-mails entregues</TableHead>
        <TableHead className="text-right">Leads clicados (e-mail)</TableHead>
        <TableHead className="text-right">Fichas (e-mail)</TableHead>
        <TableHead className="text-right">Clicados (card)</TableHead>
        <TableHead className="text-right">Fichas (card)</TableHead>
        <TableHead className="text-right">Intenções de contato</TableHead>
        <TableHead className="text-right">Contatos em empurrado</TableHead>
        <TableHead className="text-right">Novos no Omie de empurrado</TableHead>
      </TableRow>
    </TableHeader>
  );
}

function PorSemana({ painel, vendedor }: { painel: PainelFunil; vendedor: string | null }) {
  const cobDaSemana = (s: SemanaFunil) => (col: Coluna) => s.cobertura[SENSOR_DA_COLUNA[col]] ?? 'ausente';
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Por semana</CardTitle>
        <CardDescription>Segunda a domingo, horário de Brasília. <sup className="text-status-warning">*</sup> = sensor começou no meio da semana.</CardDescription>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <Table>
          <CabecalhoFunil primeira="Semana" />
          <TableBody>
            {painel.semanas.map((s) => (
              <TableRow key={s.semana}>
                <TableCell className="whitespace-nowrap font-medium">
                  {rotuloSemana(s.semana)}
                  {s.corrente ? <span className="ml-1 text-xs text-muted-foreground">(em curso)</span> : null}
                </TableCell>
                <CelulasFunil c={totalizar(linhasDaSemana(painel, s.semana, vendedor), cobDaSemana(s))} cob={cobDaSemana(s)} />
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function PorVendedor({ painel }: { painel: PainelFunil }) {
  const cob = (col: Coluna) => coberturaDoPeriodo(painel, col);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Por vendedor (período inteiro)</CardTitle>
        <CardDescription>Todo vendedor elegível agora, mesmo sem atividade (zero é zero), e quem teve atividade no período.</CardDescription>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <Table>
          <CabecalhoFunil primeira="Vendedor" />
          <TableBody>
            {painel.vendedores.map((v) => (
              <TableRow key={v.userId}>
                <TableCell className="whitespace-nowrap font-medium">{v.nome ?? <span className="text-muted-foreground">sem nome</span>}</TableCell>
                <CelulasFunil c={totalizar(linhasDoVendedor(painel, v.userId), cob)} cob={cob} />
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

/** Adoção sobre o universo (pacote M): todas as etapas com o MESMO denominador, os elegíveis agora. */
function Adocao({ painel, vendedor }: { painel: PainelFunil; vendedor: string | null }) {
  const a = painel.adocao;
  if (!a) {
    return (
      <EmptyState icon={AlertTriangle} tone="operational" title="Adoção ainda sem leitura"
        description="O banco ainda não tem o pacote M (migration 20261111134500): sem o universo de elegíveis, a adoção não é mostrada (nada de 0 inventado)." />
    );
  }
  const e = etapasAdocao(a, vendedor);
  const nome = new Map(painel.vendedores.map((v) => [v.userId, v.nome]));
  const linhas = a.vendedores.filter((v) => vendedor === null || v.userId === vendedor);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Adoção no período</CardTitle>
        <CardDescription>
          Denominador = quem pode usar o Radar AGORA (a autorização de semanas passadas não é reconstruída). Exposto: o
          Radar chegou a ele (card, e-mail entregue, tela ou ficha aberta). Ação humana: clique em lead, ficha aberta,
          intenção de contato, contato registrado, cadastro ou assumir um lead.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <Etapa titulo="Elegíveis agora"><Num n={e.elegiveis} /></Etapa>
          <Etapa titulo="Expostos ao Radar"><DeX num={e.expostos} den={e.elegiveis} /></Etapa>
          <Etapa titulo="Com 1ª ação humana"><DeX num={e.comAcao} den={e.elegiveis} /></Etapa>
          <Etapa titulo="Usaram em outro dia" nota="Ação em 2 dias ou mais no período.">
            <DeX num={e.voltaram} den={e.elegiveis} />
          </Etapa>
        </div>
        {e.foraDoUniverso > 0 ? (
          <p className="text-xs text-muted-foreground">
            {fmtContagem(e.foraDoUniverso)} pessoa(s) agiram no período sem ser elegíveis hoje (perderam o acesso): fora do denominador.
          </p>
        ) : null}
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Vendedor</TableHead>
                <TableHead>Elegível agora</TableHead>
                <TableHead>Exposto em</TableHead>
                <TableHead>1ª ação</TableHead>
                <TableHead>Última ação</TableHead>
                <TableHead className="text-right">Dias com ação</TableHead>
                <TableHead className="text-right">Ações</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {linhas.map((v) => (
                <TableRow key={v.userId} data-testid="radar-adocao-linha">
                  <TableCell className="whitespace-nowrap font-medium">{nome.get(v.userId) ?? <span className="text-muted-foreground">sem nome</span>}</TableCell>
                  <TableCell>{v.elegivel ? 'sim' : <span className="text-muted-foreground">não</span>}</TableCell>
                  <TableCell className="whitespace-nowrap">{fmtData(v.expostoEm)}</TableCell>
                  <TableCell className="whitespace-nowrap">{fmtData(v.primeiraAcaoEm)}</TableCell>
                  <TableCell className="whitespace-nowrap">{fmtData(v.ultimaAcaoEm)}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmtContagem(v.diasComAcao)}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmtContagem(v.acoes)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

/** O experimento da coorte (topo × amostra) e a conversão por faixa: leitura, nunca conclusão. */
function Experimento({ q }: { q: { data?: ExperimentoFunil; isLoading: boolean; isError: boolean; error: unknown; refetch: () => unknown } }) {
  if (q.isLoading) return <PageSkeleton variant="cockpit" />;
  if (q.isError || !q.data) {
    return (
      <EmptyState icon={AlertTriangle} tone="operational" title="Não consegui ler o experimento"
        description={q.error instanceof Error ? q.error.message : 'A leitura falhou. Nenhum número é mostrado no lugar.'}
        actionLabel="Tentar de novo" onAction={() => void q.refetch()} />
    );
  }
  const x = q.data;
  const tocados = x.coortes.reduce((s, c) => s + c.tocados, 0);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Experimento da coorte (em aberto)</CardTitle>
        <CardDescription>
          Em cada lote, todos os leads do topo (nota ≥ 70) e uma amostra fora dele foram registrados no mesmo instante.
          Conta só o que aconteceu depois do sorteio. Com {fmtContagem(tocados)} lead(s) tocado(s) nas coortes, não há
          base para comparar os grupos: o experimento segue aberto.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 overflow-x-auto">
        {x.coortes.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nenhuma coorte sorteada.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Sorteio</TableHead>
                <TableHead>Grupo</TableHead>
                <TableHead className="text-right">Tocados</TableHead>
                <TableHead className="text-right">Em conversa</TableHead>
                <TableHead className="text-right">Viraram cliente</TableHead>
                <TableHead className="text-right">Dias</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {x.coortes.map((c) => (
                <TableRow key={`${c.sorteio}:${c.grupo}`} data-testid="radar-coorte-linha">
                  <TableCell className="whitespace-nowrap">{c.sorteio}</TableCell>
                  <TableCell>{c.grupo === 'topo' ? 'topo (≥ 70)' : 'amostra (40–69)'}</TableCell>
                  <TableCell className="text-right"><DeX num={c.tocados} den={c.sorteados} /></TableCell>
                  <TableCell className="text-right"><DeX num={c.emConversa} den={c.sorteados} /></TableCell>
                  <TableCell className="text-right"><DeX num={c.virouCliente} den={c.sorteados} /></TableCell>
                  <TableCell className="text-right tabular-nums">{fmtContagem(c.diasDeAcompanhamento)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        <div>
          <div className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">Conversão pela nota no 1º toque</div>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Faixa</TableHead>
                <TableHead className="text-right">Leads tocados</TableHead>
                <TableHead className="text-right">Em conversa</TableHead>
                <TableHead className="text-right">Viraram cliente</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {x.faixas.map((f) => (
                <TableRow key={f.faixa}>
                  <TableCell>{f.faixa}</TableCell>
                  <TableCell className="text-right tabular-nums">{fmtContagem(f.leadsTocados)}</TableCell>
                  <TableCell className="text-right"><DeX num={f.emConversa} den={f.leadsTocados} /></TableCell>
                  <TableCell className="text-right"><DeX num={f.virouCliente} den={f.leadsTocados} /></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

export default function RadarFunil() {
  const { isMaster, isGestorComercial, loading } = useAuth();
  const pode = isMaster || isGestorComercial;
  const [f, setF] = useUrlState({ semanas: 8, vendedor: TODOS, aba: 'funil' });
  const semanas = (PERIODOS as readonly number[]).includes(f.semanas) ? f.semanas : 8;
  const aba = (ABAS as readonly string[]).includes(f.aba) ? f.aba : 'funil';
  const q = useRadarFunil(semanas, pode);
  const qx = useRadarFunilExperimento(pode && aba === 'uso');

  useEffect(() => {
    if (pode) track('radar.funil_aberto', { semanas });
  }, [pode, semanas]);

  const painel = q.data;
  const vendedor = painel && f.vendedor && painel.vendedores.some((v) => v.userId === f.vendedor) ? f.vendedor : null;
  const total = useMemo(
    () =>
      painel
        ? totalizar(vendedor ? linhasDoVendedor(painel, vendedor) : painel.linhas, (col) => coberturaDoPeriodo(painel, col))
        : null,
    [painel, vendedor],
  );

  if (loading) return <PageSkeleton variant="cockpit" />;
  if (!pode) {
    return (
      <EmptyState
        icon={Lock}
        tone="operational"
        title="Só master ou gestor comercial"
        description="O funil do Radar mostra o uso de cada vendedor. Peça acesso a quem administra o app."
      />
    );
  }

  return (
    <div className="space-y-4 p-4 md:p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <Link to="/radar" className="mb-1 inline-flex items-center gap-1 text-xs text-muted-foreground hover:underline">
            <ArrowLeft className="h-3 w-3" /> Radar de Clientes
          </Link>
          <h1 className="font-display text-2xl">Funil do Radar</h1>
          <p className="text-sm text-muted-foreground">
            Do e-mail semanal e do card “Prospectar hoje” até o cadastro no Omie. “—” = sem dado (o sensor não cobria);
            0 = medido e nada aconteceu.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select value={String(semanas)} onValueChange={(v) => setF({ semanas: Number(v) })}>
            <SelectTrigger className="w-[150px]" aria-label="Período"><SelectValue /></SelectTrigger>
            <SelectContent>
              {PERIODOS.map((p) => <SelectItem key={p} value={String(p)}>Últimas {p} semanas</SelectItem>)}
            </SelectContent>
          </Select>
          <Select value={vendedor ?? 'todos'} onValueChange={(v) => setF({ vendedor: v === 'todos' ? TODOS : v })} disabled={!painel}>
            <SelectTrigger className="w-[200px]" aria-label="Vendedor"><SelectValue placeholder="Todos os vendedores" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="todos">Todos os vendedores</SelectItem>
              {painel?.vendedores.map((v) => (
                <SelectItem key={v.userId} value={v.userId}>{v.nome ?? 'sem nome'}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" onClick={() => void q.refetch()} disabled={q.isFetching}>
            <RefreshCw className={`mr-1 h-4 w-4 ${q.isFetching ? 'animate-spin' : ''}`} /> Atualizar
          </Button>
        </div>
      </div>

      {q.isLoading ? (
        <PageSkeleton variant="cockpit" />
      ) : q.isError || !painel || !total ? (
        <EmptyState
          icon={AlertTriangle}
          tone="operational"
          title="Não consegui ler o funil"
          description={q.error instanceof Error ? q.error.message : 'A leitura falhou. Nenhum número é mostrado no lugar (nada de 0 inventado).'}
          actionLabel="Tentar de novo"
          onAction={() => void q.refetch()}
        />
      ) : (
        <>
          <p className="text-xs text-muted-foreground">
            {rotuloSemana(painel.inicio)} a {rotuloSemana(painel.fim)} · {painel.vendedores.length} vendedor(es) no
            painel{painel.adocao ? ` (${painel.adocao.elegiveisAgora} elegível(is) agora)` : ''} · lido em {fmtData(painel.geradoEm)}
          </p>
          <Tabs value={aba} onValueChange={(v) => { setF({ aba: v }); track('radar.funil_aba', { aba: v }); }}>
            <TabsList>
              <TabsTrigger value="funil">Funil</TabsTrigger>
              <TabsTrigger value="uso">Uso</TabsTrigger>
            </TabsList>
            <TabsContent value="funil" className="space-y-4">
              <ResumoFunil t={total} painel={painel} />
              <SaudeSensores sensores={painel.sensores} />
              <PorSemana painel={painel} vendedor={vendedor} />
              {vendedor === null && painel.vendedores.length > 0 ? <PorVendedor painel={painel} /> : null}
            </TabsContent>
            <TabsContent value="uso" className="space-y-4">
              <Adocao painel={painel} vendedor={vendedor} />
              <Experimento q={qx} />
            </TabsContent>
          </Tabs>
        </>
      )}
    </div>
  );
}
