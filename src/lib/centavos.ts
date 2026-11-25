/**
 * Centavos no front — a MESMA conta do `round(q × v, 2)` por linha do gate de crédito (SQL `numeric`):
 * half-up na 2ª casa sobre o DECIMAL EXATO do número como ele vai no JSON (`String(x)`, a representação
 * mais curta). A conta é em inteiros (BigInt), então não há ponto flutuante no meio:
 *   - `1,005` → 1,01 (`Math.round(1.005 * 100)` daria 1,00);
 *   - `1,5 × 2,01` → 3,02 (em float o produto é 3,0149999999999997);
 *   - `1,0229 × 1,080262` = 1,1049999998 → 1,10 (ler N casas fixas arredondava duas vezes para 1,11 —
 *     Codex #4164, rodadas 2 e 3: qualquer N fixo tem um caso assim; o decimal exato não tem).
 *
 * Decisão do founder (2026-11-24, PR 2.4): o preço unitário do produto vive em centavos (inclusive o último
 * praticado que o Omie devolve com 3-4 casas) e o total do pedido é a SOMA DAS LINHAS já arredondadas — como
 * o Omie e o gate de crédito calculam. Tint NÃO passa por aqui: já nasce em centavos pela regra própria
 * (`lib/tint`), e arredondar de novo divergiria 1 centavo em x,xx5.
 *
 * Ausente ≠ zero: entrada não finita devolve NaN (o `priceGuard` barra o envio), nunca 0.
 * (A edge `omie-vendas-sync/revisao-credito.ts` ainda lê 6 casas fixas — follow-up de edge.)
 */

/** Decimal exato de `String(x)`: valor = m × 10^-e. Não finito → null. */
function decimalDe(x: number): { m: bigint; e: number } | null {
  if (!Number.isFinite(x)) return null;
  const [base, expoente] = String(x).toLowerCase().split('e');
  const negativo = base.startsWith('-');
  const [inteiro, frac = ''] = (negativo ? base.slice(1) : base).split('.');
  let m = BigInt(inteiro + frac);
  let e = frac.length - (expoente ? Number(expoente) : 0);
  if (e < 0) { m *= 10n ** BigInt(-e); e = 0; }
  return { m: negativo ? -m : m, e };
}

/** Centavos inteiros de um decimal exato, half-up (meio para longe do zero, como o `round` do Postgres). */
function centavosDoDecimal(m: bigint, e: number): number {
  if (e <= 2) return Number(m * 10n ** BigInt(2 - e));
  const divisor = 10n ** BigInt(e - 2);
  const abs = m < 0n ? -m : m;
  let q = abs / divisor;
  if ((abs % divisor) * 2n >= divisor) q += 1n;
  return Number(m < 0n ? -q : q);
}

/** Inteiro de centavos, half-up (negativo espelhado). Não finito → NaN. */
export function centavos(x: number): number {
  const d = decimalDe(x);
  return d ? centavosDoDecimal(d.m, d.e) : Number.NaN;
}

/** Centavos inteiros do produto EXATO a × b (sem passar pelo float de `a * b`). Não finito → NaN. */
function centavosDoProduto(a: number, b: number): number {
  const da = decimalDe(a);
  const db = decimalDe(b);
  return da && db ? centavosDoDecimal(da.m * db.m, da.e + db.e) : Number.NaN;
}

/** Valor em reais arredondado ao centavo (half-up). Não finito → NaN. */
export function emCentavos(x: number): number {
  const c = centavos(x);
  return Number.isNaN(c) ? Number.NaN : c / 100;
}

/** Total de UMA linha: quantidade × unitário, no produto exato, arredondado ao centavo. Também serve para
 *  tabela × multiplicador no nascimento do preço. */
export function totalDaLinha(quantidade: number, unitario: number): number {
  const c = centavosDoProduto(quantidade, unitario);
  return Number.isNaN(c) ? Number.NaN : c / 100;
}

/**
 * Soma por linha: cada linha é `[quantidade, unitário]`, arredondada no produto exato, somada em centavos
 * inteiros. Recebe o PAR (não o produto já multiplicado) justamente para não passar pelo float de `q * v`.
 */
export function somaPorLinha<T>(itens: ReadonlyArray<T>, linha: (item: T) => readonly [number, number]): number {
  let total = 0;
  for (const it of itens) {
    const [q, v] = linha(it);
    total += centavosDoProduto(q, v);
  }
  return total / 100;
}

/**
 * Centavo ACIMA (teto): o 1º centavo que não fica abaixo de `x`. Para PISO — "aplicar piso" de 11,2148
 * tem de gravar 11,22; o half-up daria 11,21, abaixo do piso (Codex no #4164). Não finito → NaN.
 */
export function centavoAcima(x: number): number {
  const c = centavos(x);
  if (Number.isNaN(c)) return Number.NaN;
  return (c / 100 < x - 1e-9 ? c + 1 : c) / 100;
}

/**
 * Soma de quantidades sem resíduo binário: `1,2 + 1,9` dá 3,0999999999999996 em ponto flutuante, que vai
 * cru no JSON e faz o `round(numeric, 2)` do gate de crédito divergir 1 centavo da tela (Codex no #4164).
 * 6 casas cobrem qualquer quantidade do Omie (que usa até 4).
 */
export function somarQuantidade(a: number, b: number): number {
  const s = a + b;
  return Number.isFinite(s) ? Number(s.toFixed(6)) : s;
}
