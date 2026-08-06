import { useState, useMemo, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { Card, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { track } from '@/lib/analytics';
import { BotaoLigar } from '@/components/call/BotaoLigar';
import { useFilaAcoes, type FonteFila } from '@/hooks/useFilaAcoes';
import { useCriticaFila } from '@/hooks/useCriticaFila';
import { PorQueAgora } from '@/components/fila/PorQueAgora';
import type { AcaoSugerida, CategoriaAcao } from '@/lib/fila/types';
import { spBusinessDate } from '@/lib/time/sp-day';
import { marcarSeNovoNoDia, chaveDiaExibida, resumoFontes } from '@/lib/fila/telemetria';
import { AcaoOutcomeMenu } from './AcaoOutcomeMenu';
import { useFeatureFlag } from '@/hooks/useFeatureFlag';
import { FilaContextPanel } from './FilaContextPanel';

const CATEGORIA_UI: Record<CategoriaAcao, { label: string; cls: string }> = {
  prazo: { label: 'Prazo', cls: 'text-status-warning' },
  certo: { label: 'Certo', cls: 'text-status-success' },
  esperado: { label: 'Oportunidade', cls: 'text-status-info' },
  risco: { label: 'Risco', cls: 'text-status-error' },
};

/** Rótulos das fontes na linguagem da vendedora (rota = a lista de ligação; mix-gap = oportunidades). */
const ROTULO_FONTE: Record<FonteFila, string> = {
  tarefas: 'tarefas',
  rota: 'lista de ligação',
  'mix-gap': 'oportunidades',
  whatsapp: 'WhatsApp',
};
const rotularFontes = (fontes: FonteFila[]) => fontes.map((f) => ROTULO_FONTE[f]).join(', ');

function clienteHref(a: AcaoSugerida): string | null {
  return a.clienteUserId ? `/admin/customers/${a.clienteUserId}/360` : null;
}

/** CTA "Fazer": tel/wa abrem o app nativo; pedido/abrir navegam interno. Sem persistir nada (render mínimo). */
function AcaoCta({ a, temCritica }: { a: AcaoSugerida; temCritica: boolean }) {
  const onClick = () => {
    track('fila.acao_fazer', { fonte: a.fonte, cta: a.cta, categoria: a.categoria });
    if (temCritica) track('fila.critica_acted', { cliente: a.clienteUserId, cta: a.cta });
  };
  const tel = a.telefone?.replace(/\D/g, '');
  if (a.cta === 'ligar' && tel) {
    return <BotaoLigar telefone={a.telefone} nomeCliente={a.clienteNome ?? a.titulo} onLigar={onClick} />;
  }
  // Conversa pendente abre a INBOX interna na conversa (contexto/thread/SLA);
  // wa.me fica pros CTAs sem conversa aberta (ex.: contato da rota).
  if (a.payload.kind === 'whatsapp') {
    return <Button asChild size="sm" variant="outline"><Link to={`/whatsapp?conversa=${a.payload.conversationId}`} onClick={onClick}>Responder</Link></Button>;
  }
  if (a.cta === 'whatsapp' && tel) {
    return <Button asChild size="sm" variant="outline"><a href={`https://wa.me/${tel}`} target="_blank" rel="noopener noreferrer" onClick={onClick}>WhatsApp</a></Button>;
  }
  if (a.cta === 'pedido') {
    return <Button asChild size="sm" variant="outline"><Link to="/sales/new" onClick={onClick}>Montar pedido</Link></Button>;
  }
  const href = clienteHref(a);
  if (href) return <Button asChild size="sm" variant="outline"><Link to={href} onClick={onClick}>Abrir</Link></Button>;
  return null;
}

/**
 * Fila única do dia (G1). Consome useFilaAcoes() e mostra as ações ranqueadas; lidera o "Meu dia".
 * Fase 2: outcome inline + esconder-na-sessão + telemetria. Crítica da fila: PorQueAgora (contradições).
 * Fase 3 (flag `filaContextPanel`): clicar no item abre o FilaContextPanel (painel de contexto).
 */
export function FilaDoDia() {
  const { acoes, isLoading, isError, fontesComErro, retry } = useFilaAcoes();
  const packs = useCriticaFila(acoes);
  const shownRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    for (const [cli, pack] of packs) {
      if (pack.contradicoes.length > 0 && !shownRef.current.has(cli)) {
        shownRef.current.add(cli);
        track('fila.critica_shown', { cliente: cli, chaves: pack.contradicoes.map(c => c.chave) });
      }
    }
  }, [packs]);

  const [escondidos, setEscondidos] = useState<Set<string>>(() => new Set());
  const ocultar = (k: string) => setEscondidos((s) => { const n = new Set(s); n.add(k); return n; });
  const visiveis = useMemo(() => acoes.filter((a) => !escondidos.has(a.dedupeKey)), [acoes, escondidos]);

  const [painelOn] = useFeatureFlag('filaContextPanel', false);
  const [itemAtivo, setItemAtivo] = useState<AcaoSugerida | null>(null);
  const abrirPainel = (a: AcaoSugerida) => {
    setItemAtivo(a);
    track('fila.painel_aberto', { fonte: a.fonte, dedupeKey: a.dedupeKey });
  };

  // fila.exibida: 1×/dia/sessão (NÃO por render) — mede exposição, não re-render.
  useEffect(() => {
    if (isLoading || visiveis.length === 0) return;
    const dia = spBusinessDate(new Date());
    if (marcarSeNovoNoDia(chaveDiaExibida(dia), sessionStorage)) {
      track('fila.exibida', { qtd: visiveis.length, fontes: resumoFontes(visiveis) });
    }
  }, [isLoading, visiveis]);

  if (isLoading) {
    return (
      <Card className="p-3 space-y-2">
        <Skeleton className="h-4 w-40" />
        {[0, 1, 2].map(i => <Skeleton key={i} className="h-12 w-full" />)}
      </Card>
    );
  }

  if (visiveis.length === 0) {
    // Erro ≠ dia limpo: sem isto, RLS negada/rede ruim virava "carteira em
    // dia" — falso-verde num motor de receita (a vendedora deixava de ligar).
    if (isError) {
      return (
        <Card className="p-6">
          <p className="text-sm font-medium">Não consegui carregar sua fila.</p>
          <p className="text-2xs text-muted-foreground mt-1">
            Falha em: {rotularFontes(fontesComErro)} — isso NÃO significa que a carteira está em dia.
          </p>
          <Button size="sm" variant="outline" className="mt-3" onClick={retry}>Tentar de novo</Button>
        </Card>
      );
    }
    return (
      <Card className="p-6">
        <p className="text-sm font-medium">Nada prioritário na fila agora.</p>
        <p className="text-2xs text-muted-foreground mt-1">
          Sua carteira está em dia. Se quiser adiantar, veja a lista completa de ligações da rota ou seus clientes.
        </p>
        <div className="flex gap-2 mt-3">
          <Button asChild size="sm" variant="outline"><Link to="/rota/ligacoes">Ver rota completa</Link></Button>
          <Button asChild size="sm" variant="ghost"><Link to="/admin/customers">Ver clientes</Link></Button>
        </div>
      </Card>
    );
  }

  return (
    <>
      <Card>
        <CardHeader className="pb-2">
          <h2 className="text-base font-medium">O que fazer agora</h2>
          <p className="text-2xs text-muted-foreground">
            {visiveis.length} ações priorizadas — tarefas, rota e oportunidades, do mais urgente ao menos.
          </p>
          {isError && (
            <p className="text-2xs text-status-warning">
              Falha ao carregar: {rotularFontes(fontesComErro)} — a lista pode estar incompleta.{' '}
              <button type="button" className="underline" onClick={retry}>Tentar de novo</button>
            </p>
          )}
        </CardHeader>
        <div className="divide-y divide-border">
          {visiveis.slice(0, 30).map((a, i) => {
            const cat = CATEGORIA_UI[a.categoria];
            const href = clienteHref(a);
            const pack = a.clienteUserId ? packs.get(a.clienteUserId) : undefined;
            return (
              <div key={`${a.dedupeKey}:${i}`} className="p-3 flex items-start justify-between gap-3 hover:bg-muted/30">
                <div className="min-w-0">
                  {painelOn ? (
                    <button type="button" onClick={() => abrirPainel(a)} className="block w-full text-left text-sm font-medium truncate hover:underline">{a.titulo}</button>
                  ) : href ? (
                    <Link to={href} className="block text-sm font-medium truncate hover:underline">{a.titulo}</Link>
                  ) : (
                    <div className="text-sm font-medium truncate">{a.titulo}</div>
                  )}
                  <div className="text-2xs text-muted-foreground flex gap-2 flex-wrap items-center mt-0.5">
                    <Badge variant="outline" className={`text-2xs ${cat.cls}`}>{cat.label}</Badge>
                    <span className="truncate">{a.motivo}</span>
                    {a.valorEsperado != null && (
                      <span className="font-tabular">~R$ {Math.round(a.valorEsperado).toLocaleString('pt-BR')} estimado</span>
                    )}
                  </div>
                  {pack && <PorQueAgora pack={pack} />}
                </div>
                <div className="shrink-0 flex items-center gap-1">
                  <AcaoCta a={a} temCritica={!!pack && pack.contradicoes.length > 0} />
                  <AcaoOutcomeMenu acao={a} onNaoUtilAgora={ocultar} />
                </div>
              </div>
            );
          })}
        </div>
      </Card>
      {painelOn && <FilaContextPanel acao={itemAtivo} onClose={() => setItemAtivo(null)} onNaoUtilAgora={ocultar} />}
    </>
  );
}
