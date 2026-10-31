// "Segurar compra" (Oben) — a ação que a etiqueta `segurar_compra` da aba Ciclo prometia e não escrevia.
// Registro em reposicao_compra_suspensa (autor, motivo, data de revisão); o motor segura a linha e loga a compra
// evitada. Aqui: diálogo de suspensão (1 SKU ou o lote "≥180d"), painel das ativas com reativação em 1 clique e
// o sensor com denominador (runs do motor). Spec: docs/superpowers/specs/2026-10-31-reposicao-compra-suspensa-design.md §5.
import { useEffect, useMemo, useState } from 'react';
import { PauseCircle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { EmptyState } from '@/components/EmptyState';
import type { Company } from '@/contexts/CompanyContext';
import { decodeHtmlEntities } from '@/lib/format';
import {
  OPCOES_REVISAO_DIAS, RISCO_FALTA_DIAS, emRiscoDeFalta, ordenarPorRisco, resumirCandidatos, resumirSuspensas, somarDias,
  type Candidato, type RevisaoDias, type SuspensaAtiva,
} from '@/lib/financeiro/compra-suspensa-helpers';
import { hojeSp, } from '@/hooks/useFinanceiroCiclo';
import {
  useCompraSuspensaCandidatos, useCompraSuspensaListar, useCompraSuspensaMutacoes, useCompraSuspensaRuns,
} from '@/hooks/useFinanceiroCompraSuspensa';
import { brl, dias } from './ciclo-format';

const LIMIAR_LOTE_DIAS = 180;
const dataBr = (ymd: string) => { const [y, m, d] = ymd.split('-'); return `${d}/${m}/${y}`; };
const nome = (d: string | null, sku: number) => (d ? decodeHtmlEntities(d) : `#${sku}`);

/** Alvo do diálogo: 1 SKU (da tabela de giro) ou o lote de candidatos recalculado pelo banco. */
export type AlvoSuspensao = { tipo: 'sku'; sku: number; descricao: string | null } | { tipo: 'lote'; minDias: number };

export function SegurarCompraDialog({ company, alvo, onClose }: { company: Company; alvo: AlvoSuspensao | null; onClose: () => void }) {
  const [motivo, setMotivo] = useState('');
  const [revisao, setRevisao] = useState<RevisaoDias>(90);
  const { suspender } = useCompraSuspensaMutacoes(company);
  const lote = useCompraSuspensaCandidatos(company, alvo?.tipo === 'lote' ? alvo.minDias : LIMIAR_LOTE_DIAS, alvo?.tipo === 'lote');
  // Lote só com leitura FRESCA e sem erro: o React Query mantém o cache anterior quando o refetch falha
  // (ex.: FONTE_CONSUMO_INDISPONIVEL) e o botão suspenderia uma coorte velha (Codex código P1-2).
  const loteFresco = alvo?.tipo === 'lote' && lote.isSuccess && !lote.isFetching && !lote.isError;
  const candidatos: Candidato[] = loteFresco ? (lote.data ?? []) : [];
  // Troca de alvo zera motivo/revisão: a justificativa digitada para um SKU nunca vaza para outro (Codex P2-7).
  useEffect(() => { setMotivo(''); setRevisao(90); }, [alvo]);
  const resumo = resumirCandidatos(candidatos);
  const hoje = hojeSp();
  const revisarEm = somarDias(hoje, revisao);
  const skus = alvo?.tipo === 'sku' ? [alvo.sku] : candidatos.map((c) => c.sku);
  const podeConfirmar = motivo.trim().length >= 3 && skus.length > 0 && !suspender.isPending && (alvo?.tipo === 'sku' || loteFresco);

  const confirmar = () => {
    if (!alvo) return;
    suspender.mutate(
      { skus, motivo: motivo.trim(), revisarEm, origem: alvo.tipo === 'lote' ? 'lote_cobertura' : 'ciclo_ui' },
      { onSuccess: () => { setMotivo(''); onClose(); } },
    );
  };

  return (
    <Dialog open={alvo !== null} onOpenChange={(o) => { if (!o && !suspender.isPending) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Segurar compra</DialogTitle>
          <DialogDescription>
            {alvo?.tipo === 'sku'
              ? <>O motor deixa de sugerir <span className="font-mono">{nome(alvo.descricao, alvo.sku)}</span> até você reativar. Vale no próximo recálculo (até 2h).</>
              : <>Suspende a recompra de todos os SKUs de giro com cobertura ≥ {alvo?.minDias ?? LIMIAR_LOTE_DIAS} dias nas DUAS janelas (365d e 90d), fora corante e substituído. Lista recalculada agora pelo banco.</>}
          </DialogDescription>
        </DialogHeader>
        {alvo?.tipo === 'lote' && (
          <div className="rounded-md border p-2 text-xs" data-testid="lote-resumo">
            {lote.isFetching && <span>Calculando a coorte…</span>}
            {lote.error && <span className="text-status-error">Não foi possível calcular a coorte: fonte de consumo indisponível ou sem acesso.</span>}
            {loteFresco && (
              <>
                <div><strong>{resumo.n}</strong> SKUs · {brl(resumo.valor)} em estoque{resumo.semCusto > 0 ? ` (+${resumo.semCusto} sem custo)` : ''} · {resumo.noMotorN} no motor automático · {resumo.comVenda90N} venderam em 90d</div>
                {resumo.n > 0 && (
                  <details className="mt-1"><summary className="cursor-pointer">ver lista</summary>
                    <ul className="mt-1 max-h-40 overflow-auto font-mono">
                      {candidatos.map((c) => <li key={c.sku}>{c.sku} · {nome(c.descricao, c.sku)} · {brl(c.valor)} · {dias(c.dias365)} / {dias(c.dias90)}{c.noMotor ? '' : ' · fora do motor'}</li>)}
                    </ul>
                  </details>
                )}
              </>
            )}
          </div>
        )}
        <div className="space-y-2">
          <Label htmlFor="segurar-motivo">Motivo</Label>
          <Textarea id="segurar-motivo" value={motivo} onChange={(e) => setMotivo(e.target.value)} placeholder="ex.: cobertura de 200 dias; aguardar giro antes de recomprar" rows={2} />
          <Label htmlFor="segurar-revisao">Revisar em</Label>
          <Select value={String(revisao)} onValueChange={(v) => setRevisao(Number(v) as RevisaoDias)}>
            <SelectTrigger id="segurar-revisao" className="w-56" aria-label="Revisar em"><SelectValue /></SelectTrigger>
            <SelectContent>{OPCOES_REVISAO_DIAS.map((d) => <SelectItem key={d} value={String(d)}>{d} dias ({dataBr(somarDias(hoje, d))})</SelectItem>)}</SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">A suspensão NÃO vence sozinha: a data é de revisão. Reativar é 1 clique no painel.</p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={suspender.isPending}>Cancelar</Button>
          <Button onClick={confirmar} disabled={!podeConfirmar}>
            {alvo?.tipo === 'lote' ? `Segurar ${skus.length} SKU(s)` : 'Segurar compra'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Célula "Compra" da tabela de giro: estado + ação de 1 clique. */
export function CompraCell({ company, sku, descricao, suspensa, indisponivel, onSegurar }: {
  company: Company; sku: number; descricao: string | null; suspensa: SuspensaAtiva | undefined; indisponivel: boolean;
  onSegurar: (a: AlvoSuspensao) => void;
}) {
  const { reativar } = useCompraSuspensaMutacoes(company);
  // Sem a lista de ativas não dá para afirmar "livre": mostra "—" (ausente ≠ zero; Codex P2-4).
  if (indisponivel) return <span className="text-xs text-muted-foreground" title="leitura das suspensões indisponível">—</span>;
  if (suspensa) {
    return (
      <div className="flex items-center gap-1 text-xs">
        <Badge variant="outline" className="text-status-warning" title={`${suspensa.motivo} · por ${suspensa.suspensoPorTexto ?? 'usuário'} em ${dataBr(suspensa.suspensoEm.slice(0, 10))}`}>
          suspensa · revisar {dataBr(suspensa.revisarEm)}
        </Badge>
        <Button size="sm" variant="ghost" disabled={reativar.isPending} onClick={() => reativar.mutate({ skus: [sku], motivo: null })}>Reativar</Button>
      </div>
    );
  }
  return <Button size="sm" variant="ghost" onClick={() => onSegurar({ tipo: 'sku', sku, descricao })}>Segurar compra</Button>;
}

export function CompraSuspensaPainel({ company, onSegurarLote }: { company: Company; onSegurarLote: (a: AlvoSuspensao) => void }) {
  const ativas = useCompraSuspensaListar(company);
  const runs = useCompraSuspensaRuns(company, 30);
  const { reativar } = useCompraSuspensaMutacoes(company);
  const [todas, setTodas] = useState(false);
  const hoje = hojeSp();
  const lista = useMemo(() => ordenarPorRisco(ativas.data ?? []), [ativas.data]);
  const r = resumirSuspensas(ativas.data ?? [], runs.data ?? [], hoje);
  const visiveis = todas ? lista : lista.slice(0, 20);
  // Leitura falhou → "—", nunca 0 nem "Nenhuma": ausente ≠ zero (Codex P2-4).
  const semAtivas = ativas.isError;
  const semRuns = runs.isError;

  return (
    <section className="space-y-2 rounded-md border p-3" data-testid={`compra-suspensa-${company}`} aria-label="Compras suspensas">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-medium">Compras suspensas</h4>
        <Button size="sm" variant="outline" onClick={() => onSegurarLote({ tipo: 'lote', minDias: LIMIAR_LOTE_DIAS })}>
          Segurar compra de todos ≥ {LIMIAR_LOTE_DIAS}d…
        </Button>
      </div>
      {ativas.error && <p className="text-xs text-status-error">Não foi possível ler as suspensões (sem acesso a compras ou erro de leitura).</p>}
      <div className="grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
        <div><div className="text-xs text-muted-foreground">Ativas</div>
          <div className="font-mono">{semAtivas ? '—' : <>{r.ativasN} <span className="text-xs text-muted-foreground">({r.noMotorN} no motor)</span></>}</div></div>
        <div><div className="text-xs text-muted-foreground">Estoque hoje nos suspensos</div><div className="font-mono">{semAtivas ? '—' : brl(r.valorAtual)}</div>
          {!semAtivas && r.valorAtualSemCusto > 0 && <div className="text-xs text-muted-foreground">{r.valorAtualSemCusto} sem custo fora da soma</div>}</div>
        <div><div className="text-xs text-muted-foreground">Último recálculo do motor</div>
          <div className="font-mono">{semRuns ? '—' : r.ultimoRun ? `${brl(r.ultimoRun.evitado)} em ${r.ultimoRun.seguradasN} linha(s)` : '—'}</div>
          {!semRuns && r.ultimoRun && r.ultimoRun.semPreco > 0 && <div className="text-xs text-muted-foreground">parcial: {r.ultimoRun.semPreco} linha(s) sem preço</div>}
          {semRuns && <div className="text-xs text-status-error">runs indisponíveis</div>}</div>
        <div><div className="text-xs text-muted-foreground">Runs em 30d (com supressão)</div>
          <div className="font-mono">{semRuns ? '—' : <>{r.runsN} <span className="text-xs text-muted-foreground">({r.runsComSupressaoN})</span></>}</div>
          {!semRuns && <div className="text-xs text-muted-foreground">Σ sugestão suprimida {brl(r.evitadoRunsSoma)} (R$·run, não caixa){r.runsLinhasSemPreco > 0 ? ` · parcial: ${r.runsLinhasSemPreco} linha(s) sem preço no período` : ''}</div>}</div>
      </div>
      {r.revisaoVencidaN > 0 && <p className="text-xs text-status-warning">{r.revisaoVencidaN} suspensão(ões) com revisão vencida — reveja ou reative.</p>}
      <p className="text-xs text-muted-foreground">
        Ordem = venda dos últimos 90d (quem mais vende primeiro): é a lista para reativar rápido se faltar. Cobertura &lt; {RISCO_FALTA_DIAS}d pela venda recente marca risco de falta — sinal provisório, não é fill-rate (sensor de ruptura em outra frente).
      </p>
      {ativas.isLoading ? <p className="text-xs text-muted-foreground">Carregando…</p>
        : semAtivas ? null
        : lista.length === 0 ? <EmptyState tone="operational" icon={PauseCircle} title="Nenhuma compra suspensa" description="Use “Segurar compra” na tabela ou o lote ≥180d." />
        : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>SKU</TableHead><TableHead className="text-right">Venda 90d (foto)</TableHead>
                  <TableHead className="text-right">Estoque hoje</TableHead><TableHead className="text-right">Cobertura 90d</TableHead>
                  <TableHead className="text-right">Evitado (último run)</TableHead><TableHead>Revisar</TableHead><TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {visiveis.map((a) => (
                  <TableRow key={a.id} data-testid={`suspensa-${a.sku}`}>
                    <TableCell className="text-xs"><span className="font-mono">{a.sku}</span> {nome(a.descricao, a.sku)}
                      {a.noMotorAtual === false && <Badge variant="outline" className="ml-1">fora do motor</Badge>}
                      {emRiscoDeFalta(a) && <Badge variant="outline" className="ml-1 text-status-error">risco de falta</Badge>}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs">{brl(a.fotoVenda90)}</TableCell>
                    <TableCell className="text-right font-mono text-xs">{brl(a.valorAtual)}</TableCell>
                    <TableCell className="text-right font-mono text-xs">{dias(a.cobertura90Atual)}</TableCell>
                    <TableCell className="text-right font-mono text-xs">{a.qtdeUltimoRun === null ? '—' : `${brl(a.evitadoUltimoRun)} (${a.qtdeUltimoRun} un)`}</TableCell>
                    <TableCell className={`text-xs ${a.revisarEm < hoje ? 'text-status-warning' : ''}`} title={a.motivo}>{dataBr(a.revisarEm)}</TableCell>
                    <TableCell><Button size="sm" variant="ghost" disabled={reativar.isPending} onClick={() => reativar.mutate({ skus: [a.sku], motivo: null })}>Reativar</Button></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {lista.length > 20 && <Button variant="ghost" size="sm" onClick={() => setTodas((v) => !v)}>{todas ? 'Mostrar só as 20 primeiras' : `Ver todas as ${lista.length}`}</Button>}
          </>
        )}
    </section>
  );
}
