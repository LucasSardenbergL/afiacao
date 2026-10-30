import { useEffect, useRef, type ReactNode } from 'react';
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

/** Moldura de CHIP de filtro: rótulo + contagem (ou o estado honesto dela) + o toggle. Os chips eram
 *  cards do placar; viraram filtro porque o número só serve para decidir se vale a pena ligar. */
function Chip({ children, testId }: { children: ReactNode; testId: string }) {
  return (
    <div className="inline-flex items-center gap-2 rounded-full border bg-card px-3 py-1 text-sm" data-testid={testId}>
      {children}
    </div>
  );
}

/**
 * Chip "Inéditos do lote YYYY-MM: N de T" — substitui o "Novos no lote" (que mostrava o `novos`
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
    <Chip testId="radar-kpi-ineditos">
      <span className="text-xs text-muted-foreground">{lote ? `Inéditos do lote ${lote.mes_referencia}` : 'Inéditos do lote'}</span>
      {carregando ? (
        <span className="kpi-value">…</span>
      ) : falhou ? (
        <span className="text-xs text-status-warning">não consegui contar</span>
      ) : !lote ? (
        <span className="text-xs text-muted-foreground">sem lote completo</span>
      ) : (
        <span className="kpi-value">
          {qN.data != null ? qN.data.toLocaleString('pt-BR') : '…'}
          <span className="text-xs text-muted-foreground font-normal"> de {lote.total_recebido.toLocaleString('pt-BR')}</span>
        </span>
      )}
      {lote && (
        <button
          type="button"
          aria-pressed={soIneditos}
          onClick={alternar}
          className={cn(
            'rounded-full border px-2 py-px text-[11px] leading-4 transition-colors',
            soIneditos ? 'border-primary bg-primary text-primary-foreground' : 'border-border text-muted-foreground hover:bg-accent/40',
          )}
        >
          só inéditos
        </button>
      )}
    </Chip>
  );
}

/**
 * Chip "Sugeridos para cadastro: N de T" (bloco 5 — qualificação + aprovação em 1 clique). N =
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
  // Refetch que falhou COM número no cache: o número fica, com o aviso (estado composto, como o
  // painel). Sem isso um "0 de T" velho seguia na tela, botão ativo, sem sinal da falha (Codex).
  const velho = desatualizado(qN, qN.data !== undefined) ?? desatualizado(qL, loteLido);

  const alternar = () => {
    if (!lote) return;
    const ativo = !soSugeridos;
    track('radar.sugeridos_filtro', {
      ativo, origem: 'card', lote: lote.mes_referencia, sugeridos: qN.data?.sugeridos ?? null, total: lote.total_recebido, limiar: LIMIAR_SUGERIDO,
    });
    onSoSugeridos(ativo);
  };

  return (
    <Chip testId="radar-kpi-sugeridos">
      <span className="text-xs text-muted-foreground" title={`Em conversa · não cliente · score ≥ ${LIMIAR_SUGERIDO} · foto vigente (lote inteiro, sem os filtros da tela)`}>
        Sugeridos para cadastro
      </span>
      {!falhou && (carregando || estado.tipo === 'carregando') ? (
        <span className="kpi-value">…</span>
      ) : falhou ? (
        <span className="text-xs text-status-warning">não consegui contar</span>
      ) : estado.tipo === 'sem_lote' ? (
        <span className="text-xs text-muted-foreground">sem lote completo</span>
      ) : estado.tipo === 'sem_score' ? (
        <span className="text-xs text-muted-foreground" title="A rodada diária de score (03:30 BRT) ainda não cobriu este lote">sem score calculado</span>
      ) : estado.tipo === 'pronto' && lote ? (
        <span className="kpi-value">
          {estado.n.toLocaleString('pt-BR')}
          <span className="text-xs text-muted-foreground font-normal"> de {lote.total_recebido.toLocaleString('pt-BR')}</span>
        </span>
      ) : null}
      {!falhou && velho && (
        <span className="text-[11px] text-status-warning" data-testid="radar-kpi-sugeridos-desatualizado">
          {velho === 'sem-rede' ? 'desatualizado · sem rede' : 'desatualizado · não consegui atualizar'}
        </span>
      )}
      {/* Ligado (pela URL) continua desligável mesmo sem número: o chip é o único controle do filtro. */}
      {lote && (estado.tipo === 'pronto' || soSugeridos) && (
        <button
          type="button"
          aria-pressed={soSugeridos}
          onClick={alternar}
          className={cn(
            'rounded-full border px-2 py-px text-[11px] leading-4 transition-colors',
            soSugeridos ? 'border-primary bg-primary text-primary-foreground' : 'border-border text-muted-foreground hover:bg-accent/40',
          )}
        >
          só sugeridos
        </button>
      )}
    </Chip>
  );
}

/**
 * Card "Lote vigente": o mês da foto da RFB que a fila mostra e quantas empresas ela trouxe. Mesma
 * leitura (e cache) da fila; ausência é estado, nunca 0.
 */
function CardLote() {
  const qL = useRadarLoteVigente();
  const estado = estadoDeLeitura(qL);
  const lote = qL.data ?? null;
  return (
    <div className="rounded-md border bg-card p-3" data-testid="radar-kpi-lote">
      <div className="text-xs text-muted-foreground">Lote vigente</div>
      {qL.data === undefined && naoConsegui(estado) ? (
        <div className="text-sm text-status-warning mt-1">não consegui ler</div>
      ) : qL.data === undefined ? (
        <div className="kpi-value text-2xl">…</div>
      ) : !lote ? (
        <div className="text-sm text-muted-foreground mt-1">sem lote completo</div>
      ) : (
        <>
          <div className="kpi-value text-2xl">{lote.mes_referencia}</div>
          <div className="text-xs text-muted-foreground mt-0.5">{lote.total_recebido.toLocaleString('pt-BR')} empresas na foto</div>
        </>
      )}
    </div>
  );
}

/**
 * Chips de filtro do lote (inéditos e sugeridos). Ficam FORA do placar de propósito: o placar depende
 * do gate de `radar_kpis` (gestor/master); os chips leem as próprias contagens e são o único controle
 * dos filtros "só inéditos" e "só sugeridos" — sumir com o placar não pode sumir com o filtro.
 */
export function RadarChipsLote({
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
  return (
    <div className="flex flex-wrap gap-2">
      <CardIneditos soIneditos={soIneditos} onSoIneditos={onSoIneditos} />
      <CardSugeridos soSugeridos={soSugeridos} onSoSugeridos={onSoSugeridos} />
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
export function RadarKpis() {
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
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {Array.from({ length: 3 }).map((_, i) => (
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
      {/* 3 cards (eram 5): "em conversa" está no filtro de status; inéditos e sugeridos viraram chips. */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <CardLote />
        <Card label="A contatar" valor={data.a_contatar.toLocaleString('pt-BR')} hint="todo o Radar, sem os filtros da tela" />
        <Card label="Viraram cliente (mês)" valor={data.virou_cliente_mes.toLocaleString('pt-BR')} />
      </div>
      {velho && <AvisoLeituraFalhou oque="a leitura mais recente" estado={velho} className="mt-2" />}
    </div>
  );
}
