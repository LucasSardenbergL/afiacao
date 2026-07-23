// Testa o CÓDIGO REAL de tactical-margem.ts (não uma cópia) no runtime real (Deno).
// Roda com: deno test --no-remote supabase/functions/_shared/tactical-margem_test.ts
//
// Espelha os oráculos vitest do front:
//   src/lib/tactical/pregeracao.ts        (gate de R$/h + seleção top-N)
//   src/lib/scoring/objective.ts          (selectObjective)
//   src/hooks/useTacticalPlan.ts:404-418  (cluster = média dos PARES com margem conhecida)
import {
  avaliarCanariaMargem,
  calcularClusterMargin,
  classifyProfile,
  margemConhecida,
  profitPerHora,
  PROFIT_PER_HOUR_THRESHOLD,
  selecionarParaPregeracao,
  selectObjective,
} from "./tactical-margem.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(msg ?? `assertEquals falhou: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  }
}
function assertClose(a: number | null, b: number, msg?: string) {
  if (a == null || Math.abs(a - b) > 1e-9) {
    throw new Error(msg ?? `assertClose falhou: ${a} !== ${b}`);
  }
}

// ── margemConhecida: a fronteira ausente/conhecido ────────────────────────────
Deno.test("margemConhecida: null/undefined → null", () => {
  assertEquals(margemConhecida(null), null);
  assertEquals(margemConhecida(undefined), null);
});

Deno.test("margemConhecida: 0 é CONHECIDO (fato), não ausente", () => {
  assertEquals(margemConhecida(0), 0);
});

Deno.test("margemConhecida: NaN/Infinity → null (não-finito não é fato)", () => {
  assertEquals(margemConhecida(NaN), null);
  assertEquals(margemConhecida(Infinity), null);
});

// ── profitPerHora: o gate de R$/h ────────────────────────────────────────────
Deno.test("profitPerHora: paridade numérica com o oráculo vitest", () => {
  // (1000 * 30% * 0.1) / (15/60) = 120
  assertClose(profitPerHora(1000, 50, 30), 120);
  // revenue 0 → cai pra avgSpend: (500 * 20% * 0.1) / 0.25 = 40
  assertClose(profitPerHora(0, 500, 20), 40);
});

Deno.test("profitPerHora: margem DESCONHECIDA → null, não 0", () => {
  // Number(null) === 0 fabricaria "R$ 0/h" — veredito de negócio, não "não sei".
  assertEquals(profitPerHora(1000, 50, null), null);
});

Deno.test("profitPerHora: margem 0 conhecida → 0 (reprova o gate por MÉRITO)", () => {
  assertEquals(profitPerHora(1000, 50, 0), 0);
});

// ── selecionarParaPregeracao: indecidível ≠ reprovado ────────────────────────
const linha = (id: string, priority: number, rev: number, m: number | null) => ({
  customer: id,
  priority,
  rev,
  avg: 0,
  marginPct: m,
});

Deno.test("selecao: ordena por priority desc, filtra o gate ANTES de cortar topN", () => {
  const scores = [
    linha("a", 90, 100, 10), // pph 4 ✗
    linha("b", 80, 2000, 25), // pph 200 ✓
    linha("c", 70, 1000, 30), // pph 120 ✓
  ];
  const { selecionados } = selecionarParaPregeracao(scores, 2);
  assertEquals(selecionados.map((s) => s.customer), ["b", "c"]);
});

Deno.test("selecao: margem desconhecida NÃO entra em selecionados", () => {
  const { selecionados } = selecionarParaPregeracao([linha("x", 99, 100000, null)], 25);
  assertEquals(selecionados.length, 0);
});

Deno.test("selecao: margem desconhecida é CONTABILIZADA em semMargem (no silent caps)", () => {
  const scores = [linha("conhecido", 90, 1000, 30), linha("ausente", 95, 1000, null)];
  const { selecionados, semMargem } = selecionarParaPregeracao(scores, 25);
  assertEquals(selecionados.map((s) => s.customer), ["conhecido"]);
  assertEquals(semMargem.map((s) => s.customer), ["ausente"]);
});

Deno.test("selecao: margem 0 conhecida reprova o gate mas NÃO é semMargem", () => {
  // O ponto da correção: hoje ambos viram "0" e ficam indistinguíveis.
  const scores = [linha("zero-real", 90, 1000, 0), linha("ausente", 80, 1000, null)];
  const { selecionados, semMargem } = selecionarParaPregeracao(scores, 25);
  assertEquals(selecionados.length, 0);
  assertEquals(semMargem.map((s) => s.customer), ["ausente"]);
});

Deno.test("selecao: threshold é 50 R$/h (paridade com o front)", () => {
  assertEquals(PROFIT_PER_HOUR_THRESHOLD, 50);
});

// ── calcularClusterMargin: o baseline de comparação ──────────────────────────
Deno.test("cluster: média SÓ dos pares com margem conhecida", () => {
  const peers = [{ gross_margin_pct: 20 }, { gross_margin_pct: 40 }];
  assertClose(calcularClusterMargin(peers), 30);
});

Deno.test("cluster: pares SEM margem são EXCLUÍDOS, não contados como 0", () => {
  // Com 20, 40 e um ausente: média dos conhecidos = 30. Contar o ausente como 0
  // daria 20 e rebaixaria o baseline — margem fabricada virando régua.
  const peers = [{ gross_margin_pct: 20 }, { gross_margin_pct: 40 }, { gross_margin_pct: null }];
  assertClose(calcularClusterMargin(peers), 30);
});

Deno.test("cluster: NENHUM par com margem → null (NUNCA o 25 mágico)", () => {
  assertEquals(calcularClusterMargin([{ gross_margin_pct: null }]), null);
});

Deno.test("cluster: carteira vazia → null", () => {
  assertEquals(calcularClusterMargin([]), null);
  assertEquals(calcularClusterMargin(null), null);
});

Deno.test("cluster: pares com margem 0 CONHECIDA contam (média 0, e é um fato)", () => {
  assertClose(calcularClusterMargin([{ gross_margin_pct: 0 }, { gross_margin_pct: 0 }]), 0);
});

// ── selectObjective: espelho do oráculo, com o guard de ausência ─────────────
Deno.test("objective: sem_historico PRECEDE tudo", () => {
  assertEquals(selectObjective(99, 9, 5, 50, 999, 180, "sem_historico"), "ativacao");
});

Deno.test("objective: dormência >= teto → reativacao", () => {
  assertEquals(selectObjective(10, 0, 30, 40, 180, 180, null), "reativacao");
});

Deno.test("objective: churn > 60 → recuperacao", () => {
  assertEquals(selectObjective(61, 0, 30, 40, 10, 180, null), "recuperacao");
});

Deno.test("objective: mixGap > 3 → expansao_mix", () => {
  assertEquals(selectObjective(10, 4, 30, 40, 10, 180, null), "expansao_mix");
});

Deno.test("objective: margem abaixo de 80% do cluster → consolidacao_margem", () => {
  // 30 < 40*0.8 = 32 ✓
  assertEquals(selectObjective(10, 0, 30, 40, 10, 180, null), "consolidacao_margem");
});

Deno.test("objective: cluster AUSENTE → NÃO dispara consolidacao_margem", () => {
  // Era aqui que o 25 mágico agia: com cluster=25, margem 15 < 20 empurrava
  // consolidacao_margem a esmo, sem nenhum par real para comparar.
  assertEquals(selectObjective(10, 0, 15, null, 10, 180, null), "upsell_premium");
});

Deno.test("objective: margem do CLIENTE ausente → NÃO dispara consolidacao_margem", () => {
  // Não se afirma "margem baixa vs. pares" sem saber a margem do cliente.
  assertEquals(selectObjective(10, 0, null, 40, 10, 180, null), "upsell_premium");
});

// ── classifyProfile: os dois ramos que dependem de margem ───────────────────
Deno.test("profile: paridade com o oráculo quando a margem é CONHECIDA", () => {
  assertEquals(classifyProfile(50, 400, 10, 5), "sensivel_preco");
  assertEquals(classifyProfile(50, 1000, 40, 3), "orientado_qualidade");
  assertEquals(classifyProfile(70, 3000, 25, 5), "orientado_produtividade");
  assertEquals(classifyProfile(50, 1000, 25, 5), "misto");
});

Deno.test("profile: margem AUSENTE não vira 'sensivel_preco' (null < 20 é true em JS!)", () => {
  // A armadilha: `null < 20` coage a `0 < 20` → true. Sem guard, todo cliente de gasto
  // baixo e margem desconhecida seria rotulado "sensível a preço" — um diagnóstico
  // comercial fabricado a partir de ausência de dado.
  assertEquals(classifyProfile(50, 400, null, 5), "misto");
});

Deno.test("profile: margem AUSENTE não vira 'orientado_qualidade'", () => {
  assertEquals(classifyProfile(50, 1000, null, 3), "misto");
});

Deno.test("profile: margem ausente ainda permite o ramo que NÃO usa margem", () => {
  // orientado_produtividade não depende de margem — segue decidível.
  assertEquals(classifyProfile(70, 3000, null, 5), "orientado_produtividade");
});

// ── Canária comportamental (#1498): a prova de DEPLOY que a edge expõe via {canary:true} ─────
Deno.test("canária: todos os casos passam sobre o helper CORRETO (baseline verde)", () => {
  const { ok, resultados } = avaliarCanariaMargem();
  assertEquals(ok, true);
  assertEquals(resultados.length, 5);
  assertEquals(resultados.every((r) => r.ok), true);
});

Deno.test("canária: cada caso mira uma fabricação distinta do #1498", () => {
  // Os nomes são o contrato lido pelo verificador pós-deploy — se um sumir, a cobertura mudou.
  const nomes = avaliarCanariaMargem().resultados.map((r) => r.nome).sort();
  assertEquals(nomes, [
    "cluster_sem_pares_e_null",
    "margem_ausente_nao_vira_zero",
    "objetivo_sem_margem_nao_consolida",
    "perfil_nao_fabrica_sensivel_preco",
    "zero_e_conhecido",
  ]);
});

Deno.test("canária: o `expected` de cada caso DIFERE do que o código antigo daria", () => {
  // Uma canária cujo esperado casa com o código velho não prova deploy nenhum. Estes são
  // exatamente os valores que o #1498 mudou — o que o código ANTIGO produziria está ao lado.
  const r = avaliarCanariaMargem().resultados;
  const by = (n: string) => r.find((x) => x.nome === n)!;
  assertEquals(by("margem_ausente_nao_vira_zero").expected, null);        // antigo: 0
  assertEquals(by("cluster_sem_pares_e_null").expected, null);            // antigo: 25
  assertEquals(by("perfil_nao_fabrica_sensivel_preco").expected, "misto"); // antigo: "sensivel_preco"
  assertEquals(by("objetivo_sem_margem_nao_consolida").expected, "upsell_premium"); // antigo: consolidacao_margem (se cluster contava)
  // zero_e_conhecido guarda o outro lado: margem 0 REAL não pode ser confundida com ausência.
  assertEquals(by("zero_e_conhecido").got, 0);
});
