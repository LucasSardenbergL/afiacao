// Guard da EDIÇÃO de pedido (`alterar_pedido`): que desconto a leitura do Omie mostra.
// Roda: deno test --no-remote --allow-read=supabase/functions supabase/functions/_shared/edicao-desconto-omie_test.ts
import {
  descontoDaCapaNaLeitura,
  descontoNaLeituraDoOmie,
  descontosDeItemNaLeitura,
  type ItemOmieLido,
} from "./edicao-desconto-omie.ts";

// Comparador que ENXERGA não-finito: `JSON.stringify` serializa NaN como `null`, e o assert que exige
// `valor: null` passaria cego sobre um NaN — exatamente o eixo que este guard vigia (mesmo motivo do
// `rotular` de omie-pedido_test.ts, aqui aplicado também a número aninhado).
function rotular(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (typeof x === "number" && !Number.isFinite(x) ? `<não-finito:${String(x)}>` : x)) ??
    "<undefined>";
}
function eq(a: unknown, b: unknown, msg: string) {
  if (rotular(a) !== rotular(b)) throw new Error(`${msg}: ${rotular(a)} !== ${rotular(b)}`);
}

function item(codigo: number | undefined, produto: Record<string, unknown>): ItemOmieLido {
  return {
    produto: { ...(codigo === undefined ? {} : { codigo_produto: codigo }), ...produto } as ItemOmieLido["produto"],
  };
}

const ilegivel = (indice: number, codigo_produto: number | null) => ({ indice, codigo_produto, motivo: "ilegivel", valor: null });

Deno.test("sem desconto no Omie (trio ausente) → nada acusado", () => {
  const det = [
    item(1, { quantidade: 2, valor_unitario: 10 }),
    item(2, { quantidade: 1, valor_unitario: 99.9 }),
  ];
  eq(descontosDeItemNaLeitura(det), [], "trio ausente");
});

Deno.test("trio explicitamente ZERADO → nada (é o Omie dizendo que não há desconto)", () => {
  const det = [
    item(1, { quantidade: 2, valor_unitario: 10, tipo_desconto: "V", valor_desconto: 0 }),
    item(2, { quantidade: 2, valor_unitario: 10, tipo_desconto: "P", percentual_desconto: 0 }),
    item(3, { quantidade: 2, valor_unitario: 10, percentual_desconto: 0, valor_desconto: 0 }),
    item(4, { quantidade: 2, valor_unitario: 10, tipo_desconto: "V", valor_desconto: 0, percentual_desconto: 0 }),
    item(5, { quantidade: 2, valor_unitario: 10, tipo_desconto: "", valor_desconto: "", percentual_desconto: null }),
  ];
  eq(descontosDeItemNaLeitura(det), [], "zerados");
});

Deno.test("o pedido REAL de prod (oben 12183048572): os DOIS itens acusados, com o R$ da régua", () => {
  // 1×460,25 a 5% (R$ 23,01) e 2×584,50 a 10% (R$ 116,90): editar pelo app apagaria R$ 139,91 de
  // desconto comercial. O 2º item separa a base da LINHA (1169) da base do UNITÁRIO (584,50 → 58,45).
  const det = [
    item(1, { quantidade: 1, valor_unitario: 460.25, tipo_desconto: "P", percentual_desconto: 5 }),
    item(2, { quantidade: 2, valor_unitario: 584.5, tipo_desconto: "P", percentual_desconto: 10 }),
  ];
  eq(descontosDeItemNaLeitura(det), [
    { indice: 0, codigo_produto: 1, motivo: "desconto", valor: 23.01 },
    { indice: 1, codigo_produto: 2, motivo: "desconto", valor: 116.9 },
  ], "pedido real");
});

Deno.test("só os itens COM desconto, na posição do det (0-based) — o resto passa", () => {
  const det = [
    item(10, { quantidade: 1, valor_unitario: 50 }),
    item(20, { quantidade: 3, valor_unitario: 10, tipo_desconto: "V", valor_desconto: 4.5 }),
    item(30, { quantidade: 1, valor_unitario: 8 }),
  ];
  eq(descontosDeItemNaLeitura(det), [{ indice: 1, codigo_produto: 20, motivo: "desconto", valor: 4.5 }], "posição");
});

Deno.test("desconto em VALOR não precisa de preço: item sem preço com V>0 é acusado pelo valor", () => {
  eq(
    descontosDeItemNaLeitura([item(7, { quantidade: 1, tipo_desconto: "V", valor_desconto: 12 })]),
    [{ indice: 0, codigo_produto: 7, motivo: "desconto", valor: 12 }],
    "V sem preço",
  );
});

Deno.test("PERCENTUAL sem preço é ILEGÍVEL — acusa, não some (sem base não há como converter)", () => {
  eq(
    descontosDeItemNaLeitura([item(7, { quantidade: 1, tipo_desconto: "P", percentual_desconto: 5 })]),
    [ilegivel(0, 7)],
    "P sem preço",
  );
});

Deno.test("as recusas da régua acusam como ILEGÍVEL — na dúvida, não se apaga desconto", () => {
  const casos: Array<[string, Record<string, unknown>]> = [
    ["tipo desconhecido com desconto", { quantidade: 1, valor_unitario: 100, tipo_desconto: "X", valor_desconto: 5 }],
    ["percentual acima de 100", { quantidade: 1, valor_unitario: 100, tipo_desconto: "P", percentual_desconto: 150 }],
    ["desconto maior que a base", { quantidade: 1, valor_unitario: 100, tipo_desconto: "V", valor_desconto: 150 }],
    ["sem tipo, valor e percentual discordantes", { quantidade: 1, valor_unitario: 100, valor_desconto: 5, percentual_desconto: 10 }],
    ["tipo V com o desconto só no percentual", { quantidade: 1, valor_unitario: 100, tipo_desconto: "V", percentual_desconto: 5 }],
    // A régua devolve null para `V` sem valor; normalizar para zero só depois de MEDIR que o Omie manda
    // essa forma em item sem desconto (0 ilegíveis nas 162 linhas ingeridas desde 2026-09-10).
    ["tipo V sem nenhum valor", { quantidade: 1, valor_unitario: 100, tipo_desconto: "V" }],
  ];
  for (const [nome, prod] of casos) eq(descontosDeItemNaLeitura([item(9, prod)]), [ilegivel(0, 9)], nome);
});

// ── PRESENÇA, não apuração: onde a régua monetária responde 0 e o campo cru diz que há desconto ──
// A régua é para SOMAR receita: campo inválido ela lê como ausente (0) e desconto abaixo de ½ centavo
// ela arredonda para 0. Para decidir se é seguro APAGAR, esses zeros são cegueira (achado do challenge
// Codex, 2026-09-14): o guard olha o campo cru e acusa como ILEGÍVEL quando régua e campo discordam.
Deno.test("campo de desconto PRESENTE mas inválido acusa ILEGÍVEL (a régua o leria como ausente → 0)", () => {
  const casos: Array<[string, Record<string, unknown>]> = [
    ["valor não numérico, sem tipo", { quantidade: 1, valor_unitario: 100, valor_desconto: "abc" }],
    ["percentual não numérico, sem tipo", { quantidade: 1, valor_unitario: 100, percentual_desconto: "10%" }],
    ["valor negativo", { quantidade: 1, valor_unitario: 100, tipo_desconto: "V", valor_desconto: -5 }],
    ["valor com vírgula decimal (formato BR em JSON)", { quantidade: 1, valor_unitario: 100, valor_desconto: "5,00" }],
    ["valor de tipo não numérico (booleano)", { quantidade: 1, valor_unitario: 100, valor_desconto: true }],
  ];
  for (const [nome, prod] of casos) eq(descontosDeItemNaLeitura([item(3, prod)]), [ilegivel(0, 3)], nome);
});

Deno.test("campo cru POSITIVO com régua em zero acusa ILEGÍVEL: subcentavo arredondado e campo não-governante", () => {
  const casos: Array<[string, Record<string, unknown>]> = [
    ["desconto abaixo de ½ centavo", { quantidade: 1, valor_unitario: 100, tipo_desconto: "V", valor_desconto: 0.004 }],
    ["tipo P a 0% com valor preenchido", { quantidade: 1, valor_unitario: 100, tipo_desconto: "P", percentual_desconto: 0, valor_desconto: 5 }],
    ["tipo V a R$ 0 com percentual preenchido", { quantidade: 1, valor_unitario: 100, tipo_desconto: "V", valor_desconto: 0, percentual_desconto: 5 }],
  ];
  for (const [nome, prod] of casos) eq(descontosDeItemNaLeitura([item(4, prod)]), [ilegivel(0, 4)], nome);
});

Deno.test("item SEM codigo_produto também é acusado — a edição exclui TODOS os itens do Omie", () => {
  // ≠ apurarSubtotalPedido, cujo universo são os itens que viram linha em order_items. Aqui o universo
  // é o que o `alterar_pedido` apaga no Omie: o det inteiro.
  eq(
    descontosDeItemNaLeitura([item(undefined, { quantidade: 1, valor_unitario: 100, tipo_desconto: "V", valor_desconto: 10 })]),
    [{ indice: 0, codigo_produto: null, motivo: "desconto", valor: 10 }],
    "sem código",
  );
});

Deno.test("base LIXO (quantidade não numérica) com percentual acusa ILEGÍVEL — o NaN não passa pelo guard", () => {
  // `"abc" || 1` é "abc" (string não vazia é verdadeira) e "abc" × preço é NaN. A régua devolve NaN,
  // não null, e `NaN > 0` é false: um predicado "acusa se > 0" deixaria passar um item com 10% de
  // desconto. O guard só deixa passar o ZERO que a régua leu com os campos crus concordando.
  eq(
    descontosDeItemNaLeitura([item(5, { quantidade: "abc", valor_unitario: 100, tipo_desconto: "P", percentual_desconto: 10 })]),
    [ilegivel(0, 5)],
    "NaN",
  );
});

Deno.test("base que ESTOURA para Infinity acusa ILEGÍVEL com valor null — nunca um R$ não-finito", () => {
  // Preço e quantidade finitos cujo produto estoura: a régua devolve Infinity (não null), e sem o teste
  // de finitude o guard o reportaria como "desconto" de R$ Infinity.
  eq(
    descontosDeItemNaLeitura([item(6, { quantidade: 1e200, valor_unitario: 1e200, tipo_desconto: "P", percentual_desconto: 10 })]),
    [ilegivel(0, 6)],
    "Infinity",
  );
});

Deno.test("det vazio → nada (o anti-duplicação do alterar_pedido aborta antes)", () => {
  eq(descontosDeItemNaLeitura([]), [], "vazio");
});

// ── 2º eixo: a CAPA (`total_pedido.valor_descontos`, "Valor dos descontos. Preenchimento automático") ──
Deno.test("capa: ausente não acusa (eixo secundário); zero não acusa; positivo acusa com o valor", () => {
  eq(descontoDaCapaNaLeitura(undefined), null, "sem total_pedido");
  eq(descontoDaCapaNaLeitura(null), null, "total_pedido null");
  eq(descontoDaCapaNaLeitura({}), null, "sem valor_descontos");
  eq(descontoDaCapaNaLeitura({ valor_descontos: 0 }), null, "zero");
  eq(descontoDaCapaNaLeitura({ valor_descontos: 139.91 }), { motivo: "desconto", valor: 139.91 }, "positivo");
  eq(descontoDaCapaNaLeitura({ valor_descontos: "139.91" }), { motivo: "desconto", valor: 139.91 }, "string numérica");
});

Deno.test("capa: presente e inválida acusa ILEGÍVEL", () => {
  for (const v of ["abc", -1, "1,50", true]) {
    eq(descontoDaCapaNaLeitura({ valor_descontos: v }), { motivo: "ilegivel", valor: null }, `inválido ${String(v)}`);
  }
});

Deno.test("leitura do pedido: acusa se o ITEM ou a CAPA acusar — e só passa com os dois limpos", () => {
  const limpo = [item(1, { quantidade: 1, valor_unitario: 10 })];
  const comDesconto = [item(1, { quantidade: 1, valor_unitario: 10, tipo_desconto: "V", valor_desconto: 1 })];
  eq(descontoNaLeituraDoOmie({ det: limpo, total_pedido: { valor_descontos: 0 } }), { acusado: false, itens: [], capa: null }, "limpo");
  eq(descontoNaLeituraDoOmie({ det: limpo }), { acusado: false, itens: [], capa: null }, "limpo sem capa");
  eq(
    descontoNaLeituraDoOmie({ det: comDesconto, total_pedido: { valor_descontos: 0 } }),
    { acusado: true, itens: [{ indice: 0, codigo_produto: 1, motivo: "desconto", valor: 1 }], capa: null },
    "só o item",
  );
  // A forma do det mudou e o trio sumiu da resposta: a capa ainda sabe.
  eq(
    descontoNaLeituraDoOmie({ det: limpo, total_pedido: { valor_descontos: 5 } }),
    { acusado: true, itens: [], capa: { motivo: "desconto", valor: 5 } },
    "só a capa",
  );
});
