// Testes de COMPORTAMENTO da renormalização que decide `priority_score` e `health_score`.
//
// Por que importa que sejam de comportamento e não só de fonte: o gate de fonte
// (`potencial-nao-medido_test.ts`) pega a REINTRODUÇÃO do `|| 0` no call-site. Ele não pega a
// renormalização escrita errado — dividir pelo denominador cheio, deixar o ausente entrar no
// máximo, esquecer o clamp. Essas três produzem números plausíveis e sistematicamente errados,
// que é a falha pior (money-path.md §2). Os dois gates se complementam; nenhum substitui o outro.
//
// Sem import remoto: `test:edges` roda com `--no-remote` e um `jsr:`/`npm:` aqui colocaria a
// rede no caminho de entrega de TODO PR (CLAUDE.md).

import {
  maximoMedido,
  mediaPonderadaRenormalizada,
  normalizarPorMaximo,
  valorMedido,
} from "./score-ponderado.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(msg ?? `assertEquals falhou: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  }
}

// Os pesos DEFAULT do health score em `calculate-scores` (hs_weight_*, /100).
const HS = { recency: 0.25, frequency: 0.20, margin: 0.20, diversity: 0.15, crosssell: 0.10, engagement: 0.10 };

Deno.test("[SP-RENORM] componente ausente sai do DENOMINADOR, não contribui 0", () => {
  // Cenário REAL da prod (medido 2026-08-07): margem, x_score e s_score ausentes — 40% do peso do
  // health score sem produtor. Sobram recência(25) + frequência(20) + diversidade(15) = 60.
  const componentes = [
    { valor: 80, peso: HS.recency },
    { valor: 50, peso: HS.frequency },
    { valor: null, peso: HS.margin },
    { valor: 20, peso: HS.diversity },
    { valor: null, peso: HS.crosssell },
    { valor: null, peso: HS.engagement },
  ];
  // (80*.25 + 50*.20 + 20*.15) / (.25+.20+.15) = 33/0.60 = 55
  assertEquals(mediaPonderadaRenormalizada(componentes), 55);

  // E o CONTRASTE que dá sentido ao teste: a forma antiga (ausente = 0, denominador cheio) daria
  // 33 — o mesmo cliente rotulado "critico" em vez de "estavel" pelos limiares 25/50/75 da edge.
  const formaAntiga = componentes.reduce((s, c) => s + (c.valor ?? 0) * c.peso, 0);
  assertEquals(formaAntiga, 33);
});

Deno.test("[SP-RENORM] zero MEDIDO deprime o score (0 é veredito, não ausência)", () => {
  // A distinção inteira em um teste: trocar `null` por `0` tem de MUDAR o resultado. Se este
  // teste e o anterior dessem o mesmo número, a função estaria tratando ausência como zero.
  const comZeroMedido = [
    { valor: 80, peso: HS.recency },
    { valor: 50, peso: HS.frequency },
    { valor: 0, peso: HS.margin },
    { valor: 20, peso: HS.diversity },
    { valor: 0, peso: HS.crosssell },
    { valor: 0, peso: HS.engagement },
  ];
  // Agora o denominador é 1,0 e o numerador segue 33 → 33, não 55.
  assertEquals(mediaPonderadaRenormalizada(comZeroMedido), 33);
});

Deno.test("[SP-RENORM] tudo medido com pesos somando 1 é IDENTIDADE (não reescala quem tem dado)", () => {
  // Garante que o PR não mexe no score de quem TEM os componentes — o efeito tem de ser cirúrgico.
  const todos = [
    { valor: 40, peso: HS.recency },
    { valor: 60, peso: HS.frequency },
    { valor: 100, peso: HS.margin },
    { valor: 0, peso: HS.diversity },
    { valor: 10, peso: HS.crosssell },
    { valor: 90, peso: HS.engagement },
  ];
  const ponderadaCrua = todos.reduce((s, c) => s + c.valor * c.peso, 0);
  assertEquals(mediaPonderadaRenormalizada(todos), ponderadaCrua);
});

Deno.test("[SP-RENORM] nenhum componente medido → null (jamais 0)", () => {
  assertEquals(mediaPonderadaRenormalizada([{ valor: null, peso: 0.5 }, { valor: null, peso: 0.5 }]), null);
  assertEquals(mediaPonderadaRenormalizada([]), null);
});

Deno.test("[SP-RENORM] peso desligado ou corrompido não entra no denominador", () => {
  // `config[k]` vem de `Number(r.value)` em `farmer_algorithm_config` — um value não-numérico vira
  // NaN. NaN no denominador contaminaria o score de TODA a base com NaN.
  assertEquals(mediaPonderadaRenormalizada([{ valor: 100, peso: 0.5 }, { valor: 0, peso: 0 }]), 100);
  assertEquals(mediaPonderadaRenormalizada([{ valor: 100, peso: 0.5 }, { valor: 0, peso: NaN }]), 100);
  assertEquals(mediaPonderadaRenormalizada([{ valor: 100, peso: 0.5 }, { valor: 0, peso: -1 }]), 100);
  assertEquals(mediaPonderadaRenormalizada([{ valor: 50, peso: NaN }]), null);
});

Deno.test("[SP-MAX] coluna inteira NULL → null, e não o piso 1 que fabricava teto", () => {
  // O estado REAL de `farmer_client_scores.revenue_potential`: 6.633/6.633 NULL (psql-ro,
  // 2026-08-07). O `Math.max(...map(Number(x||0)), 1)` devolvia 1 aqui — teto inventado contra o
  // qual todo cliente pontuava 0, que é o `margin_potential_component` sempre 0 das 673.790
  // linhas de `priority_score_log`.
  assertEquals(maximoMedido([null, null, null]), null);
  assertEquals(maximoMedido([]), null);
});

Deno.test("[SP-MAX] o ausente não participa do máximo; o zero medido participa", () => {
  assertEquals(maximoMedido([null, 40, undefined, 90, null]), 90);
  assertEquals(maximoMedido([0, null]), 0);
  assertEquals(maximoMedido(["120.5", null, 30]), 120.5);
  // Lixo não vira 0: `Number("")`, `Number([])` e `Number(false)` são todos 0 e atravessariam um
  // `isFinite` como um zero de aparência perfeita.
  assertEquals(maximoMedido(["", [], false, NaN, Infinity]), null);
});

Deno.test("[SP-NORM] ausência propaga; máximo não-positivo é veredito 0; clamp em 0-100", () => {
  assertEquals(normalizarPorMaximo(null, 100), null);
  assertEquals(normalizarPorMaximo(50, null), null);
  assertEquals(normalizarPorMaximo(50, 200), 25);
  assertEquals(normalizarPorMaximo(200, 100), 100);   // clamp superior
  assertEquals(normalizarPorMaximo(-30, 100), 0);     // piso: negativo medido não vira score negativo
  assertEquals(normalizarPorMaximo(0, 0), 0);         // ninguém tem potencial → veredito, não ausência
});

Deno.test("[SP-VM] valorMedido: só número finito e string numérica contam", () => {
  assertEquals(valorMedido(0), 0);
  assertEquals(valorMedido(-3.5), -3.5);
  assertEquals(valorMedido("42"), 42);
  assertEquals(valorMedido(null), null);
  assertEquals(valorMedido(undefined), null);
  assertEquals(valorMedido(""), null);
  assertEquals(valorMedido("   "), null);
  assertEquals(valorMedido("abc"), null);
  assertEquals(valorMedido(NaN), null);
  assertEquals(valorMedido(Infinity), null);
  assertEquals(valorMedido([]), null);
  assertEquals(valorMedido(false), null);
});
