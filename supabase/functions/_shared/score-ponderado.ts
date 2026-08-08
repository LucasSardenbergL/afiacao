/**
 * Média ponderada que RENORMALIZA o peso do componente não medido, em vez de deixá-lo contribuir 0.
 *
 * Existe como módulo próprio — e não inline no `index.ts` de quem usa — por uma razão medida: a
 * renormalização da margem em `calculate-scores` vivia dentro do laço do `index.ts`, que importa
 * `npm:@supabase/supabase-js`, e `test:edges` roda com `--no-remote`. Ou seja: a única aritmética
 * do repo que decide `priority_score` e `health_score` era estruturalmente inalcançável por teste
 * de comportamento, e só um gate de FONTE a vigiava. Gate de fonte pega a reintrodução do `|| 0`;
 * não pega a renormalização feita errado (dividir pelo denominador cheio, esquecer o clamp,
 * deixar o ausente entrar no máximo). Essas são as falhas que este módulo permite testar de fato.
 *
 * A regra de negócio, em uma frase: **componente sem produtor sai do numerador E do denominador**.
 * Contribuir 0 seria afirmar "pior cliente possível neste eixo" sobre quem apenas não foi medido —
 * a fabricação de número que `docs/agent/money-path.md` §2 proíbe no money-path.
 */

// O helper canônico é `valorMedido` de `src/lib/scoring/margin.ts`; Deno não importa de `src/`, daí
// o espelho VERBATIM abaixo. A paridade textual é pinada por
// `src/__tests__/edge-money-path-invariants.test.ts`, que existe para pegar a reversão do deploy do
// Lovable (o bot já reescreveu edge por cima da main — CLAUDE.md, #1445→#1478).
// MIRROR-START valor-medido — espelhado verbatim de src/lib/scoring/margin.ts
export function valorMedido(raw: unknown): number | null {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (t.length === 0) return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
// MIRROR-END

/** Um eixo do score: o valor já normalizado em 0-100 (ou `null` = não medido) e o peso dele. */
export interface ComponentePonderado {
  /** `null` = sem produtor / não medido. NUNCA use 0 para representar ausência. */
  valor: number | null;
  /** Peso configurado. Não-finito ou ≤ 0 é tratado como componente DESLIGADO (nem numerador nem denominador). */
  peso: number;
}

/**
 * Média ponderada só dos componentes MEDIDOS, dividida pelo peso REALMENTE disponível.
 *
 * `null` quando nenhum componente foi medido (ou todos os pesos estão desligados) — o chamador
 * decide o que fazer com "não sei", e a decisão dele fica visível no call-site em vez de escondida
 * aqui num `?? 0`.
 *
 * ⚠️ A forma errada é sedutora e devolve um número plausível: filtrar o numerador e dividir pelo
 * denominador CHEIO. Isso é aritmeticamente idêntico a deixar o ausente contribuir 0 — o bug que
 * esta função existe para impedir —, e a saída parece perfeitamente razoável (só sistematicamente
 * baixa). Mesma armadilha que `mediaMargensConhecidas` documenta em `src/lib/scoring/margin.ts`:
 * numerador e denominador têm de sair da MESMA lista filtrada.
 */
export function mediaPonderadaRenormalizada(componentes: readonly ComponentePonderado[]): number | null {
  let soma = 0;
  let pesoDisponivel = 0;
  for (const { valor, peso } of componentes) {
    if (valor == null) continue;
    if (!Number.isFinite(peso) || peso <= 0) continue;
    soma += valor * peso;
    pesoDisponivel += peso;
  }
  if (pesoDisponivel <= 0) return null;
  return soma / pesoDisponivel;
}

/**
 * Maior valor MEDIDO da lista, ou `null` se nenhum foi medido.
 *
 * O `Math.max(...xs.map(x => Number(x || 0)), 1)` que este helper substitui erra duas vezes de uma
 * só: faz o desconhecido participar da normalização como se fosse zero (deprimindo o teto e
 * inflando o score relativo de todo mundo) e, quando a coluna inteira é NULL, devolve o piso `1`
 * — um teto FABRICADO, contra o qual todo cliente pontua 0.
 */
export function maximoMedido(valores: Iterable<unknown>): number | null {
  let max: number | null = null;
  for (const bruto of valores) {
    const v = valorMedido(bruto);
    if (v == null) continue;
    if (max == null || v > max) max = v;
  }
  return max;
}

/**
 * Posição relativa de `valor` contra `max`, em 0-100, ou `null` se qualquer um dos dois for ausente.
 *
 * `max <= 0` devolve 0 e não `null`: aí todos os valores medidos são zero ou negativos, o que é um
 * VEREDITO ("ninguém tem potencial") e não ausência de dado. Distinguir os dois é a regra inteira.
 * O clamp mantém o eixo em 0-100 mesmo com valor negativo medido — piso, nunca negativo, senão um
 * único cliente no prejuízo arrastaria o score composto para baixo do zero.
 */
export function normalizarPorMaximo(valor: number | null, max: number | null): number | null {
  if (valor == null || max == null) return null;
  if (max <= 0) return 0;
  return Math.max(0, Math.min(100, (valor / max) * 100));
}
