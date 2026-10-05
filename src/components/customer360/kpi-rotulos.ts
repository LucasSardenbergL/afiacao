// Rótulos da faixa de KPIs do Customer 360 — degradação HONESTA nos dois sentidos: valor que não foi
// lido é "—" com o motivo, nunca R$ 0 nem um número-sentinela exibido como se fosse medida; e valor
// lido que não pôde ser ATUALIZADO fica na tela declarando a idade (o idioma de `desatualizado()`),
// nunca como se tivesse acabado de ser lido.
import { format } from 'date-fns';
import {
  desatualizado,
  estadoDeLeitura,
  type EstadoLeitura,
  type FatiaDeQuery,
} from '@/lib/leitura/estado-de-leitura';
import { formatBRL, formatDateOrDash } from './format';
import type { CustomerMetrics, Faturamento12m, LeituraKpi } from './viewTypes';

/**
 * `customer_metrics_mv` grava `COALESCE(dias_desde_ultima_compra, 9999)`: 9999 é "nenhuma compra
 * datada NAQUELE consolidado", não uma contagem de dias. Exibido cru, 4.470 de 5.665 clientes (79%,
 * medido 2026-10-01) liam "9999d".
 */
export const DIAS_SEM_COMPRA = 9999;

type Rotulo = { value: string; hint?: string };
type Metricas = NonNullable<CustomerMetrics>;

/**
 * A ponte react-query → faixa, usada pela página para as DUAS fontes. Mapeia pelo estado
 * (`estadoDeLeitura`/`desatualizado`), nunca por `isError && !data`: aquele par colapsava o offline
 * da 1ª carga (`pending` + `paused`, `isError` falso) em "carregando…" para sempre, e o refetch que
 * falha com dado no cache em "lido agora" (parecer Codex de desenho, P1-1).
 */
export function leituraDaQuery<T>(
  q: FatiaDeQuery & { data: T | undefined; dataUpdatedAt: number },
): LeituraKpi<T> {
  if (q.data === undefined) {
    const estado = estadoDeLeitura(q);
    // `pronta` sem dado não acontece (o react-query v5 recusa `undefined` do queryFn). Se acontecer,
    // é leitura que não se pode afirmar: falha, nunca zero.
    return { emMaos: false, motivo: estado === 'pronta' ? 'erro' : estado };
  }
  return { emMaos: true, valor: q.data, desatualizado: desatualizado(q, true), lidoEm: q.dataUpdatedAt };
}

/** Por que um tile está sem valor. `desabilitada` (sem cliente) não ganha aviso: seria alarme fabricado. */
const MOTIVO_SEM_VALOR: Record<Exclude<EstadoLeitura, 'pronta'>, string | undefined> = {
  carregando: 'carregando…',
  erro: 'indisponível',
  'sem-rede': 'sem rede',
  desabilitada: undefined,
};

/** Hora local de um instante — o `dataUpdatedAt` do react-query: quando ESTE navegador leu. */
export function horaDaLeitura(ms: number): string {
  return format(new Date(ms), 'HH:mm');
}

/**
 * Faturamento 12m: o número só aparece LIDO. Lido e não atualizado (o refetch falhou ou ficou sem
 * rede), ele FICA e diz de quando é — e a faixa põe o aviso embaixo (`<AvisoLeituraFalhou>`).
 */
export function rotuloFaturamento12m(l: LeituraKpi<Faturamento12m>): Rotulo {
  if (!l.emMaos) return { value: '—', hint: MOTIVO_SEM_VALOR[l.motivo] };
  const pedidos = `${l.valor.pedidos} pedidos`;
  return {
    value: formatBRL(l.valor.total),
    hint: l.desatualizado ? `${pedidos} · lido às ${horaDaLeitura(l.lidoEm)}` : pedidos,
  };
}

/**
 * Por que um tile da MV está SEM linha — o mesmo motivo nos três tiles. Linha ausente com leitura
 * boa é cliente fora do consolidado (criado depois do último refresh): "—" sem dizer por quê
 * parecia defeito, e o `?? 0` antigo afirmava "não comprou em 90d" sem ter lido nada.
 */
export function motivoSemMetrica(l: LeituraKpi<CustomerMetrics>): string | undefined {
  if (!l.emMaos) return MOTIVO_SEM_VALOR[l.motivo];
  return l.valor ? undefined : 'fora do consolidado';
}

/** Valor de um tile que vem do `customer_metrics_mv`: só com a linha em mãos. */
export function rotuloMetrica(l: LeituraKpi<CustomerMetrics>, ler: (m: Metricas) => string): string {
  if (!l.emMaos || !l.valor) return '—';
  return ler(l.valor);
}

/**
 * Última compra pela MV — o mesmo universo e o mesmo eixo de data do tile "90d". O sentinela é "sem
 * compra NO CONSOLIDADO", não "Nunca": uma 1ª compra importada depois do último refresh já conta no
 * 12m (leitura direta) e ainda não aqui, e "Nunca" ao lado de "12m: R$ 1.000 · 1 pedido" afirmava o
 * contrário do que a faixa acabara de ler (parecer Codex de desenho, P1-2).
 */
export function rotuloUltimaCompra(l: LeituraKpi<CustomerMetrics>): Rotulo {
  if (!l.emMaos || !l.valor) return { value: '—', hint: motivoSemMetrica(l) };
  const { dias_desde_ultima_compra: dias, intervalo_medio_dias: intervalo, ultima_compra_data: data } = l.valor;
  if (dias == null) return { value: '—' };
  if (dias >= DIAS_SEM_COMPRA) return { value: 'Sem compra', hint: 'no consolidado' };
  return {
    value: `${dias}d`,
    hint: intervalo ? `Intervalo médio ~${Math.round(intervalo)}d` : data ? formatDateOrDash(data) : undefined,
  };
}

/**
 * Os DOIS relógios da faixa, declarados: o 12m é leitura direta dos pedidos; 90d, ticket e última
 * compra vêm do consolidado, com a hora do último refresh (`calculated_at` é o `now()` do REFRESH da
 * MV — não o `dataUpdatedAt`, que é quando o navegador leu). Mesmo universo e mesmo eixo não tornam
 * as duas leituras contemporâneas. Sem linha em mãos, não há o que declarar.
 */
export function rotuloConsolidado(l: LeituraKpi<CustomerMetrics>): string | null {
  if (!l.emMaos || !l.valor?.calculated_at) return null;
  const quando = format(new Date(l.valor.calculated_at), "dd/MM 'às' HH:mm");
  return `Faturamento 12m: leitura direta dos pedidos · 90d, ticket médio e última compra: consolidado em ${quando}`;
}
