// Testes de COMPORTAMENTO da frequência de recompra de `calculate-scores` (Venda por cliente, 1a).
// Sem import remoto: `test:edges` roda com `--no-remote`.

import {
  classeSaude,
  componenteRecompra,
  intervaloRecompraConhecido,
  scoreFrequencia,
} from "./frequencia-recompra.ts";
import { maximoMedido, mediaPonderadaRenormalizada } from "./score-ponderado.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(msg ?? `assertEquals falhou: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  }
}

const HS = { recency: 0.25, frequency: 0.20, margin: 0.20, diversity: 0.15, crosssell: 0.10, engagement: 0.10 };
const BASE = [1958, 20, null, 0, 30];

function classe(intervalo: unknown): string {
  const max = maximoMedido(BASE.map(intervaloRecompraConhecido));
  const media = mediaPonderadaRenormalizada([
    { valor: 0, peso: HS.recency },
    { valor: scoreFrequencia(intervaloRecompraConhecido(intervalo), max), peso: HS.frequency },
    { valor: null, peso: HS.margin },
    { valor: 0, peso: HS.diversity },
    { valor: null, peso: HS.crosssell },
    { valor: null, peso: HS.engagement },
  ]);
  return classeSaude(Math.round(media ?? 0));
}

Deno.test("cliente com 999 dias e intervalo null → critico", () => {
  assertEquals(classe(null), "critico");
});

Deno.test("o resíduo 30 legado punha o mesmo cliente em atencao (controle do teste acima)", () => {
  assertEquals(classe(30), "atencao");
});

Deno.test("intervalo 0 (seed) é ausência, não valor", () => {
  assertEquals(intervaloRecompraConhecido(0), null);
  assertEquals(classe(0), "critico");
});

Deno.test("intervalo nulo → frequência e recompra AUSENTES (nem 0, nem cadência mensal)", () => {
  assertEquals(scoreFrequencia(null, 1958), null);
  assertEquals(componenteRecompra(30, null), null);
});

Deno.test("intervalo medido → mesma fórmula de antes", () => {
  assertEquals(scoreFrequencia(20, 100), 80);
  assertEquals(componenteRecompra(30, 20), 50);
});
