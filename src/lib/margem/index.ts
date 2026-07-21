// Consumo honesto de `farmer_client_scores.gross_margin_pct` no front.
//
// ESPELHO SEMÂNTICO de `supabase/functions/_shared/tactical-margem.ts` (Deno não importa de
// `src/`) — mudou a semântica de ausência aqui, mude lá.
//
// PRINCÍPIO (money-path, "ausente ≠ zero"): margem desconhecida degrada para `null` e o
// consumidor EXCLUI o cliente do cálculo. Nunca 0 — `0` é o VEREDITO de negócio "cliente
// não-lucrativo", e afirmá-lo sobre quem não tem custo conhecido é fabricar diagnóstico.
//
// ESCALA: PERCENTUAL 0-100 (56 = 56%). Não é fração. O produtor (#1495) grava assim — o
// harness PG17 dele afirma `gross_margin_pct = "56.00"` para margem de 56%, e preserva
// negativo ("-60.00") quando o cliente foi vendido no prejuízo. Havia consumidor comparando
// contra `0.3`/`0.15` e multiplicando por 100; enquanto a coluna era `0` em 6.632/6.632
// linhas o erro era invisível, e o #1495 o ativaria.

/** Fronteira "margem alta" em pontos percentuais. Era `>= 0.3` em CustomerHero (fração). */
export const MARGEM_ALTA_PCT = 30;
/** Fronteira "margem média" em pontos percentuais. Era `>= 0.15` em CustomerHero (fração). */
export const MARGEM_MEDIA_PCT = 15;

export type FaixaMargem = 'alta' | 'media' | 'baixa' | 'desconhecida';

/** Margem utilizável, ou `null` se desconhecida.
 *
 *  ⚠️ `0` é CONHECIDO (margem nula real); só ausência/não-finito/não-numérico viram null.
 *
 *  Mais estrito que o espelho do edge de propósito: `Number('')`, `Number(' ')`,
 *  `Number(false)` e `Number([])` são todos `0`, então um `Number(raw)` solto fabricaria
 *  exatamente o veredito que este módulo existe para impedir. `numeric` do Postgres não
 *  produz esses valores — é defesa em profundidade, não bug medido —, mas o tipo declarado
 *  nos hooks é `number | string | null` e barrar custa uma linha. */
export function margemConhecida(raw: unknown): number | null {
  if (raw == null) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'string') {
    const texto = raw.trim();
    if (texto === '') return null;
    const n = Number(texto);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Média das margens CONHECIDAS, com a cobertura que a produziu.
 *
 *  O desconhecido sai do numerador E do denominador. Trocar ausente por 0 antes de dividir
 *  não "aproxima" a média — puxa-a para baixo na proporção exata da ignorância, e o número
 *  resultante é indistinguível de um KPI legítimo.
 *
 *  `comMargem`/`total` NÃO são decorativos: pós-#1495, ~84% da base fica sem margem, então
 *  a média representa uma fatia pequena e o chamador DEVE dizer isso na tela (money-path:
 *  no silent caps). Nenhuma margem conhecida → `media: null`, jamais 0 nem NaN de 0/0. */
export function mediaMargemConhecida(valores: readonly unknown[]): {
  media: number | null;
  comMargem: number;
  total: number;
} {
  const conhecidas: number[] = [];
  for (const valor of valores) {
    const m = margemConhecida(valor);
    if (m != null) conhecidas.push(m);
  }
  const total = valores.length;
  if (conhecidas.length === 0) return { media: null, comMargem: 0, total };
  return {
    media: conhecidas.reduce((soma, m) => soma + m, 0) / conhecidas.length,
    comMargem: conhecidas.length,
    total,
  };
}

/** Legenda de cobertura para acompanhar uma média de margem na tela.
 *
 *  Uma média que representa 16% da base e uma que representa 100% são números diferentes
 *  disfarçados do mesmo jeito. Enquanto a fatia coberta não estiver escrita ao lado do KPI,
 *  quem lê assume "todos os clientes" — que é a leitura errada pós-#1495. */
export function legendaCobertura(comMargem: number, total: number): string {
  if (total === 0) return 'sem clientes';
  if (comMargem === 0) return 'nenhum cliente c/ margem conhecida';
  const cobertos = comMargem.toLocaleString('pt-BR');
  if (comMargem === total) return `${cobertos} clientes c/ margem`;
  return `parcial — ${cobertos} de ${total.toLocaleString('pt-BR')} clientes c/ margem`;
}

/** Faixa semântica da margem, em PERCENTUAL 0-100.
 *
 *  Ausência tem faixa PRÓPRIA (`desconhecida`) em vez de cair na mais baixa: pintar de
 *  vermelho quem não foi medido afirma "margem ruim" com a mesma confiança de quem foi. */
export function faixaMargem(raw: unknown): FaixaMargem {
  const m = margemConhecida(raw);
  if (m == null) return 'desconhecida';
  if (m >= MARGEM_ALTA_PCT) return 'alta';
  if (m >= MARGEM_MEDIA_PCT) return 'media';
  return 'baixa';
}

/** Margem para exibição: `"56%"` / `"0,5%"` / `"—"` quando desconhecida.
 *
 *  Sem heurística de escala. `formatPctMaybe` (customer360/format.ts) adivinha a unidade com
 *  `v > 1 ? v : v * 100`, o que quebra nos dois extremos que o #1495 torna alcançáveis:
 *  0,5% viraria "50%" e -60% viraria "-6000%". Aqui a unidade é contrato, não palpite. */
export function formatarMargemPct(raw: unknown): string {
  const m = margemConhecida(raw);
  if (m == null) return '—';
  const arredondado = Math.round(m);
  if (Math.abs(m - arredondado) < 0.05) return `${arredondado}%`;
  return `${m.toFixed(1).replace('.', ',')}%`;
}
