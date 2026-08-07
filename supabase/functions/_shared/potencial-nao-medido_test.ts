// Gate de REGRESSÃO: `farmer_client_scores.expansion_score` e `revenue_potential` não são
// coagidos a 0 no caminho que alimenta o prompt da IA.
//
// POR QUE UM GATE DE FONTE, e não só teste de comportamento: a montagem do `customerContext`
// mora no `index.ts` da edge, que importa `npm:@anthropic-ai/sdk` e `npm:@supabase/supabase-js`
// — `test:edges` roda com `--no-remote` e não resolve nenhum dos dois, então o wiring é
// estruturalmente inalcançável por teste de comportamento. O helper `numeroValido` já era
// testado quando o `num = (v) => Number(v ?? 0)` foi escrito ao lado dele; o defeito não estava
// no helper, estava em NÃO CHAMÁ-LO (docs/agent/money-path.md §7 — consertar o helper não
// conserta o call-site).
//
// O DADO que torna isto money-path, medido em prod via psql-ro em 2026-07-29:
//   revenue_potential → 6.633 NULL / 0 zeros / 0 positivos de 6.633   (column_default removido)
//   expansion_score   → 6.633 NULL / 0 zeros / 0 positivos de 6.633   (column_default removido)
// A migration 20260727130000_farmer_scores_colunas_orfas_null nulou as duas de propósito
// (nenhum writer as calcula). Com `?? 0` / `|| 0` o prompt recebia "revenuePotential: 0" para
// 100% da base — e o system prompt manda a IA ler número como MEDIDO.
//
// Falsificado: reintroduzir a coerção em qualquer um dos dois arquivos deixa este teste
// VERMELHO nomeando arquivo, linha e o trecho ofensor.

// Sem import remoto (`--no-remote`) — padrão do repo, ver _shared/escrita-critica_test.ts.
function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(msg ?? `assertEquals falhou: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  }
}

/**
 * Neutraliza comentário antes do predicado. Sem isto o gate mede PROSA: os dois arquivos
 * vigiados EXPLICAM em comentário por que não coagem estes campos (citando o `?? 0` que
 * removeram), e essa frase dispararia o teste com o código íntegro. É o `stripComments` que o
 * money-path.md §"O ALVO mente" exige de todo assert sobre texto — lá o falso-VERDE veio de um
 * comentário escrito pela própria migration sob teste.
 */
function semComentario(linha: string): string {
  const t = linha.trim();
  if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return "";
  return linha.replace(/\/\/.*$/, "");
}

/** As duas colunas sem writer. Nomes em snake_case (como saem do banco) e camelCase (front). */
const CAMPOS = ["expansion_score", "revenue_potential"];

/**
 * Coerção a zero aplicada a um dos campos. Ancorado no NOME da coluna e não na forma do
 * fallback: `Number(x ?? 0)`, `Number(x || 0)`, `num(x)` e `x ?? 0` são a mesma fabricação, e
 * uma regex por forma vira corrida entre o gate e a criatividade de quem escreve
 * (money-path.md §"O GATE mente quando a regex não conhece a forma REAL do repo").
 *
 * `[^;\n]{0,80}?` aceita cast e parênteses no meio (`(score.revenue_potential as number) || 0`)
 * sem atravessar statement — a forma que o formatador automático produz e que já enganou o G4.
 */
function coercoesEmLinha(codigo: string): string[] {
  const achados: string[] = [];
  for (const campo of CAMPOS) {
    const padrao = new RegExp(`${campo}[^;\\n]{0,80}?(\\?\\?|\\|\\|)\\s*0`, "g");
    for (const m of codigo.matchAll(padrao)) achados.push(m[0]);
  }
  return achados;
}

/**
 * O `num()` da edge é um alias LOCAL de `Number(v ?? 0)` — aplicá-lo a um dos campos coage
 * sem que nenhum `?? 0` apareça na linha. O predicado acima não o pegaria.
 */
function numAplicadoACampo(codigo: string): string[] {
  const achados: string[] = [];
  for (const campo of CAMPOS) {
    for (const m of codigo.matchAll(new RegExp(`\\bnum\\s*\\([^)]*${campo}`, "g"))) achados.push(m[0]);
  }
  return achados;
}

// Só edges: `test:edges` roda com `--allow-read=supabase/functions` e não enxerga `src/`.
// O caminho do FRONT monta o MESMO customerContext e chama a MESMA edge — corrigir um lado
// só deixaria a fabricação viva pela outra porta —, e por isso tem gate irmão em vitest:
// `src/__tests__/potencial-nao-medido-gate.test.ts`. Os dois se complementam; nenhum
// substitui o outro (mesmo arranjo de escrita-critica: contrato em Deno, call-sites no CI do src).
const VIGIADOS: Array<{ rotulo: string; url: URL }> = [
  {
    rotulo: "generate-tactical-plan/index.ts",
    url: new URL("../generate-tactical-plan/index.ts", import.meta.url),
  },
  {
    rotulo: "visit-score-recalc-client/index.ts",
    url: new URL("../visit-score-recalc-client/index.ts", import.meta.url),
  },
  {
    rotulo: "tactical-plans-batch/index.ts",
    url: new URL("../tactical-plans-batch/index.ts", import.meta.url),
  },
];

Deno.test("expansion_score/revenue_potential não são coagidos a 0 antes do prompt", async () => {
  const ofensas: string[] = [];

  for (const { rotulo, url } of VIGIADOS) {
    const fonte = await Deno.readTextFile(url);
    fonte.split("\n").forEach((linha, i) => {
      const codigo = semComentario(linha);
      for (const trecho of [...coercoesEmLinha(codigo), ...numAplicadoACampo(codigo)]) {
        ofensas.push(`${rotulo}:${i + 1}: ${trecho.trim()}`);
      }
    });
  }

  assertEquals(
    ofensas,
    [],
    `Campo sem writer coagido a 0 no caminho do prompt da IA — "ausente != zero"\n` +
      `(revenue_potential e expansion_score sao NULL em 6.633/6.633 linhas em prod).\n` +
      `Use numeroValido (edge) ou valorMedido (src/lib/scoring/margin.ts):\n  ` +
      ofensas.join("\n  "),
  );
});

// Prefixo ASCII "[POT-DET]" para a falsificação ancorar com `grep -F` — nome acentuado não
// serve de âncora (o `grep` do shell é shim para ugrep, que dobra acento em todo locale).
Deno.test("[POT-DET] o DETECTOR enxerga a coerção quando ela existe (par obrigatório)", () => {
  // Sem este teste, "nenhuma ofensa" e "o predicado está quebrado" têm o mesmo output — e um
  // gate que nunca casa nada é uma tautologia verde (money-path.md §"O DETECTOR mente": um
  // assert de existência precisa provar que enxerga o objeto VIVO).
  const formasReais = [
    "const revenuePotential = Number(score.revenue_potential || 0);",
    "expansionPotential: Number(score.expansion_score ?? 0),",
    "revenue_potential: (score.revenue_potential as number) || 0,",
    "expansionPotential: num(score.expansion_score),",
    "revenuePotential: num(score.revenue_potential), salesHistoryStatus };",
  ];
  for (const forma of formasReais) {
    const pegou = coercoesEmLinha(forma).length + numAplicadoACampo(forma).length;
    assertEquals(pegou > 0, true, `o detector NÃO pegou uma coerção real: ${forma}`);
  }

  // E o controle negativo: o código pós-fix não pode casar, senão o gate reprova o correto.
  const formasCorretas = [
    "const revenuePotential = valorMedido(score.revenue_potential);",
    "const expansionPotential = numeroValido(score.expansion_score);",
    "expansionPotential: valorMedido(d.expansion_potential),",
  ];
  for (const forma of formasCorretas) {
    const pegou = coercoesEmLinha(forma).length + numAplicadoACampo(forma).length;
    assertEquals(pegou, 0, `falso-VERMELHO: o detector acusou código correto: ${forma}`);
  }
});

Deno.test("comentário que cita o bug não dispara o gate", () => {
  // O falso-VERMELHO que a falsificação do gate irmão (paginacao-delegada) pegou: os arquivos
  // vigiados documentam o `?? 0` que removeram, e sem semComentario o gate mede a explicação.
  const prosa = "      // Com `num()` elas chegavam como revenue_potential ?? 0 para 100% da base";
  assertEquals(semComentario(prosa), "");
  assertEquals(coercoesEmLinha(semComentario(prosa)).length, 0);
});
