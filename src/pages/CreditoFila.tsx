// /credito/fila — fila 🟡 de crédito (crédito-IA PR 6a). Gestor/master lê; só o aprovador
// (allowlist = o Lucas) decide e liga/desliga o enforcement — o servidor recusa o resto.
// Enquanto o enforcement estiver DESLIGADO, a aba Sombra mostra o que a regra nova TERIA segurado.
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Clock, Inbox, ShieldAlert, ShieldCheck, Sparkles, XCircle } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useUrlState } from '@/hooks/useUrlState';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { PageSkeleton } from '@/components/ui/page-skeleton';
import { EmptyState } from '@/components/EmptyState';
import {
  brl,
  dias,
  discordaDaIa,
  EMPRESA_ROTULO,
  faceRecomendacao,
  horasNaFila,
  motivoValido,
  passouDoSla,
  rotuloCodigo,
  rotuloMotivo,
  usoPosPedido,
  type Empresa,
  type ItemFila,
} from '@/lib/credito/fila';
import {
  EMPRESAS,
  useDecidirFila,
  useDefinirEnforcement,
  useFilaCredito,
  useFlagsEnforcement,
  useProntidao,
  useSouAprovador,
} from '@/lib/credito/useFilaCredito';

function useNomesClientes(ids: string[]) {
  return useQuery({
    queryKey: ['credito', 'fila', 'nomes', ids],
    enabled: ids.length > 0,
    queryFn: async () => {
      const mapa = new Map<string, string>();
      for (let i = 0; i < ids.length; i += 200) {
        const { data, error } = await supabase.from('profiles').select('user_id, name, razao_social')
          .in('user_id', ids.slice(i, i + 200));
        if (error) throw error;
        for (const p of data ?? []) mapa.set(p.user_id, p.razao_social || p.name);
      }
      return mapa;
    },
  });
}

function SeloRecomendacao({ item }: { item: ItemFila }) {
  const f = faceRecomendacao(item);
  if (f.tipo === 'chegando') return <Badge variant="outline"><Sparkles className="mr-1 h-3 w-3" />recomendação chegando</Badge>;
  if (f.tipo === 'falhou') return <Badge variant="outline" className="text-status-warning">IA não conseguiu recomendar</Badge>;
  if (f.tipo === 'abstencao') return <Badge variant="outline">IA sem recomendação (dados insuficientes)</Badge>;
  return (
    <div className="flex flex-wrap items-center gap-1">
      <Badge variant="outline" className={f.recomendacao === 'aprovar' ? 'text-status-success' : 'text-status-error'}>
        IA: {f.recomendacao === 'aprovar' ? 'aprovar' : 'recusar'}
        {f.confianca !== null && ` · ${Math.round(f.confianca * 100)}%`}
        {f.prazo !== null && ` · prazo ${f.prazo} d`}
      </Badge>
      {f.codigos.map((c) => <Badge key={c} variant="secondary" className="text-xs">{rotuloCodigo(c)}</Badge>)}
    </div>
  );
}

function CartaoItem({ item, nome, podeDecidir, onDecidir }: {
  item: ItemFila; nome?: string; podeDecidir: boolean; onDecidir: (autorizar: boolean) => void;
}) {
  const uso = usoPosPedido(item);
  const atrasado = passouDoSla(item);
  return (
    <Card className={atrasado ? 'border-status-warning' : undefined}>
      <CardContent className="space-y-2 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="font-medium">
            {nome ?? 'Cliente'} · {EMPRESA_ROTULO[item.company]}
            {item.omie_numero_pedido && <span className="text-muted-foreground"> · PV {item.omie_numero_pedido}</span>}
          </div>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            {item.origem === 'sombra'
              ? <Badge variant="outline">simulado · pedido {item.origem_pedido === 'app' ? 'do app' : 'do Omie'}</Badge>
              : item.status !== 'aberta' && <Badge variant="outline">{item.status}</Badge>}
            <span className={atrasado ? 'text-status-warning' : undefined}>
              <Clock className="mr-1 inline h-3 w-3" />{horasNaFila(item.criado_em)} h
            </span>
          </div>
        </div>
        <div className="text-sm">{rotuloMotivo(item.motivo)}</div>
        <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
          <div><span className="text-muted-foreground">Pedido</span> {brl(item.valor_brl)}</div>
          <div><span className="text-muted-foreground">Prazo</span> {dias(item.prazo_dias)}</div>
          <div><span className="text-muted-foreground">Limite</span> {brl(item.limite_brl)}</div>
          <div><span className="text-muted-foreground">Uso após</span> {uso === null ? '—' : `${Math.round(uso * 100)}%`}</div>
        </div>
        <SeloRecomendacao item={item} />
        {podeDecidir && item.origem === 'efetivo' && item.status === 'aberta' && item.solicitacao_id && (
          <div className="flex gap-2 pt-1">
            <Button size="touch" onClick={() => onDecidir(true)}><CheckCircle2 className="mr-1 h-4 w-4" />Autorizar</Button>
            <Button size="touch" variant="outline" onClick={() => onDecidir(false)}><XCircle className="mr-1 h-4 w-4" />Recusar</Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function PainelEmpresa({ company, ligado, aprovador }: { company: Empresa; ligado: boolean; aprovador: boolean }) {
  const { data: p, isLoading, error } = useProntidao(company);
  const definir = useDefinirEnforcement();
  const [aberto, setAberto] = useState(false);
  const [motivo, setMotivo] = useState('');
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center justify-between text-base">
          <span>{EMPRESA_ROTULO[company]}</span>
          {ligado
            ? <Badge className="bg-status-error/10 text-status-error"><ShieldAlert className="mr-1 h-3 w-3" />enforcement LIGADO</Badge>
            : <Badge variant="outline"><ShieldCheck className="mr-1 h-3 w-3" />desligado (caminho atual)</Badge>}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-1 text-sm">
        {isLoading && <div className="text-muted-foreground">medindo prontidão…</div>}
        {error && <div className="text-status-error">não consegui medir a prontidão</div>}
        {p?.condicoes.map((c) => (
          <div key={c.chave} className="flex gap-2">
            <span className={c.ok ? 'text-status-success' : 'text-status-error'}>{c.ok ? '✓' : '✗'}</span>
            <span>{c.criterio}</span>
          </div>
        ))}
        {aprovador && (
          <Button size="sm" variant={ligado ? 'destructive' : 'outline'} className="mt-2"
                  disabled={!ligado && !p?.pronto} onClick={() => { setMotivo(''); setAberto(true); }}>
            {ligado ? 'Desligar enforcement' : 'Ligar enforcement'}
          </Button>
        )}
      </CardContent>
      <Dialog open={aberto} onOpenChange={setAberto}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{ligado ? 'Desligar' : 'Ligar'} o enforcement na {EMPRESA_ROTULO[company]}?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {ligado
              ? 'Os pedidos voltam ao caminho atual (só o piso de vencidos). As solicitações abertas desta empresa são canceladas.'
              : 'A partir de agora, pedido 🔴 é bloqueado e 🟡 espera a sua aprovação nesta fila.'}
          </p>
          <Textarea placeholder="Motivo (obrigatório)" value={motivo} onChange={(e) => setMotivo(e.target.value)} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setAberto(false)}>Cancelar</Button>
            <Button disabled={!motivoValido(motivo) || definir.isPending}
                    onClick={() => definir.mutate({ company, ligar: !ligado, motivo }, { onSuccess: () => setAberto(false) })}>
              Confirmar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

export default function CreditoFila() {
  const [filtros, setFiltros] = useUrlState({ aba: 'efetivo' });
  const fila = useFilaCredito();
  const flags = useFlagsEnforcement();
  const aprovador = useSouAprovador();
  const decidir = useDecidirFila();
  const [dialogo, setDialogo] = useState<{ item: ItemFila; autorizar: boolean } | null>(null);
  const [motivo, setMotivo] = useState('');

  const itens = useMemo(() => fila.data ?? [], [fila.data]);
  const efetivos = itens.filter((i) => i.origem === 'efetivo');
  const sombra = itens.filter((i) => i.origem === 'sombra');
  const ids = useMemo(() => [...new Set(itens.map((i) => i.customer_user_id).filter((x): x is string => !!x))], [itens]);
  const nomes = useNomesClientes(ids);
  const algumLigado = (flags.data ?? []).some((f) => f.ligado);
  const podeDecidir = aprovador.data === true;

  if (fila.isLoading || flags.isLoading) return <PageSkeleton variant="list" />;

  const face = dialogo ? faceRecomendacao(dialogo.item) : null;
  const discorda = dialogo && face ? discordaDaIa(face, dialogo.autorizar) : false;

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4">
      <div>
        <h1 className="font-display text-2xl">Fila de crédito</h1>
        <p className="text-sm text-muted-foreground">Pedidos que a política de crédito mandou para a sua aprovação.</p>
      </div>

      {fila.error && (
        <Card><CardContent className="p-4 text-status-error">Não consegui ler a fila. Recarregue em instantes.</CardContent></Card>
      )}

      {!algumLigado && (
        <Card className="border-status-info">
          <CardContent className="flex gap-2 p-4 text-sm">
            <AlertTriangle className="h-4 w-4 shrink-0 text-status-info" />
            <span>
              Enforcement <strong>desligado</strong> nas 3 empresas: nenhuma venda está sendo segurada pela regra nova.
              A aba <strong>Sombra</strong> mostra o que ela teria mandado para cá.
            </span>
          </CardContent>
        </Card>
      )}

      <Tabs value={filtros.aba} onValueChange={(aba) => setFiltros({ aba })}>
        <TabsList>
          <TabsTrigger value="efetivo">Pedidos reais ({efetivos.filter((i) => i.status === 'aberta').length})</TabsTrigger>
          <TabsTrigger value="sombra">Sombra ({sombra.length})</TabsTrigger>
          <TabsTrigger value="ligar">Ligar por empresa</TabsTrigger>
        </TabsList>
        <TabsContent value="efetivo" className="space-y-3">
          {efetivos.length === 0
            ? <EmptyState tone="operational" icon={Inbox} title="Nenhum pedido esperando" description="Quando o enforcement estiver ligado, os pedidos 🟡 aparecem aqui." />
            : efetivos.map((i) => (
              <CartaoItem key={i.item_id} item={i} nome={i.customer_user_id ? nomes.data?.get(i.customer_user_id) : undefined}
                          podeDecidir={podeDecidir} onDecidir={(autorizar) => { setMotivo(''); setDialogo({ item: i, autorizar }); }} />
            ))}
        </TabsContent>
        <TabsContent value="sombra" className="space-y-3">
          {sombra.length === 0
            ? <EmptyState tone="operational" icon={Inbox} title="Sombra sem itens" description="Nenhum pedido dos últimos 14 dias teria ido para a fila (ou a sombra ainda não rodou)." />
            : sombra.map((i) => (
              <CartaoItem key={i.item_id} item={i} nome={i.customer_user_id ? nomes.data?.get(i.customer_user_id) : undefined}
                          podeDecidir={false} onDecidir={() => undefined} />
            ))}
        </TabsContent>
        <TabsContent value="ligar" className="grid gap-3 sm:grid-cols-3">
          {EMPRESAS.map((c) => (
            <PainelEmpresa key={c} company={c} aprovador={podeDecidir}
                           ligado={(flags.data ?? []).find((f) => f.company === c)?.ligado ?? false} />
          ))}
        </TabsContent>
      </Tabs>

      <Dialog open={!!dialogo} onOpenChange={(o) => !o && setDialogo(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{dialogo?.autorizar ? 'Autorizar' : 'Recusar'} {dialogo && brl(dialogo.item.valor_brl)}?</DialogTitle>
          </DialogHeader>
          {discorda && <p className="text-sm text-status-warning">Você está decidindo contra a recomendação da IA — explique no motivo.</p>}
          {dialogo?.autorizar && <p className="text-sm text-muted-foreground">A autorização vale 24 h para esta revisão do pedido; editar total ou prazo reabre a fila.</p>}
          <Textarea placeholder="Motivo (obrigatório)" value={motivo} onChange={(e) => setMotivo(e.target.value)} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogo(null)}>Cancelar</Button>
            <Button disabled={!motivoValido(motivo) || decidir.isPending || !dialogo?.item.solicitacao_id}
                    onClick={() => dialogo?.item.solicitacao_id && decidir.mutate(
                      { solicitacaoId: dialogo.item.solicitacao_id, autorizar: dialogo.autorizar, motivo, discordouDaIa: discorda },
                      { onSuccess: () => setDialogo(null) })}>
              Confirmar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
