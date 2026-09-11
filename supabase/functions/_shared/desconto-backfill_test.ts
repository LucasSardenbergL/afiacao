// deno test supabase/functions/_shared/desconto-backfill_test.ts
//
// ⚠️ O PONTO DESTA SUÍTE: o backfill re-lê o Omie HOJE para apurar o desconto de linhas
// gravadas MESES atrás. Duas coisas podem estar diferentes, e nenhuma delas se anuncia:
//
//   1. `hash_payload` NÃO identifica uma linha. Ele é `omie_<conta>_<pedido>_<produto>` — pedido
//      × SKU. Medido em produção 2026-09-08: 1.200 hashes cobrem 2.640 linhas de `order_items`.
//      Casar por ele aplicaria o desconto de uma linha na outra: R$ 10 e R$ 30 viram R$ 10 nas
//      duas, e o total do pedido continua parecendo são. Dinheiro errado, sem divergência.
//
//   2. O Omie devolve o pedido COMO ESTÁ HOJE. Se ele foi editado, o desconto atual incide sobre
//      um preço/quantidade que não são os que estão gravados. Aplicá-lo produziria uma versão do
//      pedido que nunca existiu.
//
// A resposta para os dois é a MESMA chave: casar por (SKU, quantidade, preço) e exigir que a
// correspondência seja única DOS DOIS LADOS. Quem não casa unicamente não é apurado — fica NULL
// com motivo. Precisão > recall: no recorte Oben/TTM isso derruba a ambiguidade de 477 itens
// (chave por SKU) para 51 (chave por trio), de 10.647.
//
// A âncora dos casos abaixo é a MESMA da régua: qtd=2, preço=100 → base 200.

import {
  conciliarDescontosPedido,
  conferirTotalPedido,
  type ItemOmieDetalhe,
  type LinhaLocal,
  pedidoNaJanela,
  registrarNaAmostra,
} from "./desconto-backfill.ts";

// `eq` local (test:edges roda com --no-remote, e o flag não se afrouxa por conveniência de teste).
// Compara por String() e não por JSON.stringify: este último serializa Infinity/NaN como "null",
// indistinguível de null de verdade — foi assim que uma mutação sobreviveu na suíte irmã.
function eq(atual: unknown, esperado: unknown, msg: string) {
  if (String(atual) !== String(esperado)) {
    throw new Error(`${msg}\n  esperado: ${String(esperado)}\n  recebido: ${String(atual)}`);
  }
}

function local(id: string, sku: number, qtd: number | null, preco: number | null): LinhaLocal {
  return { id, omie_codigo_produto: sku, quantity: qtd, unit_price: preco };
}

function omie(
  sku: number,
  qtd: number,
  preco: number,
  desconto: Partial<ItemOmieDetalhe["produto"]> = {},
): ItemOmieDetalhe {
  return {
    produto: { codigo_produto: sku, quantidade: qtd, valor_unitario: preco, ...desconto },
  };
}

/** Índice id→desconto apurado, para asserção legível. */
function apurados(r: ReturnType<typeof conciliarDescontosPedido>): Record<string, number> {
  const m: Record<string, number> = {};
  for (const a of r.apurados) m[a.id] = a.desconto_valor;
  return m;
}
/** Índice id→motivo da recusa. */
function recusas(r: ReturnType<typeof conciliarDescontosPedido>): Record<string, string> {
  const m: Record<string, string> = {};
  for (const x of r.recusados) m[x.id] = x.motivo;
  return m;
}

// ── O caso que motiva a chave: mesmo SKU, duas linhas ────────────────────────────────────────

Deno.test("mesmo SKU com preços diferentes: cada linha recebe o SEU desconto", () => {
  // Este é o caso que a chave por hash_payload erra. As duas linhas têm o MESMO hash em
  // produção; só o preço as separa. Descontos deliberadamente distintos e não-simétricos: se a
  // correspondência trocasse os lados, o teste veria 30 onde espera 10.
  const r = conciliarDescontosPedido(
    [local("a", 555, 2, 100), local("b", 555, 2, 300)],
    [
      omie(555, 2, 100, { tipo_desconto: "V", valor_desconto: 10 }),
      omie(555, 2, 300, { tipo_desconto: "V", valor_desconto: 30 }),
    ],
  );
  eq(r.recusados.length, 0, "nada a recusar: os trios são distintos");
  eq(apurados(r).a, 10, "linha de preço 100 fica com o desconto de 10");
  eq(apurados(r).b, 30, "linha de preço 300 fica com o desconto de 30");
});

Deno.test("mesmo SKU, mesmo preço e mesma qtd: recusa AS DUAS, não escolhe", () => {
  // Duplicidade legítima e indistinguível. Escolher qualquer um dos lados seria inventar uma
  // atribuição — e como os dois descontos existem, a soma do pedido pareceria plausível.
  const r = conciliarDescontosPedido(
    [local("a", 555, 2, 100), local("b", 555, 2, 100)],
    [
      omie(555, 2, 100, { tipo_desconto: "V", valor_desconto: 10 }),
      omie(555, 2, 100, { tipo_desconto: "V", valor_desconto: 30 }),
    ],
  );
  eq(r.apurados.length, 0, "nenhuma apurada — a atribuição é indecidível");
  eq(recusas(r).a, "ambiguo", "linha a recusada por ambiguidade");
  eq(recusas(r).b, "ambiguo", "linha b recusada por ambiguidade");
});

Deno.test("ambiguidade de UM trio não contamina os outros trios do mesmo pedido", () => {
  // Fail-closed é por linha, não por pedido: recusar o pedido inteiro por causa de um par
  // duplicado jogaria fora dado apurável, e recall gratuito perdido também é custo.
  const r = conciliarDescontosPedido(
    [local("a", 555, 2, 100), local("b", 555, 2, 100), local("c", 777, 1, 50)],
    [
      omie(555, 2, 100, { tipo_desconto: "V", valor_desconto: 10 }),
      omie(555, 2, 100, { tipo_desconto: "V", valor_desconto: 30 }),
      omie(777, 1, 50, { tipo_desconto: "V", valor_desconto: 5 }),
    ],
  );
  eq(apurados(r).c, 5, "o trio não-ambíguo é apurado normalmente");
  eq(r.recusados.length, 2, "só as duas linhas do trio duplicado são recusadas");
});

Deno.test("duplicidade só do lado do OMIE também recusa", () => {
  // O banco tem uma linha, o Omie devolve duas iguais. Casar a única linha local com "alguma"
  // delas escolheria um desconto por sorteio de ordem de array.
  const r = conciliarDescontosPedido(
    [local("a", 555, 2, 100)],
    [
      omie(555, 2, 100, { tipo_desconto: "V", valor_desconto: 10 }),
      omie(555, 2, 100, { tipo_desconto: "V", valor_desconto: 30 }),
    ],
  );
  eq(r.apurados.length, 0, "não apura");
  eq(recusas(r).a, "ambiguo", "ambiguidade do lado do Omie conta igual");
});

Deno.test("duplicidade só do lado LOCAL também recusa", () => {
  const r = conciliarDescontosPedido(
    [local("a", 555, 2, 100), local("b", 555, 2, 100)],
    [omie(555, 2, 100, { tipo_desconto: "V", valor_desconto: 10 })],
  );
  eq(r.apurados.length, 0, "não apura");
  eq(recusas(r).a, "ambiguo", "duas linhas locais para um item do Omie é indecidível");
  eq(recusas(r).b, "ambiguo", "e a recusa vale para as duas");
});

// ── A base mudou desde a ingestão ────────────────────────────────────────────────────────────

Deno.test("pedido editado no Omie: preço divergente NÃO casa", () => {
  // O desconto de hoje incide sobre 120; a linha gravada diz 100. Aplicar os 12 sobre a base
  // antiga produziria uma linha que nunca existiu em lugar nenhum.
  const r = conciliarDescontosPedido(
    [local("a", 555, 2, 100)],
    [omie(555, 2, 120, { tipo_desconto: "V", valor_desconto: 12 })],
  );
  eq(r.apurados.length, 0, "não apura sobre base que mudou");
  eq(recusas(r).a, "sem_correspondencia", "a linha local não achou par com a MESMA base");
});

Deno.test("quantidade divergente NÃO casa", () => {
  const r = conciliarDescontosPedido(
    [local("a", 555, 2, 100)],
    [omie(555, 3, 100, { tipo_desconto: "V", valor_desconto: 10 })],
  );
  eq(recusas(r).a, "sem_correspondencia", "qtd faz parte da identidade econômica da linha");
});

Deno.test("item sumiu do pedido no Omie: recusa, não apaga nem zera", () => {
  const r = conciliarDescontosPedido([local("a", 555, 2, 100)], []);
  eq(r.apurados.length, 0, "nada a apurar");
  eq(recusas(r).a, "sem_correspondencia", "ausência do par é recusa, não desconto zero");
});

// ── Ausente ≠ zero, nas duas pontas ──────────────────────────────────────────────────────────

Deno.test("o Omie informou que NÃO há desconto: apura 0, não recusa", () => {
  // O contraste que prova que o portão não fechou demais. `0` é dado — significa "o Omie disse
  // que não há desconto" — e precisa CHEGAR à coluna. Uma implementação que recusasse tudo
  // passaria em todos os testes de recusa acima e seria inútil.
  const r = conciliarDescontosPedido([local("a", 555, 2, 100)], [omie(555, 2, 100)]);
  eq(r.recusados.length, 0, "não é recusa");
  eq(apurados(r).a, 0, "zero é dado, e é gravado como zero");
  eq(Object.prototype.hasOwnProperty.call(apurados(r), "a"), true, "a linha está entre as apuradas");
});

Deno.test("preço local NULL: recusa por base indeterminada, não vira preço zero", () => {
  // `unit_price` é nullable desde 2026-09-05 justamente porque ausente ≠ zero. Formar a chave
  // com 0 casaria com um item de brinde do Omie e apuraria a linha errada.
  const r = conciliarDescontosPedido(
    [local("a", 555, 2, null)],
    [omie(555, 2, 0, { tipo_desconto: "V", valor_desconto: 3 })],
  );
  eq(r.apurados.length, 0, "não apura");
  eq(recusas(r).a, "base_indeterminada", "sem preço não há identidade econômica para casar");
});

Deno.test("quantidade local NULL: recusa por base indeterminada", () => {
  const r = conciliarDescontosPedido(
    [local("a", 555, null, 100)],
    [omie(555, 1, 100, { tipo_desconto: "V", valor_desconto: 3 })],
  );
  eq(recusas(r).a, "base_indeterminada", "sem quantidade a base do percentual é desconhecida");
});

Deno.test("SKU local NULL: recusa por base indeterminada", () => {
  const r = conciliarDescontosPedido(
    [{ id: "a", omie_codigo_produto: null, quantity: 2, unit_price: 100 }],
    [omie(555, 2, 100, { tipo_desconto: "V", valor_desconto: 10 })],
  );
  eq(recusas(r).a, "base_indeterminada", "sem SKU não há o que casar");
});

// ── A régua decide; o backfill só transporta ─────────────────────────────────────────────────

Deno.test("desconto PERCENTUAL usa a base da linha, não o preço unitário", () => {
  // 10% sobre a base 200 (= 2 × 100) é R$ 20. Sobre o preço unitário daria R$ 10 — o erro de
  // unidade que a régua documenta.
  const r = conciliarDescontosPedido(
    [local("a", 555, 2, 100)],
    [omie(555, 2, 100, { tipo_desconto: "P", percentual_desconto: 10 })],
  );
  eq(apurados(r).a, 20, "percentual incide sobre qtd × preço");
});

Deno.test("leitura recusada pela régua vira motivo próprio, não zero", () => {
  // Discriminador fora do vocabulário com desconto > 0: `descontoItemOmie` devolve null. O
  // backfill NÃO pode transformar isso em 0 — seria o `|| 0` original renascido mais um andar.
  const r = conciliarDescontosPedido(
    [local("a", 555, 2, 100)],
    [omie(555, 2, 100, { tipo_desconto: "X", valor_desconto: 10 })],
  );
  eq(r.apurados.length, 0, "não apura");
  eq(recusas(r).a, "leitura_recusada", "a recusa da régua é transportada com motivo próprio");
});

Deno.test("desconto maior que a base é recusado pela régua e transportado como tal", () => {
  const r = conciliarDescontosPedido(
    [local("a", 555, 2, 100)],
    [omie(555, 2, 100, { tipo_desconto: "V", valor_desconto: 500 })],
  );
  eq(recusas(r).a, "leitura_recusada", "desconto acima da base não vira receita negativa");
});

// ── Higiene do índice ────────────────────────────────────────────────────────────────────────

Deno.test("item do Omie sem codigo_produto não entra no índice", () => {
  // A régua devolve 0 para um objeto vazio — logo, ela NÃO prova que a origem é um detalhe real.
  // Quem prova é esta fronteira: sem SKU não há chave, e sem chave não há casamento.
  const r = conciliarDescontosPedido(
    [local("a", 555, 2, 100)],
    [{ produto: { quantidade: 2, valor_unitario: 100, tipo_desconto: "V", valor_desconto: 10 } }],
  );
  eq(r.apurados.length, 0, "item sem SKU não casa com nada");
  eq(recusas(r).a, "sem_correspondencia", "e a linha local fica não apurada");
});

Deno.test("det vazio ou linhas vazias não quebram nem inventam", () => {
  const r = conciliarDescontosPedido([], [omie(555, 2, 100)]);
  eq(r.apurados.length, 0, "sem linhas locais não há o que apurar");
  eq(r.recusados.length, 0, "nem o que recusar");
});

Deno.test("a ordem dos arrays não muda o resultado", () => {
  // Correspondência por índice de posição é o erro fácil aqui, e ele passaria em quase todos os
  // casos acima. Inverter um lado só é observável se a chave for de conteúdo.
  const locais = [local("a", 555, 2, 100), local("b", 777, 1, 50)];
  const itens = [
    omie(777, 1, 50, { tipo_desconto: "V", valor_desconto: 5 }),
    omie(555, 2, 100, { tipo_desconto: "V", valor_desconto: 10 }),
  ];
  const r = conciliarDescontosPedido(locais, itens);
  eq(apurados(r).a, 10, "a linha 'a' casa por conteúdo, não por posição");
  eq(apurados(r).b, 5, "e a linha 'b' também");
});

Deno.test("valores vindos como STRING (PostgREST numeric) casam com os numéricos do Omie", () => {
  // `numeric` do Postgres chega como string no supabase-js. Se a chave não normalizar, "100" e
  // 100 viram trios diferentes e NADA casa — o backfill rodaria inteiro recusando tudo, com
  // aparência de "o acervo é irrecuperável".
  const r = conciliarDescontosPedido(
    [{ id: "a", omie_codigo_produto: 555, quantity: "2", unit_price: "100.00" }],
    [omie(555, 2, 100, { tipo_desconto: "V", valor_desconto: 10 })],
  );
  eq(apurados(r).a, 10, "string e número descrevem a mesma linha");
});

Deno.test("contagem por motivo fecha com o total de linhas oferecidas", () => {
  // Denominador: toda linha oferecida tem exatamente UM desfecho. Sem isso, "apurei 900" não
  // tem com o que ser comparado, e linha comida em silêncio vira encolhimento invisível.
  const locais = [
    local("a", 555, 2, 100),   // apura
    local("b", 555, 2, 300),   // sem par
    local("c", 777, 1, null),  // base indeterminada
    local("d", 888, 1, 10),    // leitura recusada
  ];
  const r = conciliarDescontosPedido(locais, [
    omie(555, 2, 100, { tipo_desconto: "V", valor_desconto: 10 }),
    omie(888, 1, 10, { tipo_desconto: "X", valor_desconto: 5 }),
  ]);
  eq(r.apurados.length + r.recusados.length, locais.length, "todo alvo tem exatamente um desfecho");
  eq(r.apurados.length, 1, "uma apurada");
  eq(recusas(r).b, "sem_correspondencia", "b");
  eq(recusas(r).c, "base_indeterminada", "c");
  eq(recusas(r).d, "leitura_recusada", "d");
});

Deno.test("a mesma linha nunca aparece nas duas listas", () => {
  const r = conciliarDescontosPedido(
    [local("a", 555, 2, 100), local("b", 555, 2, 100)],
    [omie(555, 2, 100, { tipo_desconto: "V", valor_desconto: 10 })],
  );
  const ids = [...r.apurados.map((x) => x.id), ...r.recusados.map((x) => x.id)];
  eq(new Set(ids).size, ids.length, "sem id repetido entre apurados e recusados");
});

Deno.test("drift de ponto flutuante não separa a mesma linha", () => {
  // `numeric` do Postgres atravessa string e volta a float; o JSON do Omie chega por outro
  // caminho. 100.0000001 e 100 são a MESMA linha, e sem quantizar a chave elas viram trios
  // distintos — o backfill recusaria tudo com cara de "o acervo é irrecuperável".
  const r = conciliarDescontosPedido(
    [{ id: "a", omie_codigo_produto: 555, quantity: 2, unit_price: 100.0000001 }],
    [omie(555, 2, 100, { tipo_desconto: "V", valor_desconto: 10 })],
  );
  eq(apurados(r).a, 10, "diferença abaixo da 6ª casa não separa a linha");
});

// ── O SENSOR do valor: de onde o número apurado saiu ─────────────────────────────────────────
// A régua devolve 0 tanto para "o Omie informou que não há desconto" quanto para "os campos de
// desconto não vieram". O número é o MESMO; só o sensor os separa. Medido 2026-09-10: o dry-run
// da pág. 1 de Oben/TTM apurou 215/215 com zero recusas — contagem que seria idêntica se a
// resposta viesse sem os campos. Cada teste abaixo afirma o VALOR (o sensor não pode mudá-lo) e a
// ORIGEM (é o que ele acrescenta).

/** A única apurada do plano — o teste falha alto se houver zero ou mais de uma. */
function unicaApurada(r: ReturnType<typeof conciliarDescontosPedido>) {
  if (r.apurados.length !== 1) throw new Error(`esperava 1 apurada, veio ${r.apurados.length}`);
  return r.apurados[0];
}

Deno.test("sensor: campos AUSENTES apuram 0, e a origem diz 'ausentes' — o 0 que NÃO é dado", () => {
  // É o caso-mãe do sensor: SKU/qtd/preço válidos e nenhum campo de desconto. A régua apura 0
  // (contrato dela), e a única coisa que impede esse 0 de passar por "sem desconto" é a origem.
  const a = unicaApurada(conciliarDescontosPedido([local("a", 555, 2, 100)], [omie(555, 2, 100)]));
  eq(a.desconto_valor, 0, "a régua segue apurando 0 — o sensor não muda o valor");
  eq(a.origem.campos, "ausentes", "nenhum dos três campos veio");
  eq(a.origem.tipo, "", "sem tipo");
});

Deno.test("sensor: 0 INFORMADO pelo Omie apura 0, e a origem diz 'zerados'", () => {
  // O contraste do teste acima: mesmo número, origem oposta. Se o sensor não separasse os dois,
  // um acervo inteiro sem os campos seria indistinguível de um acervo sem desconto.
  const a = unicaApurada(conciliarDescontosPedido(
    [local("a", 555, 2, 100)],
    [omie(555, 2, 100, { tipo_desconto: "V", valor_desconto: 0, percentual_desconto: 0 })],
  ));
  eq(a.desconto_valor, 0, "zero informado é zero");
  eq(a.origem.campos, "zerados", "os campos vieram, e dizem zero");
  eq(a.origem.tipo, "V", "o tipo veio");
});

Deno.test("sensor: string em branco NÃO conta como campo que veio", () => {
  // "" é como uma API costuma mandar "sem valor". Contá-lo como presente classificaria como
  // 'zerados' justamente o caso 'ausentes' — o furo que o sensor existe para fechar.
  const a = unicaApurada(conciliarDescontosPedido(
    [local("a", 555, 2, 100)],
    [omie(555, 2, 100, { tipo_desconto: "", valor_desconto: "", percentual_desconto: "  " })],
  ));
  eq(a.desconto_valor, 0, "a régua apura 0");
  eq(a.origem.campos, "ausentes", "campos em branco são ausentes");
});

Deno.test("sensor: desconto > 0 é 'informados', com o tipo normalizado como a régua o lê", () => {
  // qtd 2 de propósito: é a quantidade que separa desconto da LINHA de desconto da UNIDADE.
  const a = unicaApurada(conciliarDescontosPedido(
    [local("a", 555, 2, 100)],
    [omie(555, 2, 100, { tipo_desconto: " p ", percentual_desconto: 10 })],
  ));
  eq(a.desconto_valor, 20, "10% sobre a base da linha (2 × 100)");
  eq(a.origem.campos, "informados", "um campo numérico veio > 0");
  eq(a.origem.tipo, "P", "trim + maiúscula, como em descontoItemOmie");
  eq(a.origem.percentual_desconto, 10, "o percentual lido é transportado");
  eq(a.origem.valor_desconto, null, "o valor não veio");
});

Deno.test("sensor: campo numérico ILEGÍVEL é 'invalidos', não 'ausentes' nem 'zerados'", () => {
  // A régua trata o campo ilegível como ausente e apura 0 — decisão dela, fora deste escopo. O
  // sensor não pode esconder que o campo VEIO: lixo na origem é outro diagnóstico que ausência.
  const a = unicaApurada(conciliarDescontosPedido(
    [local("a", 555, 2, 100)],
    [omie(555, 2, 100, { valor_desconto: "abc" })],
  ));
  eq(a.desconto_valor, 0, "a régua apura 0 (sem tipo, nenhum campo legível informa desconto)");
  eq(a.origem.campos, "invalidos", "o campo veio e não é número");
});

Deno.test("sensor: negativo também é 'invalidos'", () => {
  const a = unicaApurada(conciliarDescontosPedido(
    [local("a", 555, 2, 100)],
    [omie(555, 2, 100, { valor_desconto: -5 })],
  ));
  eq(a.desconto_valor, 0, "a régua apura 0");
  eq(a.origem.campos, "invalidos", "negativo não é desconto legível");
});

Deno.test("sensor: um campo ilegível e o outro válido — positivo, mas a origem acusa o lixo", () => {
  // A régua segue com o campo legível (percentual) e apura 20. O sensor classifica como
  // 'invalidos' porque um dos campos veio lixo — é isso que o separa de um 'informados' limpo.
  const a = unicaApurada(conciliarDescontosPedido(
    [local("a", 555, 2, 100)],
    [omie(555, 2, 100, { valor_desconto: "abc", percentual_desconto: 10 })],
  ));
  eq(a.desconto_valor, 20, "o percentual válido é aplicado sobre a base da linha");
  eq(a.origem.campos, "invalidos", "um campo veio ilegível");
});

Deno.test("sensor: tipo informado com valores zerados continua 'zerados'", () => {
  const a = unicaApurada(conciliarDescontosPedido(
    [local("a", 555, 2, 100)],
    [omie(555, 2, 100, { tipo_desconto: "P", percentual_desconto: 0 })],
  ));
  eq(a.desconto_valor, 0, "0% é zero");
  eq(a.origem.campos, "zerados", "o campo veio, com zero");
});

Deno.test("sensor: TIPO sozinho, sem campo numérico, é 'ausentes' — não é zero informado", () => {
  // O P1 do Codex no 1º desenho: `{tipo_desconto: "X"}` sem números — a régua apura 0 e o sensor
  // dizia "zerados" porque o tipo "veio". Um discriminador não informa valor nenhum.
  const a = unicaApurada(conciliarDescontosPedido(
    [local("a", 555, 2, 100)],
    [omie(555, 2, 100, { tipo_desconto: "X" })],
  ));
  eq(a.desconto_valor, 0, "a régua apura 0 (tipo desconhecido sem desconto a interpretar)");
  eq(a.origem.campos, "ausentes", "nenhum campo NUMÉRICO veio");
  eq(a.origem.tipo, "X", "o tipo que veio é transportado à parte");
});

Deno.test("sensor: tipo que não é string (false, 0) é 'invalidos'", () => {
  for (const lixo of [false, 0]) {
    const a = unicaApurada(conciliarDescontosPedido(
      [local("a", 555, 2, 100)],
      [omie(555, 2, 100, { tipo_desconto: lixo as unknown as string })],
    ));
    eq(a.desconto_valor, 0, `a régua apura 0 (tipo ${String(lixo)})`);
    eq(a.origem.campos, "invalidos", `tipo ${String(lixo)} veio e não é legível`);
  }
});

Deno.test("sensor: a base transportada é a do item do OMIE, não a linha local", () => {
  // Local qtd 1,0000001 casa com o item de qtd 1 (quantização a 6 casas). Se o sensor lesse a
  // local, contaria "qtd > 1" — a evidência que o controle positivo exige, fabricada.
  const a = unicaApurada(conciliarDescontosPedido(
    [{ id: "a", omie_codigo_produto: 555, quantity: 1.0000001, unit_price: 100 }],
    [omie(555, 1, 100, { tipo_desconto: "V", valor_desconto: 5 })],
  ));
  eq(a.origem.quantidade, 1, "a quantidade é a do Omie");
  eq(a.origem.valor_unitario, 100, "o preço é o do Omie");
});

// ── A janela do alvo restringe a ESCRITA, não só a contagem ─────────────────────────────────

Deno.test("janela: o dia do limite está dentro; o anterior está fora", () => {
  eq(pedidoNaJanela("2025-09-11", "2025-09-11"), true, "o próprio limite entra (gte)");
  eq(pedidoNaJanela("2026-09-10", "2025-09-11"), true, "depois do limite entra");
  eq(pedidoNaJanela("2025-09-10", "2025-09-11"), false, "um dia antes fica fora");
});

Deno.test("janela: data ausente ou fora do formato fica FORA (fail-closed)", () => {
  // Sem data não há como afirmar escopo — e o denominador (gte do PostgREST) também não conta NULL.
  eq(pedidoNaJanela(null, "2025-09-11"), false, "null");
  eq(pedidoNaJanela(undefined, "2025-09-11"), false, "undefined");
  eq(pedidoNaJanela("", "2025-09-11"), false, "vazia");
  eq(pedidoNaJanela("2025-9-11", "2025-09-11"), false, "sem zero à esquerda não compara como texto");
  eq(pedidoNaJanela("2026-09-10T00:00:00", "2025-09-11"), false, "timestamp não é o formato de date");
});

// ── A amostra garante um representante por combinação ────────────────────────────────────────

Deno.test("amostra: a sequência do Codex não deixa 'P/qtd 2' de fora", () => {
  // Seis positivas V/qtd2, depois V/qtd1, vazio/qtd1, vazio/qtd2, P/qtd1, P/qtd2. No 1º desenho
  // (4 vagas reservadas) a última ficava fora — e é ela que decide a semântica do percentual.
  const amostra: Array<{ combinacao: string; n: number }> = [];
  const seq = [
    ...Array.from({ length: 6 }, () => "V|2"),
    "V|1", "vazio|1", "vazio|2", "P|1", "P|2",
  ];
  seq.forEach((c, n) => registrarNaAmostra(amostra, { combinacao: c, n }, 10));
  const combos = new Set(amostra.map((x) => x.combinacao));
  eq(amostra.length, 10, "a amostra respeita o teto");
  for (const c of ["V|2", "V|1", "vazio|1", "vazio|2", "P|1", "P|2"]) {
    eq(combos.has(c), true, `a combinação ${c} tem representante`);
  }
});

Deno.test("amostra: combinação nova com a amostra cheia NÃO expulsa a única representante de outra", () => {
  // Teto 2, duas combinações já representadas uma vez cada: a terceira não tem de onde tirar vaga
  // sem apagar uma combinação inteira — e apagar seria trocar um controle por outro às cegas.
  const amostra: Array<{ combinacao: string }> = [];
  for (const c of ["P|2", "V|1", "V|2"]) registrarNaAmostra(amostra, { combinacao: c }, 2);
  const combos = amostra.map((x) => x.combinacao).sort().join(",");
  eq(combos, "P|2,V|1", "as duas representantes únicas permanecem");
});

// ── Conferência do pedido contra o total que o PRÓPRIO Omie calcula ─────────────────────────
// `total_pedido.valor_descontos` é a testemunha por valor que não passa pela correspondência com
// o banco. O caso que ela existe para pegar: desconto no total do pedido e zero nos itens — a
// régua leria 0 (campos ausentes) onde o Omie diz que há desconto.

Deno.test("total do pedido: soma dos itens (V e P) bate com valor_descontos → confere", () => {
  const r = conferirTotalPedido(
    [
      omie(555, 2, 100, { tipo_desconto: "V", valor_desconto: 10 }),
      omie(777, 2, 100, { tipo_desconto: "P", percentual_desconto: 10 }), // 10% de 200 = 20
    ],
    30,
  );
  eq(r.veredito, "confere", "10 + 20 = 30");
  eq(r.soma_itens, 30, "a soma é transportada");
});

Deno.test("total do pedido: desconto no TOTAL e itens sem campos → diverge (o furo do 'ausentes')", () => {
  // É o formato exato do dano: a régua apura 0 em cada item (sem campos = sem desconto), a
  // cobertura fica em 100%, e o Omie diz que o pedido teve R$ 30 de desconto.
  const r = conferirTotalPedido([omie(555, 2, 100), omie(777, 2, 100)], 30);
  eq(r.veredito, "diverge", "0 nos itens contra 30 no total");
  eq(r.soma_itens, 0, "a soma lida é zero");
  eq(r.total_omie, 30, "o total do Omie é transportado");
});

Deno.test("total do pedido AUSENTE → sem_total, nunca 'confere' com zero", () => {
  // `Number(undefined)` não pode virar total 0: com itens sem desconto, isso "conferiria" — e o
  // pedido entraria na contagem de conferidos sem que nenhum total tivesse sido lido.
  const r = conferirTotalPedido([omie(555, 2, 100)], undefined);
  eq(r.veredito, "sem_total", "ausência de total é ausência de dado");
  eq(r.total_omie, null, "nenhum total fabricado");
  eq(conferirTotalPedido([omie(555, 2, 100)], "").veredito, "sem_total", "string vazia também");
});

Deno.test("total do pedido: item que a régua recusa → item_ilegivel, não soma parcial", () => {
  // Somar só os itens legíveis produziria um "diverge" ou, pior, um "confere" por coincidência.
  const r = conferirTotalPedido(
    [
      omie(555, 2, 100, { tipo_desconto: "V", valor_desconto: 10 }),
      omie(777, 2, 100, { tipo_desconto: "X", valor_desconto: 20 }),
    ],
    10,
  );
  eq(r.veredito, "item_ilegivel", "o item de tipo desconhecido derruba a soma");
  eq(r.soma_itens, null, "soma parcial não é transportada");
});

Deno.test("total do pedido: diferença de arredondamento (≤ 1 centavo por item) confere", () => {
  // 3,333% de 100 = 3,333 → a régua arredonda a 3,33; o Omie pode ter gravado 3,34.
  const r = conferirTotalPedido([omie(555, 1, 100, { tipo_desconto: "P", percentual_desconto: 3.333 })], 3.34);
  eq(r.veredito, "confere", "um centavo num item é arredondamento");
});

Deno.test("total do pedido: dois centavos num único item já é divergência", () => {
  // O contraste do teste acima — a tolerância não pode virar folga que engole desconto real.
  const r = conferirTotalPedido([omie(555, 1, 100, { tipo_desconto: "V", valor_desconto: 3.33 })], 3.35);
  eq(r.veredito, "diverge", "0,02 num item só não é arredondamento");
});

Deno.test("total do pedido: zero informado nos dois lados confere", () => {
  const r = conferirTotalPedido([omie(555, 2, 100, { tipo_desconto: "V", valor_desconto: 0 })], 0);
  eq(r.veredito, "confere", "0 = 0");
});

Deno.test("diferença REAL de preço continua separando (a quantização não afrouxa demais)", () => {
  // O contraste do teste acima: se quantizar virasse arredondamento grosseiro, R$ 100,00 e
  // R$ 100,01 colidiriam e o desconto de um item iria para o outro.
  const r = conciliarDescontosPedido(
    [local("a", 555, 2, 100), local("b", 555, 2, 100.01)],
    [
      omie(555, 2, 100, { tipo_desconto: "V", valor_desconto: 10 }),
      omie(555, 2, 100.01, { tipo_desconto: "V", valor_desconto: 30 }),
    ],
  );
  eq(apurados(r).a, 10, "um centavo de diferença ainda é outra linha");
  eq(apurados(r).b, 30, "e cada uma fica com o seu desconto");
});
