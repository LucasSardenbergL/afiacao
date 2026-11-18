import { useMemo, useState, type ReactNode } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight, ListChecks, Truck, PackageSearch, Trash2 } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { EmptyState } from '@/components/EmptyState';
import { AvisoLeituraFalhou } from '@/components/leitura/AvisoLeituraFalhou';
import { useUrlState } from '@/hooks/useUrlState';
import { useAuth } from '@/contexts/AuthContext';
import { cn } from '@/lib/utils';
import { hojeSP } from '@/lib/time/sp-day';
import { estadoDeLeitura, naoConsegui, type FatiaDeQuery } from '@/lib/leitura/estado-de-leitura';
import { calcularPendencias, janelaFimDeAno, type Pendencia } from '@/lib/reposicao/calendario/pendencias';
import {
  agruparPeriodos,
  fimDoRecesso,
  montarGradeMes,
  pesoDoStatus,
  ROTULO_STATUS,
  STATUS_DIA,
  type CelulaGrade,
  type StatusDia,
} from '@/lib/reposicao/calendario/grade';
import {
  EMPRESAS_CALENDARIO,
  useDiasEmpresa,
  useDiasSemNf,
  useFechamentosFornecedor,
  useFeriados,
  useFornecedoresHabilitados,
  useIncluirPeriodoFornecedor,
  useItensAntecipar,
  useResumoAntecipar,
  useRemoverDiaEmpresa,
  useRemoverPeriodoFornecedor,
  useSalvarDiaEmpresa,
  type EmpresaCalendario,
  type ResumoAntecipar,
} from '@/hooks/useCalendarioOperacao';

const MESES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
const DIAS_SEMANA = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'];
const fmtBr = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const fatia = (q: FatiaDeQuery): FatiaDeQuery => ({ status: q.status, fetchStatus: q.fetchStatus });

const CLASSE_STATUS: Record<StatusDia, string> = {
  aberto: 'bg-status-success-bg text-status-success border-status-success/30',
  fechado: 'bg-muted text-muted-foreground border-border',
  meia_equipe: 'bg-status-info-bg text-status-info border-status-info/30',
  pendente_dado: 'bg-status-warning-bg text-status-warning border-status-warning/30',
};

export default function AdminReposicaoCalendario() {
  const hoje = hojeSP();
  const [url, setUrl] = useUrlState({ empresa: 'OBEN', ano: Number(hoje.slice(0, 4)), mes: Number(hoje.slice(5, 7)) });
  const empresa: EmpresaCalendario = url.empresa === 'COLACOR' ? 'COLACOR' : 'OBEN';
  const mes = Math.min(12, Math.max(1, Math.trunc(url.mes)));
  const ano = Math.trunc(url.ano);
  const { isMaster } = useAuth();

  const diasEmpresa = useDiasEmpresa(empresa);
  const feriados = useFeriados();
  const diasSemNf = useDiasSemNf(empresa, hoje);
  const habilitados = useFornecedoresHabilitados(empresa);
  const fechamentosForn = useFechamentosFornecedor(empresa);

  const recesso = useMemo(() => (diasEmpresa.data ? fimDoRecesso(diasEmpresa.data, hoje) : null), [diasEmpresa.data, hoje]);
  const antecipar = useItensAntecipar(empresa, recesso);
  const resumoAntecipar = useResumoAntecipar(empresa, recesso);

  const [diaAberto, setDiaAberto] = useState<CelulaGrade | null>(null);
  const [prefillFornecedor, setPrefillFornecedor] = useState<PrefillFornecedor | null>(null);

  const andarMes = (delta: number) => {
    const m0 = mes - 1 + delta;
    setUrl({ ano: ano + Math.floor(m0 / 12), mes: ((m0 % 12) + 12) % 12 + 1 });
  };

  const anosOpcoes = useMemo(() => {
    const base = Number(hoje.slice(0, 4));
    const s = new Set<number>([ano]);
    for (let a = base - 2; a <= base + 4; a++) s.add(a);
    return [...s].sort();
  }, [hoje, ano]);

  return (
    <div className="space-y-4 p-4">
      <header className="space-y-1">
        <h1 className="font-display text-3xl flex items-center gap-2">
          <CalendarDays className="h-6 w-6" /> Calendário de operação
        </h1>
        <p className="text-sm text-muted-foreground">
          Dias fechados da empresa e dos fornecedores. Dia sem registro segue a regra base: aberto de segunda a
          sexta, fechado no sábado e no domingo.{!isMaster && ' Somente leitura — só o master edita.'}
        </p>
      </header>

      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label htmlFor="cal-empresa">Empresa</Label>
          <Select value={empresa} onValueChange={(v) => setUrl({ empresa: v })}>
            <SelectTrigger id="cal-empresa" className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {EMPRESAS_CALENDARIO.map((e) => (
                <SelectItem key={e} value={e}>
                  {e}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="cal-ano">Ano</Label>
          <Select value={String(ano)} onValueChange={(v) => setUrl({ ano: Number(v) })}>
            <SelectTrigger id="cal-ano" className="w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {anosOpcoes.map((a) => (
                <SelectItem key={a} value={String(a)}>
                  {a}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-1">
          <Button variant="outline" size="icon" aria-label="Mês anterior" onClick={() => andarMes(-1)}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Select value={String(mes)} onValueChange={(v) => setUrl({ mes: Number(v) })}>
            <SelectTrigger className="w-36" aria-label="Mês">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MESES.map((m, i) => (
                <SelectItem key={m} value={String(i + 1)}>
                  {m}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="outline" size="icon" aria-label="Próximo mês" onClick={() => andarMes(1)}>
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <PainelPendencias
        empresa={empresa}
        hoje={hoje}
        podeEditar={isMaster}
        diasEmpresa={diasEmpresa}
        feriados={feriados}
        diasSemNf={diasSemNf}
        habilitados={habilitados}
        fechamentos={fechamentosForn}
        onIncluirRecesso={(nome) => {
          const j = janelaFimDeAno(hoje);
          setPrefillFornecedor((ant) => ({ nome, de: j.de, ate: j.ate, n: (ant?.n ?? 0) + 1 }));
          document.getElementById('cal-fornecedores')?.scrollIntoView({ behavior: 'smooth' });
        }}
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {MESES[mes - 1]} de {ano} — {empresa}
          </CardTitle>
          <CardDescription>Clique num dia para ver o detalhe{isMaster ? ' e editar' : ''}.</CardDescription>
        </CardHeader>
        <CardContent>
          <GradeMes
            ano={ano}
            mes={mes}
            diasEmpresa={diasEmpresa}
            feriados={feriados}
            onAbrir={setDiaAberto}
          />
        </CardContent>
      </Card>

      <CartaoFornecedores
        empresa={empresa}
        ano={ano}
        podeEditar={isMaster}
        habilitados={habilitados}
        fechamentos={fechamentosForn}
        prefill={prefillFornecedor}
      />

      <CartaoAntecipar diasEmpresa={diasEmpresa} recesso={recesso} antecipar={antecipar} resumo={resumoAntecipar} />

      <DialogoDia
        celula={diaAberto}
        empresa={empresa}
        podeEditar={isMaster}
        onFechar={() => setDiaAberto(null)}
      />
    </div>
  );
}

/* ─── grade ─── */

type PrefillFornecedor = { nome: string; de: string; ate: string; n: number };
type QueryDe<T> = FatiaDeQuery & { data: T | undefined };

function GradeMes({
  ano,
  mes,
  diasEmpresa,
  feriados,
  onAbrir,
}: {
  ano: number;
  mes: number;
  diasEmpresa: QueryDe<{ data: string; status: string; peso: number; motivo: string | null; origem: string }[]>;
  feriados: QueryDe<{ data: string; nome: string }[]>;
  onAbrir: (c: CelulaGrade) => void;
}) {
  const estDias = estadoDeLeitura(fatia(diasEmpresa));
  const estFer = estadoDeLeitura(fatia(feriados));
  // Sem a tabela da empresa não há grade — a regra base sozinha AFIRMARIA "aberto" onde pode haver recesso.
  if (naoConsegui(estDias)) {
    return <AvisoLeituraFalhou oque="os dias da empresa" estado={estDias} variante="bloco" testId="aviso-grade" />;
  }
  if (!diasEmpresa.data) return <PageSkeleton variant="cockpit" />;
  const celulas = montarGradeMes(ano, mes, diasEmpresa.data, feriados.data ?? []);
  const vazias = celulas[0].diaSemana - 1;
  return (
    <div className="space-y-3" data-testid="grade-mes">
      {naoConsegui(estFer) && (
        <AvisoLeituraFalhou oque="os feriados (a grade mostra os dias sem a marcação de feriado)" estado={estFer} testId="aviso-feriados" />
      )}
      <div className="grid grid-cols-7 gap-1 text-xs">
        {DIAS_SEMANA.map((d) => (
          <div key={d} className="px-1 py-1 font-medium text-muted-foreground">
            {d}
          </div>
        ))}
        {Array.from({ length: vazias }, (_, i) => (
          <div key={`v${i}`} />
        ))}
        {celulas.map((c) => (
          <button
            key={c.data}
            type="button"
            onClick={() => onAbrir(c)}
            data-status={c.status}
            data-regra-base={c.regraBase ? '1' : '0'}
            title={c.linha?.motivo ?? (c.regraBase ? 'Regra base' : undefined)}
            className={cn(
              'flex min-h-16 flex-col items-start gap-0.5 rounded-md border p-1.5 text-left transition-colors hover:ring-1 hover:ring-ring',
              CLASSE_STATUS[c.status],
              c.regraBase && 'border-dashed opacity-80',
            )}
          >
            <span className="font-medium tabular-nums">{Number(c.data.slice(8, 10))}</span>
            <span className="leading-tight">{ROTULO_STATUS[c.status]}</span>
            {c.feriado && <span className="leading-tight text-[10px] font-medium">{c.feriado}</span>}
            {!c.regraBase && c.linha && <span className="text-[10px] opacity-70">{c.linha.origem}</span>}
          </button>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        Borda tracejada = sem registro, vale a regra base (seg–sex aberto, sáb/dom fechado).
      </p>
    </div>
  );
}

function DialogoDia({
  celula,
  empresa,
  podeEditar,
  onFechar,
}: {
  celula: CelulaGrade | null;
  empresa: EmpresaCalendario;
  podeEditar: boolean;
  onFechar: () => void;
}) {
  const salvar = useSalvarDiaEmpresa();
  const remover = useRemoverDiaEmpresa();
  const [status, setStatus] = useState<StatusDia>('aberto');
  const [motivo, setMotivo] = useState('');
  const [chave, setChave] = useState<string | null>(null);
  // Reinicia o formulário quando o dia muda (sem efeito: compara a chave no render).
  const chaveAtual = celula ? `${empresa}:${celula.data}` : null;
  if (chaveAtual !== chave) {
    setChave(chaveAtual);
    if (celula) {
      setStatus(celula.status);
      setMotivo(celula.linha?.motivo ?? '');
    }
  }

  return (
    <Dialog open={celula !== null} onOpenChange={(o) => !o && onFechar()}>
      <DialogContent>
        {celula && (
          <>
            <DialogHeader>
              <DialogTitle>
                {fmtBr(celula.data)} — {empresa}
              </DialogTitle>
              <DialogDescription>
                {celula.regraBase
                  ? `Sem registro: vale a regra base (${ROTULO_STATUS[celula.status].toLowerCase()}).`
                  : `Registrado: ${ROTULO_STATUS[celula.status]} · origem ${celula.linha?.origem}.`}
                {celula.feriado && ` Feriado: ${celula.feriado}.`}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <div className="space-y-1">
                <Label htmlFor="dia-status">Status</Label>
                <Select value={status} onValueChange={(v) => setStatus(v as StatusDia)} disabled={!podeEditar}>
                  <SelectTrigger id="dia-status">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {STATUS_DIA.map((s) => (
                      <SelectItem key={s} value={s}>
                        {ROTULO_STATUS[s]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="dia-motivo">Motivo</Label>
                <Textarea id="dia-motivo" value={motivo} onChange={(e) => setMotivo(e.target.value)} disabled={!podeEditar} rows={2} />
              </div>
              <p className="text-xs text-muted-foreground">
                Peso: {podeEditar ? pesoDoStatus(status) : (celula.linha?.peso ?? pesoDoStatus(celula.status))} (fechado = 0;
                os demais = 1). Gravado automaticamente.
              </p>
            </div>
            {podeEditar && (
              <DialogFooter className="gap-2">
                {!celula.regraBase && (
                  <Button
                    variant="outline"
                    disabled={remover.isPending}
                    onClick={() => remover.mutate({ empresa, data: celula.data }, { onSuccess: onFechar })}
                  >
                    Voltar à regra base
                  </Button>
                )}
                <Button
                  disabled={salvar.isPending}
                  onClick={() =>
                    salvar.mutate(
                      { empresa, data: celula.data, status, motivo, origem: 'manual', contexto: 'grade' },
                      { onSuccess: onFechar },
                    )
                  }
                >
                  Salvar
                </Button>
              </DialogFooter>
            )}
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/* ─── pendências ─── */

const ROTULO_TIPO: Record<Pendencia['tipo'], string> = {
  emenda_sem_decisao: 'Emenda',
  dia_sem_nf: 'Dia sem NF',
  calendario_curto: 'Calendário curto',
  fornecedor_sem_recesso: 'Fornecedor sem recesso',
};

function PainelPendencias({
  empresa,
  hoje,
  podeEditar,
  diasEmpresa,
  feriados,
  diasSemNf,
  habilitados,
  fechamentos,
  onIncluirRecesso,
}: {
  empresa: EmpresaCalendario;
  hoje: string;
  podeEditar: boolean;
  diasEmpresa: QueryDe<{ data: string; status: string; origem: string }[]>;
  feriados: QueryDe<{ data: string; nome: string }[]>;
  diasSemNf: QueryDe<string[]>;
  habilitados: QueryDe<string[]>;
  fechamentos: QueryDe<{ data: string; fornecedor_nome: string }[]>;
  onIncluirRecesso: (fornecedor: string) => void;
}) {
  const salvar = useSalvarDiaEmpresa();
  const fontes = [
    { oque: 'os dias da empresa', q: diasEmpresa },
    { oque: 'os feriados', q: feriados },
    { oque: 'os dias sem NF', q: diasSemNf },
    { oque: 'os fornecedores habilitados', q: habilitados },
    { oque: 'os fechamentos dos fornecedores', q: fechamentos },
  ].map((f) => ({ ...f, estado: estadoDeLeitura(fatia(f.q)) }));
  const falhas = fontes.filter((f) => naoConsegui(f.estado));
  // COLACOR: a detecção de dia sem NF não existe por desenho (`enabled:false`) — isso NÃO é falha.
  const carregando = fontes.some((f) => f.estado === 'carregando');

  let corpo: ReactNode;
  if (falhas.length > 0) {
    corpo = (
      <AvisoLeituraFalhou
        oque={`as pendências (${falhas.map((f) => f.oque).join(', ')})`}
        estado={naoConsegui(falhas[0].estado) ? falhas[0].estado : 'erro'}
        variante="bloco"
        testId="aviso-pendencias"
      />
    );
  } else if (carregando || !diasEmpresa.data || !feriados.data || !habilitados.data || !fechamentos.data) {
    corpo = <PageSkeleton variant="list" />;
  } else {
    const linhas = diasEmpresa.data;
    const pendencias = calcularPendencias({
      hoje,
      feriados: feriados.data,
      diasEmpresa: linhas,
      diasSemNf: empresa === 'OBEN' ? (diasSemNf.data ?? []) : [],
      ultimoDiaCadastrado: linhas.length ? linhas[linhas.length - 1].data : null,
      fornecedoresHabilitados: habilitados.data,
      fechamentosFornecedor: fechamentos.data,
    });
    corpo =
      pendencias.length === 0 ? (
        <EmptyState
          tone="operational"
          icon={ListChecks}
          title="Nenhuma pendência"
          description="Emendas decididas, nenhum dia sem NF a resolver, calendário cobre 12 meses e todo fornecedor habilitado tem recesso."
        />
      ) : (
        <ul className="divide-y" data-testid="lista-pendencias">
          {pendencias.map((p) => (
            <li key={`${p.tipo}:${p.data}:${p.fornecedor_nome ?? ''}`} className="flex flex-wrap items-center gap-2 py-2 text-sm">
              <Badge variant={p.urgente ? 'destructive' : 'outline'}>{ROTULO_TIPO[p.tipo]}</Badge>
              <span className="min-w-0 flex-1">{p.texto}</span>
              {podeEditar && p.tipo === 'emenda_sem_decisao' && (
                <span className="flex gap-1">
                  {(['fechado', 'meia_equipe', 'aberto'] as const).map((s) => (
                    <Button
                      key={s}
                      size="sm"
                      variant={s === 'fechado' ? 'default' : 'outline'}
                      disabled={salvar.isPending}
                      onClick={() =>
                        salvar.mutate({
                          empresa,
                          data: p.data,
                          status: s,
                          motivo:
                            s === 'fechado'
                              ? 'Emenda de feriado: empresa fechada'
                              : s === 'meia_equipe'
                                ? 'Emenda de feriado: meia equipe'
                                : 'Emenda de feriado decidida: dia normal de trabalho',
                          origem: 'emenda',
                          contexto: 'emenda',
                        })
                      }
                    >
                      {s === 'fechado' ? 'Emendar (fechar)' : s === 'aberto' ? 'Trabalhar' : 'Meia equipe'}
                    </Button>
                  ))}
                </span>
              )}
              {podeEditar && p.tipo === 'dia_sem_nf' && (
                <span className="flex gap-1">
                  {(
                    [
                      ['fechado', 'Fechado', 'Sem NF: empresa fechada'],
                      ['pendente_dado', 'Dado faltante', 'Dado faltante: empresa aberta, NF ausente no sistema'],
                      ['aberto', 'Aberto', 'Sem NF: empresa aberta, sem venda'],
                    ] as const
                  ).map(([s, rotulo, motivo]) => (
                    <Button
                      key={s}
                      size="sm"
                      variant="outline"
                      disabled={salvar.isPending}
                      onClick={() =>
                        salvar.mutate({ empresa, data: p.data, status: s, motivo, origem: 'manual', contexto: 'pendencia' })
                      }
                    >
                      {rotulo}
                    </Button>
                  ))}
                </span>
              )}
              {podeEditar && p.tipo === 'fornecedor_sem_recesso' && p.fornecedor_nome && (
                <Button size="sm" variant="outline" onClick={() => onIncluirRecesso(p.fornecedor_nome as string)}>
                  Incluir período
                </Button>
              )}
            </li>
          ))}
        </ul>
      );
  }

  return (
    <Card data-testid="card-pendencias">
      <CardHeader>
        <CardTitle className="text-base">Pendências</CardTitle>
        <CardDescription>
          Emendas (urgentes a ≤ 90 dias), dias úteis sem NF, cobertura de 12 meses e recesso dos fornecedores.
          {empresa === 'COLACOR' && ' A detecção de dia sem NF só existe para a OBEN.'}
        </CardDescription>
      </CardHeader>
      <CardContent>{corpo}</CardContent>
    </Card>
  );
}

/* ─── fornecedores ─── */

function CartaoFornecedores({
  empresa,
  ano,
  podeEditar,
  habilitados,
  fechamentos,
  prefill,
}: {
  empresa: EmpresaCalendario;
  ano: number;
  podeEditar: boolean;
  habilitados: QueryDe<string[]>;
  fechamentos: QueryDe<{ data: string; fornecedor_nome: string; motivo: string | null }[]>;
  prefill: PrefillFornecedor | null;
}) {
  const incluir = useIncluirPeriodoFornecedor();
  const remover = useRemoverPeriodoFornecedor();
  const [fornecedor, setFornecedor] = useState('');
  const [de, setDe] = useState('');
  const [ate, setAte] = useState('');
  const [motivo, setMotivo] = useState('');
  // "Incluir período" da pendência preenche o formulário (sem efeito: compara o contador no render).
  const [prefillVisto, setPrefillVisto] = useState(0);
  if (prefill && prefill.n !== prefillVisto) {
    setPrefillVisto(prefill.n);
    setFornecedor(prefill.nome);
    setDe(prefill.de);
    setAte(prefill.ate);
    setMotivo('Recesso de fim de ano');
  }

  const estado = estadoDeLeitura(fatia(fechamentos));
  const estHab = estadoDeLeitura(fatia(habilitados));
  const periodos = useMemo(
    () =>
      fechamentos.data
        ? agruparPeriodos(fechamentos.data).filter((p) => p.de <= `${ano}-12-31` && p.ate >= `${ano}-01-01`)
        : null,
    [fechamentos.data, ano],
  );

  return (
    <Card id="cal-fornecedores">
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Truck className="h-4 w-4" /> Fornecedores — períodos fechados em {ano}
        </CardTitle>
        <CardDescription>Dias em que o fornecedor não fatura nem despacha. Afeta a data prevista de recebimento.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {podeEditar &&
          (naoConsegui(estHab) ? (
            <AvisoLeituraFalhou oque="os fornecedores habilitados (sem eles não dá para incluir período)" estado={estHab} testId="aviso-habilitados" />
          ) : (
            <form
              className="grid gap-2 sm:grid-cols-[minmax(0,2fr)_auto_auto_minmax(0,2fr)_auto] sm:items-end"
              onSubmit={(e) => {
                e.preventDefault();
                if (!fornecedor || !de || !ate) return;
                incluir.mutate(
                  { empresa, fornecedor_nome: fornecedor, de, ate, motivo: motivo || null },
                  { onSuccess: () => setMotivo('') },
                );
              }}
            >
              <div className="space-y-1">
                <Label htmlFor="forn-nome">Fornecedor</Label>
                <Select value={fornecedor} onValueChange={setFornecedor} disabled={!habilitados.data}>
                  <SelectTrigger id="forn-nome">
                    <SelectValue placeholder="Fornecedor habilitado" />
                  </SelectTrigger>
                  <SelectContent>
                    {(habilitados.data ?? []).map((n) => (
                      <SelectItem key={n} value={n}>
                        {n}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="forn-de">De</Label>
                <Input id="forn-de" type="date" value={de} onChange={(e) => setDe(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="forn-ate">Até</Label>
                <Input id="forn-ate" type="date" value={ate} min={de || undefined} onChange={(e) => setAte(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="forn-motivo">Motivo</Label>
                <Input id="forn-motivo" value={motivo} onChange={(e) => setMotivo(e.target.value)} placeholder="Ex.: férias coletivas" />
              </div>
              <Button type="submit" disabled={incluir.isPending || !fornecedor || !de || !ate || ate < de}>
                Incluir
              </Button>
            </form>
          ))}

        {naoConsegui(estado) ? (
          <AvisoLeituraFalhou oque="os períodos dos fornecedores" estado={estado} variante="bloco" testId="aviso-fornecedores" />
        ) : !periodos ? (
          <PageSkeleton variant="list" />
        ) : periodos.length === 0 ? (
          <EmptyState
            tone="operational"
            icon={Truck}
            title={`Nenhum período fechado em ${ano}`}
            description="Nenhum fornecedor desta empresa tem dia fechado cadastrado neste ano."
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Fornecedor</TableHead>
                <TableHead>Período</TableHead>
                <TableHead className="text-right">Dias</TableHead>
                <TableHead>Motivo</TableHead>
                {podeEditar && <TableHead className="text-right">Ações</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {periodos.map((p) => (
                <TableRow key={`${p.fornecedor_nome}:${p.de}`}>
                  <TableCell className="font-medium">{p.fornecedor_nome}</TableCell>
                  <TableCell className="tabular-nums whitespace-nowrap">
                    {fmtBr(p.de)}
                    {p.ate !== p.de && ` – ${fmtBr(p.ate)}`}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">{p.dias}</TableCell>
                  <TableCell className="text-muted-foreground">{p.motivo ?? '—'}</TableCell>
                  {podeEditar && (
                    <TableCell className="text-right">
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label={`Remover período de ${p.fornecedor_nome}`}
                        disabled={remover.isPending}
                        onClick={() => remover.mutate({ empresa, fornecedor_nome: p.fornecedor_nome, de: p.de, ate: p.ate })}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

/* ─── antecipar ─── */

const fmtCobertura = (n: number) => Number(n).toLocaleString('pt-BR', { maximumFractionDigits: 1 });

function textoResumo(r: ResumoAntecipar): string {
  return (
    `${r.listados} listado(s) de ${r.avaliados} avaliado(s); ${r.sem_dado} sem dados suficientes ` +
    '(sem demanda, LT, estoque ou chegada, ou SKU de grupo de embalagem).'
  );
}

function CartaoAntecipar({
  diasEmpresa,
  recesso,
  antecipar,
  resumo,
}: {
  diasEmpresa: FatiaDeQuery & { data: unknown };
  recesso: string | null;
  antecipar: QueryDe<
    { sku_codigo_omie: number; sku_descricao: string; fornecedor_nome: string; cobertura_dias: number; dias_ate_chegada_pos_recesso: number }[]
  >;
  resumo: QueryDe<ResumoAntecipar>;
}) {
  const estDias = estadoDeLeitura(fatia(diasEmpresa));
  const est = estadoDeLeitura(fatia(antecipar));
  const estRes = estadoDeLeitura(fatia(resumo));
  // Linha de contagem: sempre explícita — sem o resumo, diz que não conseguiu contar (nunca omite).
  const linhaResumo = naoConsegui(estRes) ? (
    <AvisoLeituraFalhou oque="a contagem de itens avaliados" estado={estRes} testId="aviso-antecipar-resumo" />
  ) : resumo.data ? (
    <p className="text-xs text-muted-foreground" data-testid="resumo-antecipar">
      {textoResumo(resumo.data)}
    </p>
  ) : null;
  let corpo: ReactNode;
  if (naoConsegui(estDias)) {
    corpo = <AvisoLeituraFalhou oque="o recesso da empresa (sem ele não dá para listar o que antecipar)" estado={estDias} testId="aviso-recesso" />;
  } else if (!diasEmpresa.data) {
    corpo = <PageSkeleton variant="list" />;
  } else if (recesso === null) {
    corpo = (
      <EmptyState
        tone="operational"
        icon={PackageSearch}
        title="Sem recesso cadastrado"
        description="Não há dia fechado entre 15/12 e 15/01 para esta empresa — não há o que antecipar."
      />
    );
  } else if (naoConsegui(est)) {
    corpo = <AvisoLeituraFalhou oque="os itens a antecipar" estado={est} variante="bloco" testId="aviso-antecipar" />;
  } else if (!antecipar.data) {
    corpo = <PageSkeleton variant="list" />;
  } else if (antecipar.data.length === 0) {
    // Lista vazia só é "nada a antecipar" com a contagem em mãos e ZERO sem dado: senão é "não sei", não "nada".
    if (naoConsegui(estRes)) {
      corpo = linhaResumo;
    } else if (!resumo.data) {
      corpo = <PageSkeleton variant="list" />;
    } else if (resumo.data.sem_dado > 0) {
      corpo = (
        <EmptyState
          tone="operational"
          icon={PackageSearch}
          title="Nenhum item listado — mas há itens sem dados"
          description={textoResumo(resumo.data)}
        />
      );
    } else {
      corpo = (
        <EmptyState
          tone="operational"
          icon={PackageSearch}
          title="Nada a antecipar"
          description={`Nenhum item ativo acaba antes da primeira chegada possível depois do recesso. ${textoResumo(resumo.data)}`}
        />
      );
    }
  } else {
    corpo = (
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>SKU</TableHead>
            <TableHead>Fornecedor</TableHead>
            <TableHead className="text-right">Cobertura (dias)</TableHead>
            <TableHead className="text-right">Chegada pós-recesso (dias)</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {antecipar.data.map((i) => (
            <TableRow key={`${i.sku_codigo_omie}:${i.fornecedor_nome}`}>
              <TableCell>
                <div className="font-medium">{i.sku_descricao}</div>
                <div className="text-xs text-muted-foreground tabular-nums">{i.sku_codigo_omie}</div>
              </TableCell>
              <TableCell>{i.fornecedor_nome}</TableCell>
              <TableCell className={cn('text-right tabular-nums', i.cobertura_dias < 0 && 'text-status-error')}>
                {fmtCobertura(i.cobertura_dias)}
              </TableCell>
              <TableCell className="text-right tabular-nums">{i.dias_ate_chegada_pos_recesso}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    );
    corpo = (
      <div className="space-y-2">
        {linhaResumo}
        {corpo}
      </div>
    );
  }
  return (
    <Card data-testid="card-antecipar">
      <CardHeader>
        <CardTitle className="text-base">Antecipar antes do recesso</CardTitle>
        <CardDescription>
          {recesso ? `Recesso até ${fmtBr(recesso)}. ` : ''}Itens cuja cobertura acaba antes da primeira chegada possível
          depois do recesso. Lista informativa: o motor de reposição não muda por causa dela. Cobertura negativa = estoque
          físico já negativo.
        </CardDescription>
      </CardHeader>
      <CardContent>{corpo}</CardContent>
    </Card>
  );
}
