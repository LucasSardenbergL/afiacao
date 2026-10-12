// Testa a lógica PURA de omie-sync-metadados/ausentes.ts no runtime real (Deno).
// Roda com: deno test --no-remote supabase/functions/omie-sync-metadados/ausentes_test.ts
//
// A regra: ausência numa listagem COMPLETA só descobre candidato; inativa quem estiver ausente em
// DOIS runs completos consecutivos, abaixo do teto. Qualquer dúvida ⇒ zero inativados.
import {
  avaliarCompletudeCatalogo,
  conjuntoAnteriorValido,
  limiteAusentes,
  MAX_IDADE_ANTERIOR_MS,
  MIN_IDADE_ANTERIOR_MS,
  planejarInativacao,
} from "./ausentes.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(msg ?? `assertEquals falhou: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  }
}

const AGORA = Date.parse("2026-10-12T08:31:00Z");
const ONTEM = "2026-10-11T08:31:00Z";
const completa = { completa: true as const };

// 100 ativos locais (1..100); listados = todos menos os ausentes indicados.
function cenario(ausentes: number[], extrasListados: number[] = []) {
  const ativos = Array.from({ length: 100 }, (_, i) => i + 1);
  const listados = new Set([...ativos.filter((c) => !ausentes.includes(c)), ...extrasListados]);
  return { ativos, listados };
}

Deno.test("completa + ausente nos DOIS runs ⇒ inativa só a interseção", () => {
  const { ativos, listados } = cenario([7, 8]);
  const plano = planejarInativacao({
    completude: completa,
    listados,
    ativosLocais: ativos,
    anterior: { codigos: [8, 9], run_at: ONTEM },
    agoraMs: AGORA,
  });
  assertEquals(plano.status, "complete");
  assertEquals(plano.ausentes, [7, 8]);
  assertEquals(plano.aInativar, [8]); // 7 é candidato novo; 9 reapareceu
  assertEquals(plano.conjuntoNovo, [7, 8]);
});

Deno.test("1º run (sem anterior) ⇒ só grava candidatos, não inativa", () => {
  const { ativos, listados } = cenario([7]);
  const plano = planejarInativacao({ completude: completa, listados, ativosLocais: ativos, anterior: null, agoraMs: AGORA });
  assertEquals(plano.aInativar, []);
  assertEquals(plano.conjuntoNovo, [7]);
});

Deno.test("listagem INCOMPLETA ⇒ zero inativados e invalida a confirmação seguinte", () => {
  const { ativos, listados } = cenario([7]);
  const plano = planejarInativacao({
    completude: { completa: false, motivo: "página 3 veio com 40 de 100 antes da última" },
    listados,
    ativosLocais: ativos,
    anterior: { codigos: [7], run_at: ONTEM },
    agoraMs: AGORA,
  });
  assertEquals(plano.status, "incompleta");
  assertEquals(plano.aInativar, []);
  assertEquals(plano.conjuntoNovo, null);
});

Deno.test("listagem vazia ⇒ zero inativados mesmo com completude afirmada", () => {
  const plano = planejarInativacao({
    completude: completa,
    listados: new Set(),
    ativosLocais: [1, 2, 3],
    anterior: { codigos: [1, 2, 3], run_at: ONTEM },
    agoraMs: AGORA,
  });
  assertEquals(plano.status, "incompleta");
  assertEquals(plano.aInativar, []);
});

Deno.test("teto: ausentes acima de max(10, 2%) ⇒ zero inativados e conjunto NÃO gravado", () => {
  const ausentes = Array.from({ length: 11 }, (_, i) => i + 1); // 100 ativos ⇒ teto 10
  const { ativos, listados } = cenario(ausentes);
  const plano = planejarInativacao({
    completude: completa,
    listados,
    ativosLocais: ativos,
    anterior: { codigos: ausentes, run_at: ONTEM },
    agoraMs: AGORA,
  });
  assertEquals(plano.status, "teto_excedido");
  assertEquals(plano.aInativar, []);
  assertEquals(plano.conjuntoNovo, null);
  assertEquals(plano.ausentes.length, 11);
});

Deno.test("teto: exatamente no limite ainda inativa (fronteira)", () => {
  const ausentes = Array.from({ length: 10 }, (_, i) => i + 1);
  const { ativos, listados } = cenario(ausentes);
  const plano = planejarInativacao({
    completude: completa,
    listados,
    ativosLocais: ativos,
    anterior: { codigos: ausentes, run_at: ONTEM },
    agoraMs: AGORA,
  });
  assertEquals(plano.status, "complete");
  assertEquals(plano.aInativar.length, 10);
});

Deno.test("limiteAusentes: piso 10 e 2% acima dele (contas reais)", () => {
  assertEquals(limiteAusentes(100), 10);
  assertEquals(limiteAusentes(992), 20); // oben
  assertEquals(limiteAusentes(2227), 45); // colacor
});

Deno.test("anterior VELHO (> 30h), RECENTE demais (< 6h), do futuro, ou malformado não confirma ninguém", () => {
  const velho = new Date(AGORA - MAX_IDADE_ANTERIOR_MS - 1).toISOString();
  const recente = new Date(AGORA - MIN_IDADE_ANTERIOR_MS + 1).toISOString();
  const futuro = new Date(AGORA + 60_000).toISOString();
  assertEquals(conjuntoAnteriorValido({ codigos: [7], run_at: recente }, AGORA).size, 0);
  assertEquals(conjuntoAnteriorValido({ codigos: [7], run_at: new Date(AGORA - MIN_IDADE_ANTERIOR_MS).toISOString() }, AGORA).size, 1);
  assertEquals(conjuntoAnteriorValido({ codigos: [7], run_at: new Date(AGORA - MAX_IDADE_ANTERIOR_MS).toISOString() }, AGORA).size, 1);
  assertEquals(conjuntoAnteriorValido({ codigos: [7], run_at: velho }, AGORA).size, 0);
  assertEquals(conjuntoAnteriorValido({ codigos: [7], run_at: futuro }, AGORA).size, 0);
  assertEquals(conjuntoAnteriorValido({ codigos: [7], run_at: null }, AGORA).size, 0);
  assertEquals(conjuntoAnteriorValido({ codigos: "7", run_at: ONTEM }, AGORA).size, 0);
  assertEquals(conjuntoAnteriorValido({ codigos: [7, "lixo"], run_at: ONTEM }, AGORA).size, 0);
  assertEquals(conjuntoAnteriorValido(null, AGORA).size, 0);
  assertEquals([...conjuntoAnteriorValido({ codigos: [7, "8"], run_at: ONTEM }, AGORA)], [7, 8]);
});

Deno.test("códigos locais inválidos não viram candidatos; bigint real (5185282119) é comparado certo", () => {
  const plano = planejarInativacao({
    completude: completa,
    listados: new Set([5187639001]),
    ativosLocais: [5185282119, null, "abc", 0, 5187639001],
    anterior: { codigos: [5185282119], run_at: ONTEM },
    agoraMs: AGORA,
  });
  assertEquals(plano.ausentes, [5185282119]);
  assertEquals(plano.aInativar, [5185282119]);
});

Deno.test("completude do catálogo: intermediária curta, última cheia, código inválido, truncada, sem declarado", () => {
  const base = { porPagina: 100, codigosInvalidos: 0 };
  const ok = avaliarCompletudeCatalogo({ ...base, tamanhos: [100, 100, 35], unicos: 235, totalDeclarado: 235 });
  assertEquals(ok.completa, true);

  const semDeclarado = avaliarCompletudeCatalogo({ ...base, tamanhos: [100, 35], unicos: 135, totalDeclarado: undefined });
  assertEquals(semDeclarado.completa, false);
  const buraco = avaliarCompletudeCatalogo({ ...base, tamanhos: [100, 40, 35], unicos: 175, totalDeclarado: 175 });
  assertEquals(buraco.completa, false);
  const ultimaCheia = avaliarCompletudeCatalogo({ ...base, tamanhos: [100, 100], unicos: 200, totalDeclarado: 200 });
  assertEquals(ultimaCheia.completa, false);
  const invalido = avaliarCompletudeCatalogo({ ...base, tamanhos: [100, 35], codigosInvalidos: 1, unicos: 134, totalDeclarado: 135 });
  assertEquals(invalido.completa, false);
  const truncada = avaliarCompletudeCatalogo({ ...base, tamanhos: [100, 35], unicos: 135, totalDeclarado: 4335 });
  assertEquals(truncada.completa, false);
  const nenhuma = avaliarCompletudeCatalogo({ ...base, tamanhos: [], unicos: 0, totalDeclarado: 10 });
  assertEquals(nenhuma.completa, false);
});

Deno.test("página REPETIDA (deslize) fecha a soma crua mas não os únicos ⇒ incompleta", () => {
  // 3 páginas lidas (100+100+35 itens crus = 235 = declarado), mas a 2ª repetiu 10 da 1ª:
  // 225 únicos — 10 produtos vivos foram omitidos e pareceriam ausentes.
  const r = avaliarCompletudeCatalogo({ tamanhos: [100, 100, 35], porPagina: 100, codigosInvalidos: 0, unicos: 225, totalDeclarado: 235 });
  assertEquals(r.completa, false);
});
