/**
 * Risco de churn utilizável, ou `null` se desconhecido.
 *
 * Irmão de `margemConhecida` (`./margin`), pela mesma razão e com a mesma semântica — mas com uma
 * diferença que importa: hoje ele é **defesa, não correção de sintoma**.
 * `farmer_client_scores.churn_risk` medido em prod (2026-07-22) está 100% preenchido
 * (6.633/6.633 linhas, mín. 33, máx. 100, média 96,0; zero nulos e zero zeros), então nenhuma
 * coação dispara. O helper existe porque a coluna tem `column_default = 0` e `is_nullable = YES`:
 * a ausência é estruturalmente possível, e a hora de decidir o que ela significa é antes de ela
 * acontecer. Foi essa a lição do `gross_margin_pct` — ele também era constante até o dia em que
 * o produtor mudou e 84% da base virou NULL (#1495/#1498).
 *
 * ⚠️ `0` é CONHECIDO: é o veredito "cliente sem risco de churn", o melhor resultado possível.
 * Confundi-lo com ausência é o erro que este helper impede — e é por isso que `|| ` não serve:
 * `churn_risk || 100` transformava o cliente de risco ZERO no de risco MÁXIMO (corrigido para
 * `?? 100` no #1561, que é a leitura certa para um KPI que não quer premiar dado faltante).
 *
 * ⚠️ Em comparação relacional o guard é obrigatório: `null < 30` é `true` em JS (null coage a 0),
 * então `if (churn < 30)` sem checar null classifica como "risco baixo" justamente quem não foi
 * medido — a mesma armadilha que `margemConhecida` documenta para margem.
 */
export function churnConhecido(raw: unknown): number | null {
  if (raw == null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Proporção de clientes com risco de churn ABAIXO de `limite`, contada só sobre quem tem risco
 * conhecido.
 *
 * Existe como função própria porque a forma errada é sedutora e foi a que estava no código:
 * filtrar o numerador (empurrando o desconhecido para fora dos "bons") e dividir pelo total
 * INCLUINDO os desconhecidos. O resultado é um número plausível e sistematicamente baixo — pior
 * que um erro visível, porque não parece errado. Aqui numerador e denominador saem da MESMA
 * lista filtrada.
 */
export interface ProporcaoChurnBaixo {
  /** Clientes com risco conhecido E abaixo do limite. */
  abaixo: number;
  /** Clientes com risco CONHECIDO (a base honesta da proporção; 0 conta, ausente não). */
  comRisco: number;
}

export function proporcaoChurnBaixo(valores: Iterable<unknown>, limite: number): ProporcaoChurnBaixo {
  let abaixo = 0;
  let comRisco = 0;
  for (const v of valores) {
    const c = churnConhecido(v);
    if (c == null) continue;
    comRisco++;
    if (c < limite) abaixo++;
  }
  return { abaixo, comRisco };
}
