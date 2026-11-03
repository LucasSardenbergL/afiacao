/**
 * KPIs do topo de /financeiro/gestao (Total a Receber · Total a Pagar · Inadimplência %).
 *
 * Ausente ≠ zero: a versão anterior descartava o `error` da leitura do aging e fazia
 * `if (!data) return 0`, e os cards faziam `Number(x ?? 0)` — falha de RLS, rede ou timeout
 * virava "0,0%" de inadimplência com borda neutra, e "R$ 0,00" a receber/pagar enquanto a
 * query ainda carregava. Aqui os três estados chegam DISTINTOS até a renderização:
 * carregando (skeleton), erro/ausente ("—") e valor observado (inclusive o zero real).
 */

export type EstadoKpi =
  | { tipo: "carregando" }
  | { tipo: "erro" }
  | { tipo: "ausente" }
  | { tipo: "ok"; valor: number };

/** Recorte do `useQuery` que decide o estado — sem depender do objeto inteiro. */
export interface QueryKpi {
  isPending: boolean;
  isError: boolean;
  data: number | null | undefined;
}

export function estadoDoKpi(q: QueryKpi): EstadoKpi {
  // Erro primeiro: com `retry`, o refetch que falha mantém o `data` velho — mas o card
  // de gestão não sabe dizer de quando ele é, então erro vence.
  if (q.isError) return { tipo: "erro" };
  if (q.isPending) return { tipo: "carregando" };
  if (q.data === null || q.data === undefined || !Number.isFinite(q.data)) return { tipo: "ausente" };
  return { tipo: "ok", valor: q.data };
}

/** Linha de `fin_aging_receber` — só as colunas de valor que o KPI usa. */
export interface AgingReceberValores {
  a_vencer_valor: number | null;
  vencido_1_30_valor: number | null;
  vencido_31_60_valor: number | null;
  vencido_61_90_valor: number | null;
  vencido_90_plus_valor: number | null;
}

/**
 * % vencido sobre o total em aberto, ou `null` quando não há como saber.
 *
 * - Sem linha para a empresa → `null` (não há carteira observada; não é "0% inadimplente").
 * - Qualquer faixa `null` → `null`: hoje a view faz COALESCE(sum, 0) e isso é inerte, mas
 *   somar `?? 0` aqui seria fabricar a faixa que faltou.
 * - Total zero → `null`: 0/0 não é 0%.
 * - Vencido zero com total > 0 → `0` — o zero REAL, que a tela mostra como "0,0%".
 */
export function inadimplenciaPct(row: AgingReceberValores | null | undefined): number | null {
  if (!row) return null;
  const faixas = [
    row.vencido_1_30_valor,
    row.vencido_31_60_valor,
    row.vencido_61_90_valor,
    row.vencido_90_plus_valor,
  ];
  const valores = [...faixas, row.a_vencer_valor].map((v) => (v === null || v === undefined ? NaN : Number(v)));
  if (valores.some((v) => !Number.isFinite(v))) return null;
  const vencido = valores.slice(0, 4).reduce((s, v) => s + v, 0);
  const total = vencido + valores[4];
  if (total <= 0) return null;
  return (vencido / total) * 100;
}

const BRL = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const PCT = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

export const formatarKpiBRL = (v: number): string => BRL.format(v);
export const formatarKpiPct = (v: number): string => `${PCT.format(v)}%`;

/** Acima disto o card de inadimplência fica em alerta — só com valor OBSERVADO. */
export const LIMIAR_INADIMPLENCIA_PCT = 5;
