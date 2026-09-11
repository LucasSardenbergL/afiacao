// Canon de omie-pedido.ts (#B). Roda: deno test supabase/functions/_shared/omie-pedido_test.ts
import {
  omieEtapaToStatus,
  etapaConhecida,
  subtotalPedidoComDesconto,
  apurarSubtotalPedido,
  construirItemsJson,
  precoUnitarioOmie,
  contarItensSemPreco,
  aplicarCorPreservandoItens,
  STATUS_GERIDO_OMIE,
} from "./omie-pedido.ts";
import { descontoItemOmie, receitaLiquidaItem } from "./desconto-omie.ts";

// `rotular` e não `JSON.stringify` puro: o stringify serializa `Infinity`/`NaN` como "null", e
// o assert que exigisse um número passaria cego sobre um não-finito — medido na suíte da régua
// (desconto-omie_test.ts), onde uma mutação sobreviveu exatamente por isso. O subtotal é número
// money-path; o comparador precisa enxergar o eixo que ele vigia.
function rotular(v: unknown): string {
  if (typeof v === "number" && !Number.isFinite(v)) return `<não-finito:${String(v)}>`;
  return JSON.stringify(v) ?? "<undefined>";
}
function eq(a: unknown, b: unknown, msg: string) {
  if (rotular(a) !== rotular(b)) throw new Error(`${msg}: ${rotular(a)} !== ${rotular(b)}`);
}

Deno.test("etapa→status casa o canon do omie-vendas-sync", () => {
  eq(omieEtapaToStatus("50"), "separacao", "50");
  eq(omieEtapaToStatus("60"), "faturado", "60");
  eq(omieEtapaToStatus("70"), "faturado", "70");
  eq(omieEtapaToStatus("80"), "cancelado", "80");
  eq(omieEtapaToStatus("20"), "enviado", "20");
  eq(omieEtapaToStatus("10"), "importado", "10→default");
  eq(omieEtapaToStatus(""), "importado", "vazio→default");
  eq(omieEtapaToStatus(undefined), "importado", "undefined→default");
});

Deno.test("REGRESSÃO #B: 60≠cancelado e 50≠faturado (mapa invertido do reprocess antigo)", () => {
  if (omieEtapaToStatus("60") === "cancelado") throw new Error("60 não pode ser cancelado");
  if (omieEtapaToStatus("50") === "faturado") throw new Error("50 não pode ser faturado");
});

Deno.test("etapaConhecida: só 20/50/60/70/80 (reprocess não rebaixa status em leitura malformada)", () => {
  for (const e of ["20", "50", "60", "70", "80"]) eq(etapaConhecida(e), true, `conhecida ${e}`);
  for (const e of ["10", "", undefined, "99", "x"]) eq(etapaConhecida(e), false, `desconhecida ${e}`);
});

Deno.test("STATUS_GERIDO_OMIE: exatamente os status cujo dono é o Omie", () => {
  eq([...STATUS_GERIDO_OMIE].sort(), ["cancelado", "enviado", "faturado", "importado", "separacao"], "conjunto canônico");
  // O que este assert protege: a lista viaja como argumento para `reconciliar_pedidos_omie`, que
  // a compara por CONJUNTO com a sua cópia e LANÇA se divergir. Um status app-avançado entrando
  // aqui faria a reconciliação rebaixar pedido que o time já avançou à mão.
  for (const s of ["confirmado", "entregue", "rascunho", "pendente"]) {
    eq(STATUS_GERIDO_OMIE.includes(s), false, `app-avançado ${s} NÃO é gerido pelo Omie`);
  }
});

Deno.test("todo status que omieEtapaToStatus produz está na lista enviada à RPC", () => {
  // Se um mapa de etapa novo emitisse um status fora da lista, a RPC o rejeitaria em runtime
  // (fail-closed) — este assert pega antes, no CI.
  for (const etapa of ["10", "20", "50", "60", "70", "80", "", "99"]) {
    eq(STATUS_GERIDO_OMIE.includes(omieEtapaToStatus(etapa)), true, `etapa ${etapa}`);
  }
});

// ── subtotal do pedido ────────────────────────────────────────────────────────────────────────
// ⚠️ O PONTO DESTE BLOCO: o acervo gravado não distingue fórmula nenhuma. Medido em 2026-09-10,
// 31.315/31.315 pais Omie têm `total == Σ qtd·preço` — o desconto nunca entrou, porque a fórmula
// antiga lia `prod.desconto`, chave que a API do Omie NÃO tem. Onde o desconto é zero, qualquer
// fórmula acerta; por isso os casos que decidem semântica usam desconto ≠ 0 e fixam o número que
// SÓ a leitura do trio real produz. Âncora da régua: qtd=2, preço=100, desconto=10 → 180 (P) /
// 190 (V); a fórmula antiga dava 200 nos dois.

// Todo item de fixture traz `codigo_produto`: é o universo do subtotal (o item que vira linha de
// `order_items`), e o payload real do Omie sempre o traz. O caso SEM código tem teste próprio.
type ProdutoFixture = {
  codigo_produto?: number;
  quantidade?: number;
  valor_unitario?: number;
  desconto?: number;
  tipo_desconto?: string;
  percentual_desconto?: number | string;
  valor_desconto?: number | string;
};
const item = (cod: number, p: ProdutoFixture) => ({ produto: { ...p, codigo_produto: cod } });

Deno.test("subtotal sem desconto: || (qty 0→1, igual ao sync), arredonda, det sem produto", () => {
  eq(subtotalPedidoComDesconto([item(1, { quantidade: 2, valor_unitario: 10 })]), 20, "sem desconto");
  eq(subtotalPedidoComDesconto([item(1, { quantidade: 3, valor_unitario: 33.333 })]), 100, "arredonda");
  eq(subtotalPedidoComDesconto([item(1, { quantidade: 0, valor_unitario: 10 })]), 10, "qty 0 → 1 (|| igual ao sync)");
  eq(subtotalPedidoComDesconto([{}]), 0, "det sem produto");
});

Deno.test("REGRESSÃO: a chave `desconto` não existe na API do Omie e NÃO move o subtotal", () => {
  // Este assert exigia 90 até 2026-09-10 — o teste CANONIZAVA o bug (money-path.md §6): ele
  // afirmava como desejada a leitura percentual de um campo que a origem nunca envia. Em produção
  // isso nunca disparou (a chave é sempre `undefined`), então o que o assert antigo protegia era
  // só a fórmula errada. Hoje a chave é ignorada: sem o trio real, não há desconto a aplicar.
  eq(subtotalPedidoComDesconto([item(1, { quantidade: 1, valor_unitario: 100, desconto: 10 })]), 100, "chave inexistente");
});

Deno.test("DISCRIMINANTE: o trio real decide — percentual dá 180, valor dá 190, e nunca os 200 do bruto", () => {
  const base = { quantidade: 2, valor_unitario: 100 };
  eq(subtotalPedidoComDesconto([item(1, { ...base, tipo_desconto: "P", percentual_desconto: 10 })]), 180, "P 10%");
  eq(subtotalPedidoComDesconto([item(1, { ...base, tipo_desconto: "V", valor_desconto: 10 })]), 190, "V R$ 10");
  // O Omie manda os dois campos preenchidos e o discriminador escolhe; o outro é ignorado.
  eq(subtotalPedidoComDesconto([item(1, { ...base, tipo_desconto: "V", valor_desconto: 10, percentual_desconto: 25 })]), 190, "V ignora o %");
});

Deno.test("o pedido REAL de prod (oben 12183048572, 2026-09-10): 1489,34 — não os 1629,25 gravados", () => {
  // O primeiro pedido com desconto que a régua apurou em order_items: 1×460,25 a 5% (R$ 23,01)
  // e 2×584,50 a 10% (R$ 116,90). `sales_orders.total` foi gravado BRUTO, 9,4% acima do que o
  // cliente paga pelas mercadorias. É o defeito medido, não um cenário construído.
  const det = [
    item(1, { quantidade: 1, valor_unitario: 460.25, tipo_desconto: "P", percentual_desconto: 5 }),
    item(2, { quantidade: 2, valor_unitario: 584.5, tipo_desconto: "P", percentual_desconto: 10 }),
  ];
  eq(subtotalPedidoComDesconto(det), 1489.34, "líquido do pedido real");
});

Deno.test("a base do desconto é o MESMO qty·preço gravado em order_items (qty 0 → 1 dos dois lados)", () => {
  // O sync grava `quantity: prod.quantidade || 1` e `desconto_valor` sobre essa base. Se o
  // subtotal usasse outra quantidade, cabeçalho e linhas contariam histórias diferentes.
  eq(subtotalPedidoComDesconto([item(1, { quantidade: 0, valor_unitario: 10, tipo_desconto: "P", percentual_desconto: 10 })]), 9, "base 1×10");
});

Deno.test("sem desconto, o subtotal é BIT A BIT o do legado — a reconciliação não reescreve quem não tem desconto", () => {
  // `reconciliar_pedidos_omie` reescreve o total quando ele muda mais de R$ 0,01. Se a fórmula nova
  // arredondasse por linha (ou somasse em outra ordem), pedidos SEM desconto passariam a "mudar" e
  // a primeira passada do reprocess viraria uma reconciliação em massa que não houve.
  // A fórmula ANTIGA, verbatim (`(1 − d/100)` com d = 0, que é o que a chave inexistente dava).
  const legado = (det: Array<{ produto: ProdutoFixture }>) =>
    Math.round(det.reduce((s, d) => s + (d.produto.quantidade || 1) * (d.produto.valor_unitario as number) * (1 - 0 / 100), 0) * 100) / 100;
  const fixtures = [
    [item(1, { quantidade: 3, valor_unitario: 33.333 }), item(2, { quantidade: 7, valor_unitario: 0.1 })],
    [item(1, { quantidade: 1, valor_unitario: 1629.25 })],
    [item(1, { quantidade: 12, valor_unitario: 13.85 }), item(2, { quantidade: 1, valor_unitario: 86 }), item(3, { quantidade: 5, valor_unitario: 0.07 })],
  ];
  for (const det of fixtures) {
    const novo = subtotalPedidoComDesconto(det);
    if (!Object.is(novo, legado(det))) throw new Error(`divergiu do legado: ${novo} !== ${legado(det)} em ${JSON.stringify(det)}`);
    // desconto explicitamente zero pelo trio também é "sem desconto"
    const comTrioZero = det.map((d) => ({ produto: { ...d.produto, tipo_desconto: "V", valor_desconto: 0, percentual_desconto: 0 } }));
    if (!Object.is(subtotalPedidoComDesconto(comTrioZero), legado(det))) throw new Error(`trio zerado divergiu do legado em ${JSON.stringify(det)}`);
  }
});

Deno.test("item sem preço segue FORA do subtotal (ausente ≠ zero) — e não conta como desconto ilegível", () => {
  // Sem preço não há base: a régua nem é consultada. Um desconto ilegível NESSE item não derruba
  // o pedido, porque o item já não entra na conta — contar aqui seria punir duas vezes.
  const det = [
    item(1, { quantidade: 2, valor_unitario: 100, tipo_desconto: "P", percentual_desconto: 10 }),
    item(2, { quantidade: 5 }),
    item(3, { quantidade: 1, tipo_desconto: "X", valor_desconto: 7 }),
  ];
  eq(apurarSubtotalPedido(det), { subtotal: 180, itensDescontoIlegivel: 0 }, "sem preço fora, sem contagem");
});

Deno.test("universo = os itens que VIRAM LINHA: det sem codigo_produto não entra no cabeçalho", () => {
  // O sync só grava em order_items o item com código. Somá-lo no cabeçalho descreveria uma linha
  // que não existe — e o reparo de órfão, que já filtrava por código, compararia contra outra conta.
  const det = [
    item(1, { quantidade: 2, valor_unitario: 100 }),
    { produto: { quantidade: 1, valor_unitario: 999 } },
    { produto: { codigo_produto: 0, quantidade: 1, valor_unitario: 999 } },
  ];
  eq(subtotalPedidoComDesconto(det), 200, "sem código fica fora");
  // e o desconto ilegível de um item FORA do universo não derruba o pedido
  eq(apurarSubtotalPedido([item(1, { quantidade: 1, valor_unitario: 10 }), { produto: { quantidade: 1, valor_unitario: 5, tipo_desconto: "X", valor_desconto: 1 } }]),
    { subtotal: 10, itensDescontoIlegivel: 0 }, "ilegível fora do universo não conta");
});

Deno.test("desconto ILEGÍVEL derruba o subtotal para null — fail-closed por PEDIDO, nunca soma parcial", () => {
  // As duas saídas "óbvias" fabricam: somar o item pelo bruto (o `null → 0` renascido) ou deixar SÓ
  // ele de fora (soma parcial com cara de total — e no órfão de total 0 isso faria o G5 aprovar).
  // `null` é "não publique esta revisão", e o chamador pula o pedido registrando-o.
  const bom = item(1, { quantidade: 2, valor_unitario: 100, tipo_desconto: "P", percentual_desconto: 10 });
  const casos: Array<[string, ProdutoFixture]> = [
    ["tipo fora do vocabulário com desconto", { quantidade: 1, valor_unitario: 500, tipo_desconto: "X", valor_desconto: 50 }],
    ["sem tipo, valor e percentual discordando", { quantidade: 1, valor_unitario: 100, valor_desconto: 20, percentual_desconto: 10 }],
    ["percentual acima de 100", { quantidade: 1, valor_unitario: 100, tipo_desconto: "P", percentual_desconto: 150 }],
    ["desconto maior que a base", { quantidade: 1, valor_unitario: 100, tipo_desconto: "V", valor_desconto: 120 }],
  ];
  for (const [nome, prod] of casos) {
    eq(apurarSubtotalPedido([bom, item(2, prod)]), { subtotal: null, itensDescontoIlegivel: 1 }, nome);
    eq(subtotalPedidoComDesconto([bom, item(2, prod)]), null, `${nome} (só o número)`);
  }
  // Controle: os MESMOS itens com leitura legível voltam a produzir número — o null vem da régua,
  // não de o pedido ter dois itens.
  eq(subtotalPedidoComDesconto([bom, item(2, { quantidade: 1, valor_unitario: 100, valor_desconto: 10, percentual_desconto: 10 })]), 270, "controle legível");
  eq(apurarSubtotalPedido([item(1, { quantidade: 1, valor_unitario: 10, tipo_desconto: "X", valor_desconto: 1 }), item(2, { quantidade: 1, valor_unitario: 10, tipo_desconto: "X", valor_desconto: 2 })]),
    { subtotal: null, itensDescontoIlegivel: 2 }, "conta todos os ilegíveis");
});

Deno.test("cabeçalho = Σ das linhas pela régua: o subtotal é a soma de receitaLiquidaItem do que o sync grava", () => {
  // Monta as linhas EXATAMENTE como o omie-vendas-sync as manda à RPC (unit_price pela régua de
  // preço, quantity `|| 1`, desconto_valor pela régua de desconto sobre qty·preço) e soma com a
  // mesma função que os consumidores usam. É o contrato que amarra o cabeçalho às linhas — e ele
  // vale EXATO quando cada base qty·preço é centavo inteiro (quantidade inteira, preço de 2 casas).
  const det = [
    item(1, { quantidade: 1, valor_unitario: 460.25, tipo_desconto: "P", percentual_desconto: 5 }),
    item(2, { quantidade: 2, valor_unitario: 584.5, tipo_desconto: "P", percentual_desconto: 10 }),
    item(3, { quantidade: 4, valor_unitario: 12.5, tipo_desconto: "V", valor_desconto: 3 }),
    item(4, { quantidade: 1, valor_unitario: 86 }),
  ];
  eq(subtotalPedidoComDesconto(det), Math.round(somaDasLinhas(det) * 100) / 100, "cabeçalho × linhas");
  // Número fixo, para o assert acima não passar com os DOIS lados errados do mesmo jeito:
  // 437,24 (460,25 − 23,01) + 1052,10 (1169 − 116,90) + 47 (50 − 3) + 86.
  eq(subtotalPedidoComDesconto(det), 1622.34, "número fixo");
});

Deno.test("com base em FRAÇÃO de centavo, cabeçalho e Σ das linhas diferem — no máximo ½ centavo por linha", () => {
  // Achado do challenge Codex (2026-09-10): três linhas de 0,5 × 10,01 a 10%. O cabeçalho arredonda
  // UMA vez (legado bit a bit, sem reescrita espúria); `receitaLiquidaItem` arredonda por linha.
  // A diferença é real e LIMITADA — este teste a fixa em vez de esconder, e prova o limite.
  const det = [1, 2, 3].map((cod) => item(cod, { quantidade: 0.5, valor_unitario: 10.01, tipo_desconto: "P", percentual_desconto: 10 }));
  const cab = subtotalPedidoComDesconto(det);
  const linhas = somaDasLinhas(det);
  if (cab === null) throw new Error("fixture legível não pode dar null");
  const dif = Math.abs(cab - linhas);
  if (!(dif > 0)) throw new Error(`a fixture deveria EXIBIR a diferença (cab=${cab}, linhas=${linhas}) — sem ela o teste não mede o limite`);
  if (!(dif <= 0.005 * det.length + 1e-9)) throw new Error(`diferença ${dif} acima de ½ centavo por linha`);
});

/** Σ receitaLiquidaItem das linhas, montadas como o sync as grava. */
function somaDasLinhas(det: Array<{ produto: ProdutoFixture }>): number {
  let soma = 0;
  for (const d of det) {
    const p = d.produto;
    if (!p.codigo_produto) continue;
    const qtd = p.quantidade || 1;
    const preco = precoUnitarioOmie(p.valor_unitario);
    const desc = descontoItemOmie(p, preco === null ? null : qtd * preco);
    const receita = receitaLiquidaItem(preco, qtd, desc);
    if (receita !== null) soma += receita;
  }
  return soma;
}

Deno.test("construirItemsJson casa o snapshot do sync (chaves + cor de tinta da obs)", () => {
  const det = [
    { produto: { codigo_produto: 8, descricao: "PINO F15", quantidade: 3, valor_unitario: 13.85, desconto: 0 } },
    { produto: { codigo_produto: 9, descricao: "BASE PU", quantidade: 1, valor_unitario: 86 }, observacao: { obs_item: "Cor: AZUL RAL 5010 - GL" } },
  ];
  const out = construirItemsJson(det);
  eq(out[0], { omie_codigo_produto: 8, descricao: "PINO F15", quantidade: 3, valor_unitario: 13.85, desconto: 0 }, "item comum");
  eq(out[1].tint_nome_cor, "AZUL RAL 5010", "cor de tinta extraída da obs");
  eq(out[1].descricao, "BASE PU", "descricao");
  // sem cor → sem chave tint
  eq("tint_nome_cor" in construirItemsJson([{ produto: { codigo_produto: 1, descricao: "X", quantidade: 1, valor_unitario: 1 } }])[0], false, "sem obs → sem tint");
});

// ⚠️ Os testes de `diffOrderItens` saíram daqui junto com a função. O diff de itens não é mais
// computado no TS: ele vive dentro de `reconciliar_pedidos_omie` (migration 20260830190000),
// porque um diff computado fora da transação de escrita pode aplicar uma revisão "nova + um
// estranho". A regra — inclusive a tolerância de 1e-6 que este arquivo protegia contra reescrita
// espúria — é provada em `db/test-reconciliar-pedidos-omie.sh` (asserts A1, A9, A13, A16).

// ── Preço ausente ≠ preço zero (a fatia da origem, 2026-09-05) ────────────────────────────────
// Gêmeo TS da régua SQL de `criar_pedidos_com_itens` (migration 20260905225613). Os dois têm de
// concordar item a item, senão a edge manda um número que a RPC classifica de outro jeito.
Deno.test("precoUnitarioOmie: finitude NÃO-NEGATIVA — separa 'não informou' de 'informou 0'", () => {
  eq(precoUnitarioOmie(undefined), null, "ausente");
  eq(precoUnitarioOmie(null), null, "null");
  eq(precoUnitarioOmie(""), null, "string vazia");
  eq(precoUnitarioOmie("   "), null, "só espaço");
  eq(precoUnitarioOmie({}), null, "objeto");
  eq(precoUnitarioOmie([]), null, "array (Number([]) é 0 — não pode virar preço)");
  eq(precoUnitarioOmie(false), null, "boolean (Number(false) é 0)");
  eq(precoUnitarioOmie("abc"), null, "lixo");
  eq(precoUnitarioOmie(-5), null, "negativo é corrupção, não desconto");
  eq(precoUnitarioOmie(Number.NaN), null, "NaN");
  eq(precoUnitarioOmie(Number.POSITIVE_INFINITY), null, "Infinity");
  // O ponto da fatia: 0 é FATO, não ausência. Quem exclui o 0 da margem é o consumo (SQL `> 0`).
  eq(precoUnitarioOmie(0), 0, "zero informado é dado (bonificação/brinde)");
  eq(precoUnitarioOmie("0"), 0, "zero como string");
  eq(precoUnitarioOmie(13.85), 13.85, "preço bom");
  eq(precoUnitarioOmie("13.85"), 13.85, "preço bom como string (o jsonb devolve assim)");
});

Deno.test("subtotal: item SEM preço fica de fora (soma idêntica, incompletude visível)", () => {
  // Somar `qty·0` e omitir o item dão o MESMO número — o subtotal não muda, e é por isso que
  // ele não podia ser o sensor. O sensor é contarItensSemPreco / o null no items-jsonb.
  eq(subtotalPedidoComDesconto([
    { produto: { codigo_produto: 1, quantidade: 2, valor_unitario: 10 } },
    { produto: { codigo_produto: 2, quantidade: 5 } },
  ]), 20, "item sem preço não soma nada");
  eq(contarItensSemPreco([
    { produto: { quantidade: 2, valor_unitario: 10 } },
    { produto: { quantidade: 5 } },
  ]), 1, "e a ausência é CONTADA");
  eq(subtotalPedidoComDesconto([{ produto: { codigo_produto: 1, quantidade: 2, valor_unitario: 0 } }]), 0, "zero informado soma 0");
  eq(contarItensSemPreco([{ produto: { quantidade: 2, valor_unitario: 0 } }]), 0, "zero informado NÃO é ausência");
  eq(contarItensSemPreco([{ produto: { quantidade: 1, valor_unitario: -3 } }]), 1, "lixo conta como ausência");
});

Deno.test("construirItemsJson: preço ausente vira null no jsonb, não 0", () => {
  const out = construirItemsJson([
    { produto: { codigo_produto: 8, descricao: "PINO", quantidade: 3 } },
    { produto: { codigo_produto: 9, descricao: "BASE", quantidade: 1, valor_unitario: 0 } },
  ]);
  eq(out[0].valor_unitario, null, "ausente → null (os leitores mostram '—')");
  eq(out[1].valor_unitario, 0, "zero informado → 0 (os leitores mostram R$ 0,00)");
});


Deno.test("aplicarCorPreservandoItens: só a COR entra; o resto do item-jsonb é intocável", () => {
  const gravados = [
    { omie_codigo_produto: 1, quantidade: 2, valor_unitario: 10, desconto: 0, descricao: "TINTA A" },
    { omie_codigo_produto: 2, quantidade: 1, valor_unitario: 50, desconto: 0, descricao: "TINTA B" },
  ];
  // A leitura do Omie DISCORDA em quantidade e preço de propósito: é exatamente o pedido que a
  // reconstrução corromperia, movendo o jsonb enquanto order_items fica parado.
  const lidos = [
    { omie_codigo_produto: 1, quantidade: 99, valor_unitario: 999, tint_nome_cor: "AZUL" },
    { omie_codigo_produto: 2, quantidade: 99, valor_unitario: 999 },
  ];
  const out = aplicarCorPreservandoItens(gravados, lidos)!;
  eq(out.length, 2, "não acrescenta nem remove item");
  eq(out[0], { omie_codigo_produto: 1, quantidade: 2, valor_unitario: 10, desconto: 0, descricao: "TINTA A", tint_nome_cor: "AZUL" },
     "cor entra; quantidade/preço/desconto/descrição gravados permanecem");
  eq(out[1], gravados[1], "item sem cor na leitura fica idêntico");

  // Nada a fazer → null, para o chamador PULAR o UPDATE (UPDATE inútil mexe em updated_at).
  eq(aplicarCorPreservandoItens(gravados, [{ omie_codigo_produto: 1 }]), null, "nenhuma cor aplicável → null");
  eq(aplicarCorPreservandoItens(null, lidos), null, "gravados não-array → null");
  eq(aplicarCorPreservandoItens([], lidos), null, "gravados vazio → null");
  eq(aplicarCorPreservandoItens(
       [{ omie_codigo_produto: 1, tint_nome_cor: "VERDE" }], lidos), null,
     "item que já tem cor não é reetiquetado → null (nada mudou)");

  // Ambiguidade nos DOIS lados: uma cor não diz a qual linha pertence. Rotular errado é pior
  // que não rotular — precisão > recall, a mesma régua do mesclarPrecoPreservado.
  eq(aplicarCorPreservandoItens(
       [{ omie_codigo_produto: 5 }, { omie_codigo_produto: 5 }],
       [{ omie_codigo_produto: 5, tint_nome_cor: "AZUL" }]), null,
     "código repetido nos GRAVADOS: não adivinha");
  eq(aplicarCorPreservandoItens(
       [{ omie_codigo_produto: 5 }],
       [{ omie_codigo_produto: 5, tint_nome_cor: "AZUL" }, { omie_codigo_produto: 5, tint_nome_cor: "ROSA" }]), null,
     "código repetido nos LIDOS: duas cores para um item = nenhuma");

  // Casa por código com tipos diferentes (o jsonb devolve number, o Omie às vezes manda string).
  eq(aplicarCorPreservandoItens(
       [{ omie_codigo_produto: 8, valor_unitario: 7 }],
       [{ omie_codigo_produto: "8", tint_nome_cor: "PRETO" }])!,
     [{ omie_codigo_produto: 8, valor_unitario: 7, tint_nome_cor: "PRETO" }],
     "casa por código mesmo com tipos diferentes");
});
