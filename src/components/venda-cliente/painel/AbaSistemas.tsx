import { AlertTriangle, Check, HelpCircle, Layers, X } from 'lucide-react';
import { toast } from 'sonner';
import { EmptyState } from '@/components/EmptyState';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useUrlState } from '@/hooks/useUrlState';
import { useDecidirPar, useVendaSistemaFila, useVendaSistemaSensor } from '@/hooks/useVendaSistemas';
import { cn } from '@/lib/utils';
import { formatarPct, formatarReais } from '@/lib/venda-cliente/painel';
import {
  EMPRESAS_SISTEMA, ROTULO_BOLETIM, totalPedidos,
  type BoletimPar, type CandidatoPar, type DecisaoPar, type EmpresaSistema, type ParDecidido, type SensorSistemas,
} from '@/lib/venda-cliente/sistemas';

const pctOuTraco = (v: number | null) => (v === null ? '—' : formatarPct(v));
const ROTULO_BRACO: Record<string, string> = { tratamento: 'Tratamento', controle: 'Controle', sem_braco: 'Fora do sorteio' };

function SeloBoletim({ b }: { b: BoletimPar | null }) {
  if (!b) return <span className="text-xs text-muted-foreground">sem boletim</span>;
  const tom = b.situacao === 'confere' ? 'text-status-success' : b.situacao === 'outro' ? 'text-status-warning' : 'text-muted-foreground';
  return (
    <span className={cn('text-xs', tom)} title={b.boletim ?? undefined}>
      {ROTULO_BOLETIM[b.situacao]}
      {b.situacao === 'outro' && b.codigoCitado ? ` (${b.codigoCitado})` : ''}
      {b.proporcaoPct !== null ? ` · ${b.proporcaoPct}%` : ''}
    </span>
  );
}

function BotoesDecisao({ id, atual, pendente, onDecidir }: {
  id: number; atual: string; pendente: boolean; onDecidir: (id: number, s: DecisaoPar) => void;
}) {
  return (
    <div className="flex justify-end gap-1">
      <Button size="sm" variant={atual === 'confirmado' ? 'default' : 'outline'} disabled={pendente || atual === 'confirmado'}
        onClick={() => onDecidir(id, 'confirmado')} aria-label="Confirmar par">
        <Check className="h-3.5 w-3.5" /> Confirmar
      </Button>
      <Button size="sm" variant="outline" disabled={pendente || atual === 'rejeitado'}
        onClick={() => onDecidir(id, 'rejeitado')} aria-label="Rejeitar par">
        <X className="h-3.5 w-3.5" /> Rejeitar
      </Button>
      {atual !== 'confirmado' && atual !== 'rejeitado' && (
        <Button size="sm" variant="ghost" disabled={pendente || atual === 'nao_sei'}
          onClick={() => onDecidir(id, 'nao_sei')} aria-label="Não sei">
          <HelpCircle className="h-3.5 w-3.5" /> Não sei
        </Button>
      )}
    </div>
  );
}

function Sensor({ s }: { s: SensorSistemas }) {
  const tot = totalPedidos(s.pedidos);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Sensor — confirmados ÷ mostrados e sistemas completos ÷ pedidos elegíveis</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <div className="flex flex-wrap gap-6">
          {s.fila.length === 0 ? (
            <p className="text-muted-foreground">Nenhum candidato mostrado ainda.</p>
          ) : s.fila.map((f) => (
            <div key={f.empresa}>
              <p className="text-xs uppercase tracking-wider text-muted-foreground">{f.empresa}</p>
              <p className="tabular-nums">
                <span className="text-lg font-medium">{pctOuTraco(f.taxaConfirmacao)}</span>{' '}
                <span className="text-muted-foreground">({f.confirmados} de {f.mostrados} · {f.rejeitados} rejeitados · {f.naoSei} não sei)</span>
              </p>
            </div>
          ))}
          <div>
            <p className="text-xs uppercase tracking-wider text-muted-foreground">Sistema completo no pedido</p>
            <p className="tabular-nums">
              <span className="text-lg font-medium">{pctOuTraco(tot.taxa)}</span>{' '}
              <span className="text-muted-foreground">({tot.completos} de {tot.elegiveis} pedidos com a base)</span>
            </p>
          </div>
        </div>
        {(s.pedidos.length > 0 || s.sugestoes.length > 0) && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Braço</TableHead>
                <TableHead className="text-right">Pedidos elegíveis</TableHead>
                <TableHead className="text-right">Completos</TableHead>
                <TableHead className="text-right">Sugestões</TableHead>
                <TableHead className="text-right">Mostradas</TableHead>
                <TableHead className="text-right">Viraram</TableHead>
                <TableHead className="text-right">Não viraram</TableHead>
                <TableHead className="text-right">Taxa</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {Array.from(new Set([...s.pedidos.map((p) => p.braco), ...s.sugestoes.map((x) => x.braco)])).sort().map((b) => {
                const p = s.pedidos.find((x) => x.braco === b);
                const g = s.sugestoes.find((x) => x.braco === b);
                return (
                  <TableRow key={b}>
                    <TableCell>{ROTULO_BRACO[b] ?? b}</TableCell>
                    <TableCell className="text-right tabular-nums">{p?.elegiveis ?? '—'}</TableCell>
                    <TableCell className="text-right tabular-nums">{p ? `${p.completos} (${pctOuTraco(p.taxa)})` : '—'}</TableCell>
                    <TableCell className="text-right tabular-nums">{g?.geradas ?? '—'}</TableCell>
                    <TableCell className="text-right tabular-nums">{g?.mostradas ?? '—'}</TableCell>
                    <TableCell className="text-right tabular-nums">{g?.viraram ?? '—'}</TableCell>
                    <TableCell className="text-right tabular-nums">{g?.naoVirou ?? '—'}</TableCell>
                    <TableCell className="text-right tabular-nums">{g ? pctOuTraco(g.taxa) : '—'}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
        <p className="text-xs text-muted-foreground">
          Pedido elegível = pedido com a tinta/verniz de um par confirmado hoje; completo = o mesmo pedido levou um par
          confirmado daquele sistema. Sugestões são medidas nos dois braços (o controle nunca vê): a diferença entre eles
          é o efeito. Rejeitar um par tira as sugestões dele do ar na hora.
        </p>
      </CardContent>
    </Card>
  );
}

function TabelaCandidatos({ itens, pendente, onDecidir }: {
  itens: CandidatoPar[]; pendente: boolean; onDecidir: (id: number, s: DecisaoPar) => void;
}) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Tinta / verniz</TableHead>
          <TableHead>Par candidato</TableHead>
          <TableHead className="text-right">Juntos no pedido</TableHead>
          <TableHead>Boletim</TableHead>
          <TableHead className="text-right">Decisão</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {itens.map((c) => (
          <TableRow key={c.id} data-testid={`candidato-${c.id}`}>
            <TableCell>
              <p className="text-sm">{c.base.descricao ?? `SKU ${c.base.omieCodigoProduto}`}</p>
              <p className="text-xs text-muted-foreground tabular-nums">
                {c.base.pedidos12m} pedidos · {formatarReais(c.base.valor12m)} em 12m
              </p>
            </TableCell>
            <TableCell>
              <p className="text-sm">{c.par.descricao ?? `SKU ${c.par.omieCodigoProduto}`}</p>
              <p className="text-xs text-muted-foreground">
                {c.papel}{c.status === 'nao_sei' && <Badge variant="outline" className="ml-1.5">não sei</Badge>}
              </p>
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {c.juntos} <span className="text-xs text-muted-foreground">({formatarPct(c.share)})</span>
            </TableCell>
            <TableCell><SeloBoletim b={c.boletim} /></TableCell>
            <TableCell><BotoesDecisao id={c.id} atual={c.status} pendente={pendente} onDecidir={onDecidir} /></TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function TabelaDecididos({ itens, pendente, onDecidir }: {
  itens: ParDecidido[]; pendente: boolean; onDecidir: (id: number, s: DecisaoPar) => void;
}) {
  if (itens.length === 0) return <p className="text-sm text-muted-foreground">Nenhum par decidido ainda.</p>;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Tinta / verniz</TableHead>
          <TableHead>Par</TableHead>
          <TableHead>Situação</TableHead>
          <TableHead className="text-right">Mudar</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {itens.map((d) => (
          <TableRow key={d.id} data-testid={`decidido-${d.id}`}>
            <TableCell className="text-sm">{d.base.descricao ?? `SKU ${d.base.omieCodigoProduto}`}</TableCell>
            <TableCell className="text-sm">
              {d.par.descricao ?? `SKU ${d.par.omieCodigoProduto}`} <span className="text-xs text-muted-foreground">({d.papel})</span>
            </TableCell>
            <TableCell>
              <span className={d.status === 'confirmado' ? 'text-status-success' : 'text-muted-foreground'}>{d.status}</span>
            </TableCell>
            <TableCell><BotoesDecisao id={d.id} atual={d.status} pendente={pendente} onDecidir={onDecidir} /></TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/**
 * Aba do founder (venda R2 · Entrega 4): confirmar pares tinta/verniz → catalisador/diluente. A coocorrência no pedido
 * só ORDENA os candidatos; só o par confirmado aqui vira "falta completar o sistema" na ficha e no e-mail das farmers.
 */
export function AbaSistemas({ de, ate }: { de: string; ate: string }) {
  const [url, setUrl] = useUrlState({ sempresa: 'oben' });
  const empresa: EmpresaSistema = (EMPRESAS_SISTEMA as readonly string[]).includes(url.sempresa)
    ? (url.sempresa as EmpresaSistema) : 'oben';
  const fila = useVendaSistemaFila(empresa);
  const sensor = useVendaSistemaSensor(de, ate);
  const decidir = useDecidirPar();

  const onDecidir = (parId: number, status: DecisaoPar) => {
    decidir.mutate({ parId, status }, {
      onSuccess: () => toast.success(status === 'confirmado' ? 'Par confirmado' : status === 'rejeitado' ? 'Par rejeitado — sai do ar agora' : 'Marcado como não sei'),
      onError: (e) => toast.error(`Não gravei a decisão: ${(e as { message?: string }).message ?? 'sem detalhe'}`),
    });
  };

  return (
    <div className="space-y-5">
      {sensor.isLoading ? <PageSkeleton variant="list" /> : sensor.isError || !sensor.data ? (
        <p className="text-sm text-status-warning">
          Não consegui ler o sensor (venda_sistema_sensor): {(sensor.error as { message?: string } | null)?.message ?? 'sem detalhe'}.
        </p>
      ) : <Sensor s={sensor.data} />}

      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Candidatos pela coocorrência no mesmo pedido (12 meses), na ordem do volume da tinta/verniz. Coocorrência não é
          compatibilidade: confirme só o que o sistema técnico pede.
        </p>
        <ToggleGroup type="single" value={empresa} onValueChange={(v) => { if (v) setUrl({ sempresa: v }); }}>
          {EMPRESAS_SISTEMA.map((e) => <ToggleGroupItem key={e} value={e} className="text-xs">{e}</ToggleGroupItem>)}
        </ToggleGroup>
      </div>

      {fila.isLoading ? <PageSkeleton variant="list" /> : fila.isError || !fila.data ? (
        <EmptyState
          icon={AlertTriangle}
          title="Não consegui carregar a fila de pares"
          description={`Erro ao ler venda_sistema_fila: ${(fila.error as { message?: string } | null)?.message ?? 'sem detalhe'}. Isto não é "fila vazia".`}
          actionLabel="Tentar de novo"
          onAction={() => void fila.refetch()}
        />
      ) : (
        <>
          <Card>
            <CardHeader><CardTitle className="text-base">Para confirmar ({fila.data.candidatos.length})</CardTitle></CardHeader>
            <CardContent>
              {fila.data.candidatos.length === 0 ? (
                <EmptyState icon={Layers} tone="operational" title="Nenhum candidato novo"
                  description="Todo par frequente desta empresa já foi decidido, ou não há coocorrência suficiente nos pedidos." />
              ) : <TabelaCandidatos itens={fila.data.candidatos} pendente={decidir.isPending} onDecidir={onDecidir} />}
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle className="text-base">Decididos</CardTitle></CardHeader>
            <CardContent>
              <TabelaDecididos itens={fila.data.decididos} pendente={decidir.isPending} onDecidir={onDecidir} />
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
