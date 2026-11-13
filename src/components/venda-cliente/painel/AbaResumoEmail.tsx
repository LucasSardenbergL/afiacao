import { AlertTriangle, Mail } from 'lucide-react';
import { EmptyState } from '@/components/EmptyState';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useVendaResumoPainel } from '@/hooks/useVendaPainel';
import { cn } from '@/lib/utils';
import { formatarPct } from '@/lib/venda-cliente/painel';
import {
  ROTULO_STATUS,
  type BracoEfeito,
  type DiaResumo,
  type ResumoPainel,
} from '@/lib/venda-cliente/resumo-painel';

const TOM: Record<'info' | 'warning' | 'success' | 'error', string> = {
  info: 'text-status-info',
  warning: 'text-status-warning',
  success: 'text-status-success',
  error: 'text-status-error',
};

const dataBr = (iso: string) => iso.slice(8, 10) + '/' + iso.slice(5, 7);
const hora = (iso: string | null) =>
  iso ? new Date(iso).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' }) : '—';
const pctOuTraco = (v: number | null) => (v === null ? '—' : formatarPct(v));

function StatusEnvio({ s }: { s: string | null }) {
  if (s === 'notificado') return <span className="text-status-success">aceito</span>;
  if (s === 'falha_notificacao') return <span className="text-status-error">falhou</span>;
  if (s === 'pendente_notificacao') return <span className="text-status-warning">na fila</span>;
  return <span className="text-muted-foreground">{s ?? 'sem alerta'}</span>;
}

function LinhaBraco({ nome, b }: { nome: string; b: BracoEfeito | null }) {
  if (!b) {
    return (
      <TableRow>
        <TableCell>{nome}</TableCell>
        <TableCell colSpan={5} className="text-muted-foreground">ninguém selecionado ainda</TableCell>
      </TableRow>
    );
  }
  return (
    <TableRow>
      <TableCell>{nome}</TableCell>
      <TableCell className="tabular-nums">{b.compradores}</TableCell>
      <TableCell className="tabular-nums">{b.maduros}</TableCell>
      <TableCell className="tabular-nums">{b.converteram}</TableCell>
      <TableCell className="tabular-nums">{b.nao_medivel}</TableCell>
      <TableCell className="tabular-nums">{pctOuTraco(b.taxa)}</TableCell>
    </TableRow>
  );
}

function Ritual({ dias }: { dias: DiaResumo[] }) {
  if (dias.length === 0) {
    return <p className="text-sm text-muted-foreground">Nenhum resumo enviado no período.</p>;
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Dia</TableHead>
          <TableHead>Farmer</TableHead>
          <TableHead>E-mail</TableHead>
          <TableHead>Abriu</TableHead>
          <TableHead className="text-right">Entregues</TableHead>
          <TableHead className="text-right">Clicadas</TableHead>
          <TableHead className="text-right">Tentativas</TableHead>
          <TableHead className="text-right">Ofertadas</TableHead>
          <TableHead>Acesso</TableHead>
          <TableHead>Sua cópia</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {dias.map((d) => (
          <TableRow key={`${d.dia}-${d.farmer_user_id}`}>
            <TableCell className="tabular-nums">{dataBr(d.dia)}</TableCell>
            <TableCell>{d.nome}</TableCell>
            <TableCell>
              <StatusEnvio s={d.envio_status} /> <span className="text-xs text-muted-foreground">{hora(d.enviado_em)}</span>
              {d.tentativa > 1 && <span className="ml-1 text-xs text-muted-foreground">(tentativa {d.tentativa})</span>}
            </TableCell>
            <TableCell className="text-xs text-muted-foreground">{d.aberto_em ? hora(d.aberto_em) : 'não sei'}</TableCell>
            <TableCell className="text-right tabular-nums">{d.entregues}</TableCell>
            <TableCell className="text-right tabular-nums">{d.clicadas}</TableCell>
            <TableCell className="text-right tabular-nums">{d.tentativas}</TableCell>
            <TableCell className="text-right tabular-nums">{d.ofertadas}</TableCell>
            <TableCell>
              {d.acesso_validado ? (
                <span className="text-status-success">validado</span>
              ) : (
                <span className="text-muted-foreground">não</span>
              )}
            </TableCell>
            <TableCell><StatusEnvio s={d.copia_status} /></TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function ConteudoResumoEmail({ r }: { r: ResumoPainel }) {
  const ef = r.efeito;
  return (
    <div className="space-y-5">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Critério do canal — ofertadas ÷ oportunidades entregues</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted-foreground">
            Oferta = contato registrado na ficha com o cliente atendendo (vendeu, vai pedir ou sem interesse), depois do
            e-mail e até o próximo dia útil. “Não atendeu” conta como tentativa, não como oferta. Abertura do e-mail não é
            uso. Desligar se, após 10 dias úteis com e-mail, menos de 50% das oportunidades forem ofertadas.
          </p>
          {r.farmers.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nenhuma farmer configurada para o resumo.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Farmer</TableHead>
                  <TableHead>Situação</TableHead>
                  <TableHead className="text-right">Dias com e-mail</TableHead>
                  <TableHead className="text-right">Dias com acesso</TableHead>
                  <TableHead className="text-right">Entregues</TableHead>
                  <TableHead className="text-right">Clicadas</TableHead>
                  <TableHead className="text-right">Tentativas</TableHead>
                  <TableHead className="text-right">Ofertadas</TableHead>
                  <TableHead className="text-right">Taxa</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {r.farmers.map((f) => {
                  const st = ROTULO_STATUS[f.status];
                  return (
                    <TableRow key={f.farmer_user_id}>
                      <TableCell>{f.nome}</TableCell>
                      <TableCell className={cn('text-sm', TOM[st.tom])}>{st.rotulo}</TableCell>
                      <TableCell className="text-right tabular-nums">{f.dias_com_envio}</TableCell>
                      <TableCell className="text-right tabular-nums">{f.dias_acesso_validado}</TableCell>
                      <TableCell className="text-right tabular-nums">{f.entregues}</TableCell>
                      <TableCell className="text-right tabular-nums">{f.clicadas}</TableCell>
                      <TableCell className="text-right tabular-nums">{f.tentativas}</TableCell>
                      <TableCell className="text-right tabular-nums">{f.ofertadas}</TableCell>
                      <TableCell className="text-right tabular-nums">{pctOuTraco(f.taxa_ofertada)}</TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Ritual diário — o resumo de cada dia</CardTitle>
        </CardHeader>
        <CardContent>
          <Ritual dias={r.dias} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2 text-base">
            Efeito — tratamento × controle
            {r.sorteio && (
              <Badge variant="outline" className="font-normal">
                controle {r.sorteio.controle} de {r.sorteio.compradores} compradores · início {dataBr(r.sorteio.inicio)}
              </Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {!r.sorteio ? (
            <p className="text-sm text-status-warning">Sorteio não encontrado — não consigo comparar braços.</p>
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Braço</TableHead>
                    <TableHead>Compradores</TableHead>
                    <TableHead>Maduros (14 d)</TableHead>
                    <TableHead>Compraram</TableHead>
                    <TableHead>Não medível</TableHead>
                    <TableHead>Taxa</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <LinhaBraco nome="Tratamento (recebeu o e-mail)" b={ef.tratamento} />
                  <LinhaBraco nome="Controle (seria enviado)" b={ef.controle} />
                </TableBody>
              </Table>
              <p className="text-sm tabular-nums">
                Diferença:{' '}
                {ef.diferenca === null ? (
                  <span className="text-muted-foreground">ainda não dá para medir (falta coorte madura nos dois braços)</span>
                ) : (
                  <>
                    {(ef.diferenca * 100).toFixed(1)} p.p.
                    {ef.ic95 && (
                      <span className="text-muted-foreground">
                        {' '}· IC95% {(ef.ic95[0] * 100).toFixed(1)} a {(ef.ic95[1] * 100).toFixed(1)} p.p.
                      </span>
                    )}
                  </>
                )}
              </p>
              <p className="text-xs text-muted-foreground">{ef.aviso}</p>
              <p className="text-xs text-muted-foreground">
                Diagnóstico do sorteio (A/A, histórico por linha, antes do e-mail): tratamento{' '}
                {pctOuTraco(r.aa_historico.tratamento?.taxa ?? null)} · controle{' '}
                {pctOuTraco(r.aa_historico.controle?.taxa ?? null)} — deviam ser parecidos.
              </p>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/** Aba do painel do founder: o resumo diário por e-mail (venda R2 · Entrega 1). */
export function AbaResumoEmail({ de, ate }: { de: string; ate: string }) {
  const q = useVendaResumoPainel(de, ate);
  if (q.isLoading) return <PageSkeleton variant="list" />;
  if (q.isError || !q.data) {
    return (
      <EmptyState
        icon={AlertTriangle}
        title="Não consegui carregar o resumo por e-mail"
        description={`Erro ao ler venda_resumo_painel: ${(q.error as { message?: string } | null)?.message ?? 'sem detalhe'}. Isto não é "zero oferta".`}
        actionLabel="Tentar de novo"
        onAction={() => void q.refetch()}
      />
    );
  }
  if (q.data.farmers.length === 0 && q.data.dias.length === 0) {
    return (
      <EmptyState
        icon={Mail}
        tone="operational"
        title="Resumo por e-mail ainda sem envio"
        description="O primeiro resumo sai no primeiro dia útil depois do sorteio, às 7h."
      />
    );
  }
  return <ConteudoResumoEmail r={q.data} />;
}
