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
  lerExcluirIds,
  lerRetornoEscrita,
  pedidoNaJanela,
  portaoDoPedido,
  registrarNaAmostra,
  somarRetornoEscrita,
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

Deno.test("total do pedido: UM centavo de diferença já diverge — sem folga (v1.5)", () => {
  // Até a v1.4 isto "conferia": um centavo por item era aceito como arredondamento. Agora a
  // diferença de arredondamento do percentual vira recusa medida, em vez de folga que absorve.
  // 3,333% de 100 = 3,333 → a régua arredonda a 3,33; o total do Omie diz 3,34.
  const r = conferirTotalPedido([omie(555, 1, 100, { tipo_desconto: "P", percentual_desconto: 3.333 })], 3.34);
  eq(r.veredito, "diverge", "333 centavos contra 334");
  eq(r.soma_centavos, 333, "a soma sai em centavos inteiros");
  eq(r.total_centavos, 334, "o total também");
});

Deno.test("total do pedido: 100 itens zerados contra R$ 0,69 no total → diverge (a folga por item escondia o desconto)", () => {
  // O caso que o Codex r2 reproduziu contra a v1.3: com um centavo POR ITEM de folga, 100 itens
  // davam R$ 1,00 de margem — o desconto inteiro de R$ 0,69 cabia nela, e a régua gravaria 100 zeros.
  const itens = Array.from({ length: 100 }, (_, i) => omie(1000 + i, 1, 10, { tipo_desconto: "V", valor_desconto: 0 }));
  const r = conferirTotalPedido(itens, 0.69);
  eq(r.veredito, "diverge", "0 centavos nos itens contra 69 no total");
});

Deno.test("total do pedido: a soma é em centavos INTEIROS — 0,10 + 0,20 confere com 0,30", () => {
  // Em ponto flutuante 0,1 + 0,2 = 0,30000000000000004 ≠ 0,3. O contraste que prova que a
  // igualdade exata não reprova pedido certo por ruído binário (Codex r2, P3).
  const r = conferirTotalPedido(
    [
      omie(555, 1, 10, { tipo_desconto: "V", valor_desconto: 0.1 }),
      omie(777, 1, 10, { tipo_desconto: "V", valor_desconto: 0.2 }),
    ],
    0.3,
  );
  eq(r.veredito, "confere", "10 + 20 centavos = 30 centavos");
  eq(r.soma_centavos, 30, "soma inteira");
});

Deno.test("total do pedido: cada desconto vira centavo ARREDONDADO — 0,29 × 100 é 28,999999999999996", () => {
  // O caso que separa "somar em centavos" de "multiplicar por 100": sem o arredondamento por item a
  // soma sai 28,999999999999996 e o pedido certo diverge de si mesmo. (Pego pelo mutcheck da v1.5:
  // com só 0,10/0,20/10/20 nos testes, `soma += d * 100` sobrevivia — todos esses dão inteiro exato.)
  const r = conferirTotalPedido([omie(555, 1, 10, { tipo_desconto: "V", valor_desconto: 0.29 })], 0.29);
  eq(r.veredito, "confere", "29 centavos = 29 centavos");
  eq(r.soma_centavos, 29, "e a soma é o inteiro 29, não 28,999…");
});

Deno.test("total do pedido: zero informado nos dois lados confere", () => {
  const r = conferirTotalPedido([omie(555, 2, 100, { tipo_desconto: "V", valor_desconto: 0 })], 0);
  eq(r.veredito, "confere", "0 = 0");
});

// ── O PORTÃO do pedido: o que sai do plano ANTES da escrita (v1.5) ──────────────────────────
// Até a v1.4 a conferência com o total era só diagnóstico: o 7638 respondia `diverge` e as nove
// linhas iam para a RPC. Cada teste afirma o que fica no plano E o motivo de quem saiu — uma linha
// que some sem motivo quebraria o fechamento por id tanto quanto uma que fosse escrita.

/** Um plano de duas apuradas (a: 10, b: 0) e uma recusada pela correspondência (c). */
function planoBase() {
  return conciliarDescontosPedido(
    [local("a", 555, 2, 100), local("b", 777, 1, 50), local("c", 888, 1, 30)],
    [
      omie(555, 2, 100, { tipo_desconto: "V", valor_desconto: 10 }),
      omie(777, 1, 50, { tipo_desconto: "V", valor_desconto: 0 }),
    ],
  );
}

Deno.test("portão: total que confere não retira nada do plano", () => {
  const r = portaoDoPedido(planoBase(), "confere", new Set());
  eq(apurados(r).a, 10, "a segue no plano com o seu valor");
  eq(apurados(r).b, 0, "b também");
  eq(recusas(r).c, "sem_correspondencia", "a recusa da correspondência é preservada");
  eq(r.apurados.length + r.recusados.length, 3, "toda linha segue com exatamente um desfecho");
});

Deno.test("portão: total que DIVERGE retira TODAS as apuradas do pedido, com motivo", () => {
  const r = portaoDoPedido(planoBase(), "diverge", new Set());
  eq(r.apurados.length, 0, "nenhuma linha do pedido fica no plano");
  eq(recusas(r).a, "total_nao_confere", "a sai com o motivo do portão");
  eq(recusas(r).b, "total_nao_confere", "b também — inclusive o zero, que também não é confiável aqui");
  eq(recusas(r).c, "sem_correspondencia", "quem já tinha motivo mantém o dele");
  eq(r.recusados.length, 3, "e ninguém some do fechamento");
});

Deno.test("portão: sem_total e item_ilegivel também retiram — só `confere` libera escrita", () => {
  for (const v of ["sem_total", "item_ilegivel"] as const) {
    const r = portaoDoPedido(planoBase(), v, new Set());
    eq(r.apurados.length, 0, `${v}: nada no plano`);
    eq(recusas(r).a, "total_nao_confere", `${v}: motivo do portão`);
  }
});

Deno.test("portão: a exclusão do operador retira SÓ as linhas listadas, e vem antes do total", () => {
  const confere = portaoDoPedido(planoBase(), "confere", new Set(["a"]));
  eq(recusas(confere).a, "excluido_pelo_operador", "a linha listada sai");
  eq(apurados(confere).b, 0, "a não listada fica no plano");
  const diverge = portaoDoPedido(planoBase(), "diverge", new Set(["a"]));
  eq(recusas(diverge).a, "excluido_pelo_operador", "com o total divergindo, a exclusão explícita tem precedência");
  eq(recusas(diverge).b, "total_nao_confere", "e a outra sai pelo total");
});

Deno.test("portão: excluir uma linha que a correspondência já recusou não troca o motivo", () => {
  const r = portaoDoPedido(planoBase(), "confere", new Set(["c"]));
  eq(recusas(r).c, "sem_correspondencia", "o motivo da correspondência é o mais informativo");
  eq(r.recusados.filter((x) => x.id === "c").length, 1, "e a linha não aparece duas vezes");
});

// ── `excluir_ids`: forma inesperada é ERRO, nunca exclusão vazia ────────────────────────────

Deno.test("excluir_ids: ausente é o único vazio legítimo", () => {
  const u = lerExcluirIds(undefined);
  const n = lerExcluirIds(null);
  eq(u.ok && u.ids.size, 0, "undefined → nenhuma exclusão");
  eq(n.ok && n.ids.size, 0, "null → nenhuma exclusão");
  const vazio = lerExcluirIds([]);
  eq(vazio.ok && vazio.ids.size, 0, "array vazio também é válido");
});

Deno.test("excluir_ids: uuids válidos são normalizados para minúsculas", () => {
  const r = lerExcluirIds(["38A3E9AC-85CE-47DF-9E8A-5E43761EAF45", " b3e56dbb-208a-4a22-b533-e56fb3664156 "]);
  eq(r.ok, true, "aceita");
  eq(r.ok && r.ids.has("38a3e9ac-85ce-47df-9e8a-5e43761eaf45"), true, "maiúsculas viram minúsculas");
  eq(r.ok && r.ids.has("b3e56dbb-208a-4a22-b533-e56fb3664156"), true, "espaço nas pontas sai");
});

Deno.test("excluir_ids: forma inválida é ERRO — string, objeto, elemento lixo, lista acima do teto", () => {
  eq(lerExcluirIds("38a3e9ac-85ce-47df-9e8a-5e43761eaf45").ok, false, "string solta não é lista");
  eq(lerExcluirIds({ id: "x" }).ok, false, "objeto não é lista");
  eq(lerExcluirIds(["38a3e9ac-85ce-47df-9e8a-5e43761eaf45", 42]).ok, false, "elemento não-string reprova a lista inteira");
  eq(lerExcluirIds(["nao-e-uuid"]).ok, false, "string que não é uuid reprova");
  const acima = Array.from({ length: 1001 }, () => "38a3e9ac-85ce-47df-9e8a-5e43761eaf45");
  eq(lerExcluirIds(acima).ok, false, "acima do teto de 1000 reprova");
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

// ── O retorno da ESCRITA: `recusadas` são dois fatos, com consertos opostos ─────────────────
// `desconto_backfill_aplicar` devolve {pedidas, aplicadas, recusadas, ja_apuradas}, e `recusadas`
// (= pedidas − aplicadas) junta duas coisas: a linha cuja BASE mudou desde a leitura que montou o
// plano (conserto: reler o Omie) e a linha que JÁ tinha desconto quando a escrita chegou — outro
// writer, ou um run anterior, ganhou a corrida (conserto: nenhum). A edge somava as duas em
// "base mudou". `ja_apuradas` conta a segunda desde o #2475; antes contava junto as linhas que a
// própria chamada escrevia — e é por isso que o retorno é CONFERIDO aqui, não só lido.

type Retorno = ReturnType<typeof lerRetornoEscrita>;

/** O retorno do tipo esperado — o teste falha alto, com o retorno inteiro, se veio outro. */
function doTipo<T extends Retorno["tipo"]>(r: Retorno, tipo: T): Extract<Retorno, { tipo: T }> {
  if (r.tipo !== tipo) throw new Error(`esperava retorno '${tipo}', veio ${JSON.stringify(r)}`);
  return r as Extract<Retorno, { tipo: T }>;
}

Deno.test("escrita: base mudou é recusadas − ja_apuradas, e cada fato fica no SEU contador", () => {
  // Números assimétricos de propósito: trocar os dois contadores daria 1 onde se espera 3.
  const r = doTipo(lerRetornoEscrita({ pedidas: 10, aplicadas: 6, recusadas: 4, ja_apuradas: 1 }, 10), "classificado");
  eq(r.aplicadas, 6, "as aplicadas são transportadas");
  eq(r.base_mudou, 3, "4 recusadas − 1 já apurada");
  eq(r.ja_apuradas, 1, "a corrida perdida tem contador próprio");
});

Deno.test("escrita: corrida perdida INTEIRA não vira 'base mudou'", () => {
  // O caso em que o rótulo antigo mentia por inteiro: as 5 linhas foram gravadas por outro writer
  // entre a leitura e a escrita. A base de nenhuma delas mudou — reler o Omie não conserta nada.
  const r = doTipo(lerRetornoEscrita({ pedidas: 5, aplicadas: 0, recusadas: 5, ja_apuradas: 5 }, 5), "classificado");
  eq(r.base_mudou, 0, "nenhuma base mudou");
  eq(r.ja_apuradas, 5, "as 5 perderam a corrida");
});

Deno.test("escrita: ja_apuradas = 0 é DADO — aí sim toda recusa é base mudou", () => {
  // O contraste do teste de ausência abaixo: o mesmo número de recusas, com o campo presente e 0.
  const r = doTipo(lerRetornoEscrita({ pedidas: 4, aplicadas: 1, recusadas: 3, ja_apuradas: 0 }, 4), "classificado");
  eq(r.base_mudou, 3, "zero informado: nenhuma corrida perdida");
  eq(r.ja_apuradas, 0, "e zero é transportado como zero");
});

Deno.test("escrita: ja_apuradas AUSENTE deixa as recusas sem classificação — nem 'base mudou', nem zero", () => {
  // `Number(r.ja_apuradas ?? 0)` diria "nenhuma corrida perdida" e jogaria as 3 recusas em "base
  // mudou": o motivo fabricado a partir do dado que não veio.
  for (const retorno of [
    { pedidas: 5, aplicadas: 2, recusadas: 3 },
    { pedidas: 5, aplicadas: 2, recusadas: 3, ja_apuradas: null },
  ]) {
    const r = doTipo(lerRetornoEscrita(retorno, 5), "nao_classificado");
    eq(r.aplicadas, 2, "as aplicadas seguem legíveis e contadas");
    eq(r.recusadas, 3, "as 3 recusas ficam sem motivo, inteiras");
    eq(r.causa, "ja_apuradas_ausente", `a causa é nomeada (${JSON.stringify(retorno)})`);
  }
});

Deno.test("escrita: ja_apuradas ILEGÍVEL não é lido como número", () => {
  // String numérica inclusive: o contrato é inteiro JSON, e `Number("3")` é a mesma coerção que
  // faz `Number(null) === 0`.
  for (const lixo of ["1", 1.5, -1, true, Number.NaN, Number.POSITIVE_INFINITY]) {
    const r = doTipo(
      lerRetornoEscrita({ pedidas: 5, aplicadas: 2, recusadas: 3, ja_apuradas: lixo }, 5),
      "nao_classificado",
    );
    eq(r.recusadas, 3, `recusas sem motivo (ja_apuradas=${String(lixo)})`);
    eq(r.causa, "ja_apuradas_ilegivel", `ilegível não é ausente (ja_apuradas=${String(lixo)})`);
  }
});

Deno.test("escrita: ja_apuradas > recusadas é a assinatura da RPC anterior ao #2475 — não reparte", () => {
  // O cenário que a migration de correção mediu: plano de 3 linhas, 1 já preenchida por outro
  // writer, 2 aplicadas. A RPC anterior contava DEPOIS do UPDATE e devolvia ja_apuradas=3, que
  // subtraído da única recusa daria "base mudou = −2". A corrigida devolve 1.
  const antiga = doTipo(
    lerRetornoEscrita({ pedidas: 3, aplicadas: 2, recusadas: 1, ja_apuradas: 3 }, 3),
    "nao_classificado",
  );
  eq(antiga.recusadas, 1, "a recusa fica sem motivo");
  eq(antiga.causa, "ja_apuradas_excede_recusadas", "o estado impossível tem causa própria");
  const corrigida = doTipo(
    lerRetornoEscrita({ pedidas: 3, aplicadas: 2, recusadas: 1, ja_apuradas: 1 }, 3),
    "classificado",
  );
  eq(corrigida.ja_apuradas, 1, "o mesmo cenário na RPC corrigida");
  eq(corrigida.base_mudou, 0, "e nenhuma base mudou");
});

Deno.test("escrita: ja_apuradas ausente com ZERO recusas — nada a repartir, mas a causa não some", () => {
  // Sem recusa, a partição é 0 + 0 de qualquer jeito. O que se perderia é o SINAL de que a RPC
  // deste ambiente não devolve o campo — e ele tem de aparecer antes da primeira recusa.
  const r = doTipo(lerRetornoEscrita({ pedidas: 4, aplicadas: 4, recusadas: 0 }, 4), "nao_classificado");
  eq(r.recusadas, 0, "nenhuma recusa");
  eq(r.causa, "ja_apuradas_ausente", "a causa é reportada mesmo assim");
});

Deno.test("escrita: sem aplicadas/recusadas legíveis o retorno é ILEGÍVEL — a edge não sabe o que escreveu", () => {
  // `Number(r?.aplicadas ?? 0)` fazia de um retorno vazio "0 aplicadas, 0 recusadas": a escrita
  // pode ter acontecido inteira e a contagem diria que nada foi escrito nem recusado. O motivo é
  // casado por RAMO: string numérica somada vira concatenação ("2" + 1 = "21") e cairia em
  // `soma_nao_fecha` — verde pelo ramo errado.
  const casos: Array<[unknown, string]> = [
    [null, "nao_e_objeto"],
    [undefined, "nao_e_objeto"],
    ["ok", "nao_e_objeto"],
    [[], "nao_e_objeto"],
    [{}, "contagem_ilegivel"],
    [{ aplicadas: 3 }, "contagem_ilegivel"],
    [{ recusadas: 3 }, "contagem_ilegivel"],
    [{ aplicadas: "2", recusadas: 1, ja_apuradas: 0 }, "contagem_ilegivel"],
    [{ aplicadas: 1.5, recusadas: 1.5, ja_apuradas: 0 }, "contagem_ilegivel"],
    [{ aplicadas: -1, recusadas: 4, ja_apuradas: 0 }, "contagem_ilegivel"],
  ];
  for (const [retorno, motivo] of casos) {
    const r = doTipo(lerRetornoEscrita(retorno, 3), "ilegivel");
    eq(r.motivo, motivo, `motivo do retorno ${JSON.stringify(retorno) ?? String(retorno)}`);
  }
});

Deno.test("escrita: aplicadas + recusadas que não fecham com as linhas ENVIADAS são ilegíveis", () => {
  // A edge sabe quantas linhas mandou, sem depender do que a RPC diz. Soma que não fecha é outro
  // contrato do outro lado — repartir recusas sobre ela seria classificar um número que não
  // descreve esta chamada. Vale para o lote e para o retry de UMA linha.
  const casos: Array<[Record<string, unknown>, number, string]> = [
    [{ pedidas: 5, aplicadas: 2, recusadas: 2, ja_apuradas: 0 }, 5, "falta uma linha"],
    [{ pedidas: 6, aplicadas: 3, recusadas: 3, ja_apuradas: 0 }, 5, "sobra uma linha"],
    [{ pedidas: 1, aplicadas: 1, recusadas: 1, ja_apuradas: 0 }, 1, "retry de uma linha"],
  ];
  for (const [retorno, enviadas, msg] of casos) {
    eq(doTipo(lerRetornoEscrita(retorno, enviadas), "ilegivel").motivo, "soma_nao_fecha", msg);
  }
});

Deno.test("escrita: todo retorno legível fecha com as linhas enviadas", () => {
  // Denominador, como na conciliação: cada linha enviada tem exatamente um desfecho — aplicada,
  // base mudou, já apurada, ou recusa sem classificação. Nenhuma some, nenhuma conta duas vezes.
  const casos: Array<[Record<string, unknown>, number]> = [
    [{ pedidas: 10, aplicadas: 6, recusadas: 4, ja_apuradas: 1 }, 10],
    [{ pedidas: 5, aplicadas: 0, recusadas: 5, ja_apuradas: 5 }, 5],
    [{ pedidas: 5, aplicadas: 2, recusadas: 3 }, 5],
    [{ pedidas: 3, aplicadas: 2, recusadas: 1, ja_apuradas: 3 }, 3],
    [{ pedidas: 1, aplicadas: 1, recusadas: 0, ja_apuradas: 0 }, 1],
  ];
  for (const [retorno, enviadas] of casos) {
    const r = lerRetornoEscrita(retorno, enviadas);
    const soma = r.tipo === "classificado"
      ? r.aplicadas + r.base_mudou + r.ja_apuradas
      : r.tipo === "nao_classificado"
      ? r.aplicadas + r.recusadas
      : Number.NaN;
    eq(soma, enviadas, `fecha: ${JSON.stringify(retorno)}`);
  }
});

Deno.test("escrita: o retorno NÃO classificado preserva as aplicadas — no ilegível e no excesso também", () => {
  // Achado do Codex: `aplicadas: ausente ? aplicadas : 0` passava nos 55 testes — o de ilegível
  // conferia recusas e causa, mas não as aplicadas, e o de fechamento não tinha o caso ilegível.
  const ilegivel = doTipo(
    lerRetornoEscrita({ pedidas: 5, aplicadas: 2, recusadas: 3, ja_apuradas: "1" }, 5),
    "nao_classificado",
  );
  eq(ilegivel.aplicadas, 2, "ja_apuradas ilegível não zera as aplicadas");
  eq(ilegivel.aplicadas + ilegivel.recusadas, 5, "e o desfecho fecha com as enviadas");
  const excesso = doTipo(
    lerRetornoEscrita({ pedidas: 3, aplicadas: 2, recusadas: 1, ja_apuradas: 3 }, 3),
    "nao_classificado",
  );
  eq(excesso.aplicadas, 2, "o excesso também não zera as aplicadas");
});

// ── A SOMA nos contadores: o mesmo rótulo nos dois caminhos da edge ─────────────────────────
// Achado do Codex: com a soma dentro da edge, trocar `+= r.base_mudou` por `+= r.base_mudou +
// r.ja_apuradas` reintroduzia o rótulo duplo sem nenhum teste ficar vermelho — a suíte só via a
// leitura. A soma mora no módulo para ter teste. (Que os DOIS caminhos da edge a chamem, esta
// suíte não vê: a edge não tem harness — fica registrado.)

/** Os contadores no formato do recorte que a edge passa, zerados. */
function contadoresZerados() {
  return {
    contadores: {
      escrita_aplicada: 0,
      escrita_recusada_base_mudou: 0,
      escrita_recusada_ja_apurada: 0,
      escrita_recusada_nao_classificada: 0,
    },
    causas: { ja_apuradas_ausente: 0, ja_apuradas_ilegivel: 0, ja_apuradas_excede_recusadas: 0 },
  };
}

Deno.test("soma: cada fato vai para o SEU contador, e as chamadas acumulam", () => {
  const { contadores: c, causas } = contadoresZerados();
  somarRetornoEscrita(c, causas, { pedidas: 10, aplicadas: 6, recusadas: 4, ja_apuradas: 1 }, 10); // o lote
  somarRetornoEscrita(c, causas, { pedidas: 1, aplicadas: 0, recusadas: 1, ja_apuradas: 1 }, 1); // um retry
  eq(c.escrita_aplicada, 6, "as aplicadas somam");
  eq(c.escrita_recusada_base_mudou, 3, "base mudou é só o que a RPC não achou já apurado");
  eq(c.escrita_recusada_ja_apurada, 2, "1 do lote + 1 do retry");
  eq(c.escrita_recusada_nao_classificada, 0, "nada sem classificação");
  eq(
    causas.ja_apuradas_ausente + causas.ja_apuradas_ilegivel + causas.ja_apuradas_excede_recusadas,
    0,
    "nenhuma causa de degradação",
  );
});

Deno.test("soma: retorno NÃO classificado vai inteiro para o seu contador, e a causa conta chamadas", () => {
  const { contadores: c, causas } = contadoresZerados();
  somarRetornoEscrita(c, causas, { pedidas: 5, aplicadas: 2, recusadas: 3 }, 5);
  somarRetornoEscrita(c, causas, { pedidas: 4, aplicadas: 4, recusadas: 0 }, 4);
  eq(c.escrita_aplicada, 6, "as aplicadas seguem somadas");
  eq(c.escrita_recusada_nao_classificada, 3, "as 3 recusas sem motivo");
  eq(c.escrita_recusada_base_mudou + c.escrita_recusada_ja_apurada, 0, "nenhuma recebe motivo inventado");
  eq(causas.ja_apuradas_ausente, 2, "duas chamadas sem o campo — inclusive a de zero recusas");
});

Deno.test("soma: retorno ILEGÍVEL lança com o motivo e não toca em contador nenhum", () => {
  const { contadores: c, causas } = contadoresZerados();
  let mensagem = "";
  try {
    somarRetornoEscrita(c, causas, { pedidas: 5, aplicadas: 2, recusadas: 2, ja_apuradas: 0 }, 5);
  } catch (e) {
    mensagem = e instanceof Error ? e.message : String(e);
  }
  // A marca do RAMO, não "lançou alguma coisa": o motivo e o aviso de resultado desconhecido.
  eq(mensagem.includes("(soma_nao_fecha)"), true, `o motivo está na mensagem: "${mensagem}"`);
  eq(mensagem.includes("DESCONHECIDO"), true, "e ela diz que o resultado da escrita é desconhecido");
  eq(
    c.escrita_aplicada + c.escrita_recusada_base_mudou + c.escrita_recusada_ja_apurada +
      c.escrita_recusada_nao_classificada,
    0,
    "nenhum contador foi tocado",
  );
});
