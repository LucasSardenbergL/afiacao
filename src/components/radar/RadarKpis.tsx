import { useEffect, useRef } from 'react';
import { useRadarKpis } from '@/queries/useRadarKpis';
import { Skeleton } from '@/components/ui/skeleton';
import { estadoDeLeitura, naoConsegui, desatualizado, type EstadoLeitura } from '@/lib/leitura/estado-de-leitura';
import { AvisoLeituraFalhou } from '@/components/leitura/AvisoLeituraFalhou';
import { estadoNaSerie } from '@/lib/leitura/serie';
import { track } from '@/lib/analytics';
import { cn } from '@/lib/utils';
import { useRadarLoteVigente } from '@/queries/useRadarLoteVigente';
import { useRadarIneditos } from '@/queries/useRadarIneditos';
import { useRadarSugeridos } from '@/queries/useRadarSugeridos';
import { LIMIAR_SUGERIDO, estadoCardSugeridos } from '@/lib/radar/sugeridos';

function Card({ label, valor, hint }: { label: string; valor: number | string; hint?: string }) {
  return (
    <div className="rounded-md border bg-card p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="kpi-value text-2xl">{valor}</div>
      {hint && <div className="text-xs text-muted-foreground mt-0.5">{hint}</div>}
    </div>
  );
}

/**
 * Card "Inéditos do lote YYYY-MM: N de T" — substitui o "Novos no lote" (que mostrava o `novos`
 * CONGELADO do ingest, sem denominador e sem ação). N vem de `useRadarIneditos` (count vivo, mesmo
 * predicado do selo "inédito" da linha); T é `total_recebido` do lote vigente. 1 clique liga o
 * filtro "só inéditos" da fila — e o sensor `radar.ineditos_filtro` leva N e T junto, para o uso
 * em prod ter denominador (fase-sem-sinal.md).
 *
 * Três ausências, três telas distintas — nenhuma vira 0:
 *   · lote vigente NÃO lido (erro/offline) ou count falhou → "não consegui contar";
 *   · nenhum lote `complete` → "sem lote completo" (sem botão: o filtro não teria efeito);
 *   · carregando → reticências.
 */
function CardIneditos({ soIneditos, onSoIneditos }: { soIneditos: boolean; onSoIneditos: (v: boolean) => void }) {
  const qL = useRadarLoteVigente();
  const lote = qL.data ?? null;
  const qN = useRadarIneditos(lote);
  const estadoL = estadoDeLeitura(qL);
  const estadoN = estadoDeLeitura(qN);
  const loteLido = qL.data !== undefined;
  const falhou = (naoConsegui(estadoL) && !loteLido) || (lote != null && naoConsegui(estadoN) && qN.data === undefined);
  const carregando = !falhou && (estadoL === 'carregando' || (lote != null && estadoN === 'carregando' && qN.data === undefined));

  const alternar = () => {
    if (!lote) return;
    const ativo = !soIneditos;
    track('radar.ineditos_filtro', {
      ativo, origem: 'card', lote: lote.mes_referencia, ineditos: qN.data ?? null, total: lote.total_recebido,
    });
    onSoIneditos(ativo);
  };

  return (
    <div className="rounded-md border bg-card p-3" data-testid="radar-kpi-ineditos">
      <div className="text-xs text-muted-foreground">{lote ? `Inéditos do lote ${lote.mes_referencia}` : 'Inéditos do lote'}</div>
      {carregando ? (
        <div className="kpi-value text-2xl">…</div>
      ) : falhou ? (
        <div className="text-sm text-status-warning mt-1">não consegui contar</div>
      ) : !lote ? (
        <div className="text-sm text-muted-foreground mt-1">sem lote completo</div>
      ) : (
        <div className="kpi-value text-2xl">
          {qN.data != null ? qN.data.toLocaleString('pt-BR') : '…'}
          <span className="text-sm text-muted-foreground font-normal"> de {lote.total_recebido.toLocaleString('pt-BR')}</span>
        </div>
      )}
      {lote && (
        <button
          type="button"
          aria-pressed={soIneditos}
          onClick={alternar}
          className={cn(
            'mt-1 rounded border px-1.5 py-px text-[11px] leading-4 transition-colors',
            soIneditos ? 'border-primary bg-primary text-primary-foreground' : 'border-border text-muted-foreground hover:bg-accent/40',
          )}
        >
          só inéditos
        </button>
      )}
    </div>
  );
}

/**
 * Card "Sugeridos para cadastro: N de T" (bloco 5 — qualificação + aprovação em 1 clique). N =
 * leads da foto vigente em conversa, não clientes, com score ≥ LIMIAR_SUGERIDO (predicado em
 * `sugeridos.ts`; count em `useRadarSugeridos`); T = `total_recebido` do lote. Conta o LOTE
 * INTEIRO — os filtros da tela (UF, CNAE, busca) não entram. 1 clique liga "só sugeridos" na
 * fila, já com a seleção múltipla pronta para "Cadastrar selecionados"; o sensor leva N, T e o
 * limiar. Nada aqui cadastra: o clique só FILTRA.
 *
 * Quatro ausências, quatro telas — nenhuma vira 0:
 *   · lote ou count não lidos → "não consegui contar";
 *   · nenhum lote `complete` → "sem lote completo";
 *   · rodada de score ainda não cobriu este lote (ledger) → "sem score calculado" — um count de
 *     `score ≥ 70` sobre lote sem score daria 0 e fabricaria "ninguém vale a pena";
 *   · carregando → reticências.
 */
function CardSugeridos({ soSugeridos, onSoSugeridos }: { soSugeridos: boolean; onSoSugeridos: (v: boolean) => void }) {
  const qL = useRadarLoteVigente();
  const lote = qL.data ?? null;
  const qN = useRadarSugeridos(lote);
  const estadoL = estadoDeLeitura(qL);
  const estadoN = estadoDeLeitura(qN);
  const loteLido = qL.data !== undefined;
  const falhou = (naoConsegui(estadoL) && !loteLido) || (lote != null && naoConsegui(estadoN) && qN.data === undefined);
  const carregando = !falhou && (estadoL === 'carregando' || (lote != null && estadoN === 'carregando' && qN.data === undefined));
  const estado = estadoCardSugeridos({ lote, temScore: qN.data?.temScore, sugeridos: qN.data?.sugeridos });

  const alternar = () => {
    if (!lote) return;
    const ativo = !soSugeridos;
    track('radar.sugeridos_filtro', {
      ativo, origem: 'card', lote: lote.mes_referencia, sugeridos: qN.data?.sugeridos ?? null, total: lote.total_recebido, limiar: LIMIAR_SUGERIDO,
    });
    onSoSugeridos(ativo);
  };

  return (
    <div className="rounded-md border bg-card p-3" data-testid="radar-kpi-sugeridos">
      <div className="text-xs text-muted-foreground" title={`Em conversa · não cliente · score ≥ ${LIMIAR_SUGERIDO} · foto vigente (lote inteiro, sem os filtros da tela)`}>
        Sugeridos para cadastro
      </div>
      {!falhou && (carregando || estado.tipo === 'carregando') ? (
        <div className="kpi-value text-2xl">…</div>
      ) : falhou ? (
        <div className="text-sm text-status-warning mt-1">não consegui contar</div>
      ) : estado.tipo === 'sem_lote' ? (
        <div className="text-sm text-muted-foreground mt-1">sem lote completo</div>
      ) : estado.tipo === 'sem_score' ? (
        <div className="text-sm text-muted-foreground mt-1" title="A rodada diária de score (03:30 BRT) ainda não cobriu este lote">sem score calculado</div>
      ) : estado.tipo === 'pronto' && lote ? (
        <div className="kpi-value text-2xl">
          {estado.n.toLocaleString('pt-BR')}
          <span className="text-sm text-muted-foreground font-normal"> de {lote.total_recebido.toLocaleString('pt-BR')}</span>
        </div>
      ) : null}
      {lote && estado.tipo === 'pronto' && (
        <button
          type="button"
          aria-pressed={soSugeridos}
          onClick={alternar}
          className={cn(
            'mt-1 rounded border px-1.5 py-px text-[11px] leading-4 transition-colors',
            soSugeridos ? 'border-primary bg-primary text-primary-foreground' : 'border-border text-muted-foreground hover:bg-accent/40',
          )}
        >
          só sugeridos
        </button>
      )}
    </div>
  );
}

/**
 * Placar do lote do Radar de prospecção — o resumo que o gestor lê antes da lista.
 *
 * CLASSE "erro colapsado em vazio" (docs/historico/fase-sem-sinal.md). Fazia
 * `const { data, isLoading } = useRadarKpis(); if (!data) return null` — e como o hook
 * LANÇA quando a RPC falha, `data` fica `undefined` no erro, na primeira carga e no
 * offline: os três colapsavam no mesmo sumiço. Denominador medido em prod (psql-ro,
 * 2026-08-23): `radar_empresas` tem 526.176 empresas, 523.180 delas `a_contatar`, lote
 * 2026-05 `complete`. É o único dos cinco cards desta leva com dano VIVO — a falha de
 * leitura apagava, sem rastro, o resumo de meio milhão de prospects, e a lista embaixo
 * continuava na tela dando ao painel a aparência de quem simplesmente não tem números.
 *
 * Ausência de ACESSO NÃO passa por aqui: o `enabled` do hook espelha o gate da RPC, então
 * staff não-gestor cai em `desabilitada` — não renderiza, não avisa e não emite evento.
 */
export function RadarKpis({
  soIneditos,
  onSoIneditos,
  soSugeridos,
  onSoSugeridos,
}: {
  soIneditos: boolean;
  onSoIneditos: (v: boolean) => void;
  soSugeridos: boolean;
  onSoSugeridos: (v: boolean) => void;
}) {
  const q = useRadarKpis();
  const { data } = q;
  const estado = estadoDeLeitura(q);

  // Sensor de adoção (o card nasceu sem nenhum): sem ele não há como saber, em prod, se o
  // aviso abaixo apareceu. Emite em TODO estado RESOLVIDO — erro inclusive — e leva `null`
  // no lugar do número quando a leitura não aconteceu: `0` somaria falha de leitura a
  // "lote vazio", que é a MESMA fabricação que este card existe para não cometer
  // (money-path §2: ausente ≠ zero). `desabilitada` (sem acesso) e `carregando` não emitem
  // — contá-las poluiria o denominador com quem nunca poderia ver a tela.
  // A dedup é pelo ESTADO emitido, não por booleano: `erro → pronta` na mesma montagem é
  // justamente a transição que separa falha transitória de lote realmente vazio.
  const trackedEstado = useRef<EstadoLeitura | null>(null);
  useEffect(() => {
    if (estado === 'carregando' || estado === 'desabilitada') return;
    if (trackedEstado.current === estado) return;
    trackedEstado.current = estado;
    track('radar.kpis_vistos', {
      // `estadoNaSerie(...)` e nao `estado` cru: o helper fala `'sem-rede'` (hifen) e a
      // serie `radar.*` fala `sem_rede`. Trocar nao muda a tela nem movia o `tsc` antes
      // do gate — muda o NOME sob o qual o evento sai, e o breakdown perde o historico.
      // Serie medida em ZERO evento em 90d com o cano vivo — normalizar nao parte historico.
      estado: estadoNaSerie(estado),
      a_contatar: data?.a_contatar ?? null,
    });
  }, [estado, data]);

  if (estado === 'carregando')
    return (
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-20" />
        ))}
      </div>
    );

  // Sem NADA em mãos: só o aviso — é exatamente o que o defeito escondia.
  if (naoConsegui(estado) && !data) {
    return <AvisoLeituraFalhou oque="os indicadores do lote do Radar" estado={estado} className="mb-0" />;
  }

  // COM os números no cache e um refetch que falhou, apagar o painel trocaria um defeito
  // por outro. Estado COMPOSTO: os KPIs ficam, com o aviso de que estão desatualizados.
  const velho = desatualizado(q, Boolean(data));

  // `desabilitada` — a pergunta que não foi feita (staff sem acesso ao Radar).
  if (!data) return null;

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <CardIneditos soIneditos={soIneditos} onSoIneditos={onSoIneditos} />
        <CardSugeridos soSugeridos={soSugeridos} onSoSugeridos={onSoSugeridos} />
        <Card label="A contatar" valor={data.a_contatar.toLocaleString('pt-BR')} />
        <Card label="Em conversa" valor={data.em_conversa.toLocaleString('pt-BR')} />
        <Card label="Viraram cliente (mês)" valor={data.virou_cliente_mes.toLocaleString('pt-BR')} />
      </div>
      {velho && <AvisoLeituraFalhou oque="a leitura mais recente" estado={velho} className="mt-2" />}
    </div>
  );
}
