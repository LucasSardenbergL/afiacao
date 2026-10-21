import { useState, useMemo, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { CalendarClock } from 'lucide-react';
import { Card, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { track } from '@/lib/analytics';
import { useFilaAcoes, type FonteFila } from '@/hooks/useFilaAcoes';
import { useCriticaFila } from '@/hooks/useCriticaFila';
import { rotuloResultado } from '@/hooks/useRegistrarContato';
import { useContatosDoDia } from '@/hooks/useContatosDoDia';
import { PorQueAgora } from '@/components/fila/PorQueAgora';
import type { AcaoSugerida, CategoriaAcao } from '@/lib/fila/types';
import type { EstadoRecompra } from '@/hooks/useMinhasSugestoes';
import { spBusinessDate } from '@/lib/time/sp-day';
import { marcarSeNovoNoDia, chaveDiaExibida, resumoFontes } from '@/lib/fila/telemetria';
import { LinkTelefone } from '@/components/venda-cliente/LinkTelefone';
import { FichaLigacao } from '@/components/venda-cliente/FichaLigacao';
import { AcaoOutcomeMenu } from './AcaoOutcomeMenu';

const CATEGORIA_UI: Record<CategoriaAcao, { label: string; cls: string }> = {
  prazo: { label: 'Prazo', cls: 'text-status-warning' },
  certo: { label: 'Certo', cls: 'text-status-success' },
  esperado: { label: 'Oportunidade', cls: 'text-status-info' },
  risco: { label: 'Risco', cls: 'text-status-error' },
};

/** Rótulo do badge por fonte (a recompra é "Recompra", não a categoria genérica). */
function rotuloBadge(a: AcaoSugerida): { label: string; cls: string } {
  if (a.fonte === 'recompra') return { label: 'Recompra', cls: 'text-status-info' };
  return CATEGORIA_UI[a.categoria];
}

/** Rótulos das fontes na linguagem da vendedora. */
const ROTULO_FONTE: Record<FonteFila, string> = {
  recompra: 'lista de recompra',
  'mix-gap': 'oportunidades',
};
const rotularFontes = (fontes: FonteFila[]) => fontes.map((f) => ROTULO_FONTE[f]).join(', ');

/** CTA "Fazer": ligar abre o discador (`tel:`); pedido navega interno. M-41: nada de WebRTC. */
function AcaoCta({ a, temCritica }: { a: AcaoSugerida; temCritica: boolean }) {
  const onClick = () => {
    track('fila.acao_fazer', { fonte: a.fonte, cta: a.cta, categoria: a.categoria });
    if (temCritica) track('fila.critica_acted', { cliente: a.clienteUserId, cta: a.cta });
  };
  if (a.cta === 'ligar' && a.clienteUserId) {
    return (
      <span onClickCapture={onClick}>
        <LinkTelefone telefone={a.telefone} compradorId={a.clienteUserId} origem="lista" />
      </span>
    );
  }
  if (a.cta === 'pedido') {
    return <Button asChild size="sm" variant="outline"><Link to="/sales/new" onClick={onClick}>Montar pedido</Link></Button>;
  }
  return null;
}

/** Aviso fixo acima da lista quando a recompra ainda não está servindo (onda desligada). */
function AvisoRecompra({ estado }: { estado: EstadoRecompra }) {
  if (estado.tipo === 'onda_desligada') {
    return (
      <Card className="p-5 flex gap-3 items-start">
        <CalendarClock className="w-5 h-5 text-status-info shrink-0 mt-0.5" />
        <div>
          <p className="text-sm font-medium">Sua lista de quem ligar começa em breve.</p>
          <p className="text-2xs text-muted-foreground mt-1">
            Todo dia ela vai trazer os clientes da sua carteira com recompra atrasada — e quem tem entrega amanhã.
            Ela liga sozinha quando estiver conferida; você não precisa fazer nada.
          </p>
        </div>
      </Card>
    );
  }
  return null;
}

/**
 * Fila única do dia. Fonte principal: lista de recompra (servidor). Clicar no cliente abre a
 * FichaLigacao (telefone, munição, Recomprar, Histórico, desfecho em 1 toque).
 */
export function FilaDoDia() {
  const { acoes, isLoading, isError, fontesComErro, recompra, retry } = useFilaAcoes();
  const packs = useCriticaFila(acoes);
  const contatos = useContatosDoDia();
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

  const [itemAtivo, setItemAtivo] = useState<AcaoSugerida | null>(null);
  const abrirFicha = (a: AcaoSugerida) => {
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

  const ficha = (
    <FichaLigacao
      compradorId={itemAtivo?.clienteUserId ?? null}
      nome={itemAtivo?.clienteNome}
      telefone={itemAtivo?.telefone}
      motivo={itemAtivo?.motivo}
      onClose={() => setItemAtivo(null)}
    />
  );

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
    // Onda desligada: a mensagem própria, nunca "nada a fazer".
    if (recompra.tipo === 'onda_desligada') {
      return <AvisoRecompra estado={recompra} />;
    }
    return (
      <Card className="p-6">
        <p className="text-sm font-medium">Ninguém na sua lista hoje.</p>
        <p className="text-2xs text-muted-foreground mt-1">
          Nenhum cliente da sua carteira está com recompra atrasada para hoje. Se quiser adiantar, veja seus clientes.
        </p>
        <Button asChild size="sm" variant="ghost" className="mt-3"><Link to="/admin/customers">Ver clientes</Link></Button>
      </Card>
    );
  }

  const nRecompra = visiveis.filter((a) => a.fonte === 'recompra').length;

  return (
    <>
      <AvisoRecompra estado={recompra} />
      <Card>
        <CardHeader className="pb-2">
          <h2 className="text-base font-medium">Quem ligar hoje</h2>
          <p className="text-2xs text-muted-foreground">
            {nRecompra > 0
              ? `${nRecompra} ${nRecompra === 1 ? 'cliente' : 'clientes'} com recompra atrasada, do maior valor ao menor. Toque no nome para abrir a ficha.`
              : `${visiveis.length} oportunidades na sua carteira.`}
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
            const badge = rotuloBadge(a);
            const pack = a.clienteUserId ? packs.get(a.clienteUserId) : undefined;
            const contato = a.clienteUserId ? contatos.data?.get(a.clienteUserId) : undefined;
            return (
              <div key={`${a.dedupeKey}:${i}`} className="p-3 flex items-start justify-between gap-3 hover:bg-muted/30">
                <div className="min-w-0">
                  {a.clienteUserId ? (
                    <button type="button" onClick={() => abrirFicha(a)} className="block w-full text-left text-sm font-medium truncate hover:underline">{a.titulo}</button>
                  ) : (
                    <div className="text-sm font-medium truncate">{a.titulo}</div>
                  )}
                  <div className="text-2xs text-muted-foreground flex gap-2 flex-wrap items-center mt-0.5">
                    <Badge variant="outline" className={`text-2xs ${badge.cls}`}>{badge.label}</Badge>
                    {contato && <Badge variant="secondary" className="text-2xs">{rotuloResultado(contato)}</Badge>}
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
      {ficha}
    </>
  );
}
