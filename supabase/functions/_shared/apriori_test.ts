// Testa o CÓDIGO REAL do Apriori do farmer (não uma cópia) no runtime real (Deno).
// Roda com: deno test --no-remote supabase/functions/_shared/apriori_test.ts
//
// A tese que estes cenários provam é a MESMA que a réplica SQL mediu em prod (psql-ro,
// 2026-08-21): com o denominador GLOBAL, o piso `s_min` afoga o sinal da conta menor; com o
// denominador POR SEGMENTO, o mesmo piso o preserva. Aqui isso vira um universo de brinquedo
// onde o efeito é aritmético e verificável à mão, em vez de depender do dado de produção.
import {
  agruparCestasPorSegmento,
  calcularRegrasDoSegmento,
  type Cesta,
} from "./apriori.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(msg ?? `assertEquals falhou: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  }
}
function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

const P = { sMin: 0.1, lMin: 1.2, maxRegras: 500 };

/**
 * O universo de brinquedo, com a MESMA assimetria de prod: uma conta grande sem par forte e
 * uma conta pequena com um par que só é frequente DENTRO dela.
 *
 *   grande  → 100 cestas de 1 item ("G"). Nenhum par, por construção.
 *   pequena →  20 cestas: 10 com {P1,P2} e 10 com {P3}.
 *
 * Aritmética que o teste explora:
 *   · P1 no universo GLOBAL: 10/120 = 0,083 < 0,1 ⇒ nem chega a ser item frequente.
 *   · P1 no segmento PEQUENA: 10/20 = 0,50 ≥ 0,1 ⇒ frequente, e o par vira regra com lift 2,0.
 * Mesmo piso, mesmos dados, denominadores diferentes — o achado inteiro em 120 cestas.
 */
function universo(): { sales_order_id: string | null; product_id: string | null; account: string | null }[] {
  const linhas: { sales_order_id: string | null; product_id: string | null; account: string | null }[] = [];
  for (let i = 0; i < 100; i++) linhas.push({ sales_order_id: `g${i}`, product_id: "G", account: "grande" });
  for (let i = 0; i < 10; i++) {
    linhas.push({ sales_order_id: `p${i}`, product_id: "P1", account: "pequena" });
    linhas.push({ sales_order_id: `p${i}`, product_id: "P2", account: "pequena" });
  }
  for (let i = 10; i < 20; i++) linhas.push({ sales_order_id: `p${i}`, product_id: "P3", account: "pequena" });
  return linhas;
}

/** Achata o universo num único segmento — é o comportamento de ANTES desta fatia. */
function comoUmSegmentoSo(linhas: ReturnType<typeof universo>): Cesta[] {
  const m = new Map<string, Set<string>>();
  for (const l of linhas) {
    if (!l.sales_order_id || !l.product_id) continue;
    if (!m.has(l.sales_order_id)) m.set(l.sales_order_id, new Set());
    m.get(l.sales_order_id)!.add(l.product_id);
  }
  return Array.from(m, ([tx, produtos]) => ({ tx, produtos }));
}

Deno.test("o denominador GLOBAL afoga o par da conta menor — 0 regras", () => {
  const r = calcularRegrasDoSegmento("GLOBAL", comoUmSegmentoSo(universo()), P);
  assertEquals(r.totalCestas, 120, "o universo achatado tem 120 cestas");
  assertEquals(r.regras.length, 0, "com denominador global o par P1|P2 não passa o piso");
});

Deno.test("o MESMO piso, por SEGMENTO, preserva o par da conta menor", () => {
  const { porSegmento } = agruparCestasPorSegmento(universo());
  const grande = calcularRegrasDoSegmento("grande", porSegmento.get("grande")!, P);
  const pequena = calcularRegrasDoSegmento("pequena", porSegmento.get("pequena")!, P);

  assertEquals(grande.totalCestas, 100, "a conta grande tem 100 cestas");
  assertEquals(grande.regras.length, 0, "a conta grande não tem par nenhum");

  assertEquals(pequena.totalCestas, 20, "a conta pequena tem 20 cestas");
  assertEquals(pequena.regras.length, 2, "P1→P2 e P2→P1 sobrevivem com o denominador da conta");

  const r = pequena.regras[0];
  assertEquals(r.support, 0.5, "support é RELATIVO ao segmento: 10/20, não 10/120");
  assertEquals(r.confidence, 1, "toda cesta com P1 tem P2");
  assertEquals(r.lift, 2, "lift = confidence / support(P2) = 1 / 0,5");
});

Deno.test("sample_size e cluster_segment carregam a PROVENIÊNCIA do denominador", () => {
  const { porSegmento } = agruparCestasPorSegmento(universo());
  const pequena = calcularRegrasDoSegmento("pequena", porSegmento.get("pequena")!, P);

  for (const regra of pequena.regras) {
    assertEquals(regra.sample_size, 20, "sample_size é o universo DO SEGMENTO, não o total");
    assertEquals(regra.cluster_segment, "pequena", "a regra diz de que conta ela veio");
    assertEquals(regra.rule_type, "association", "rule_type é o que a CHECK da tabela aceita");
  }
  assert(
    pequena.regras.every((r) => r.support >= 0 && r.support <= 1),
    "support fora de [0,1] é recusado pela RPC (TR005) — não pode sair daqui",
  );
});

Deno.test("segmento raso (<5 cestas) não vira regra nem empresta denominador", () => {
  const cestas: Cesta[] = [
    { tx: "a", produtos: new Set(["X", "Y"]) },
    { tx: "b", produtos: new Set(["X", "Y"]) },
    { tx: "c", produtos: new Set(["X", "Y"]) },
  ];
  const r = calcularRegrasDoSegmento("raso", cestas, P);
  assertEquals(r.regras.length, 0, "3 cestas não sustentam publicação, por mais forte que o par pareça");
  assertEquals(r.totalCestas, 3, "mas o total medido continua sendo relatado");
});

Deno.test("o teto corta POR SEGMENTO e DIZ quanto cortou", () => {
  // Dois trios que NUNCA se encontram: 5 cestas {A,B,C} e 5 cestas {D,E,F}.
  // Cada item tem support 0,5; cada par INTRA-trio tem support 0,5 ⇒ confidence 1,0 e
  // lift 1/0,5 = 2,0 (passa o lMin de 1,2). Pares INTER-trio nunca coocorrem, então não
  // entram. Saem 3 pares por trio × 2 trios × 2 direções = 12 regras.
  // (Um fixture com os 6 produtos em TODAS as cestas daria lift 1,0 — abaixo do lMin — e
  // zero regra: o teto pareceria funcionar por não ter o que cortar.)
  const cestas: Cesta[] = [
    ...Array.from({ length: 5 }, (_, i) => ({ tx: `t${i}`, produtos: new Set(["A", "B", "C"]) })),
    ...Array.from({ length: 5 }, (_, i) => ({ tx: `u${i}`, produtos: new Set(["D", "E", "F"]) })),
  ];

  const cheio = calcularRegrasDoSegmento("s", cestas, P);
  assertEquals(cheio.regras.length, 12, "sem teto saem as 12 regras direcionais");
  assertEquals(cheio.truncadas, 0, "nada truncado quando cabe");
  assert(cheio.regras.every((r) => r.lift === 2), "todas com lift 2,0 — acima do lMin de 1,2");

  const apertado = calcularRegrasDoSegmento("s", cestas, { ...P, maxRegras: 4 });
  assertEquals(apertado.regras.length, 4, "o teto corta");
  assertEquals(apertado.truncadas, 8, "e o corte é CONTADO — teto que trunca calado fabrica completude");
});

Deno.test("linha sem conta/pedido/produto é descartada e CONTADA, nunca atribuída a um segmento", () => {
  const linhas = [
    { sales_order_id: "o1", product_id: "A", account: "colacor" },
    { sales_order_id: "o1", product_id: "B", account: "colacor" },
    { sales_order_id: "o2", product_id: "C", account: null }, // conta ausente
    { sales_order_id: null, product_id: "D", account: "oben" }, // pedido ausente
    { sales_order_id: "o3", product_id: null, account: "oben" }, // produto ausente
  ];
  const { porSegmento, descartadas } = agruparCestasPorSegmento(linhas);

  assertEquals(descartadas, 3, "as três linhas incompletas são contadas, não engolidas");
  assertEquals(Array.from(porSegmento.keys()), ["colacor"], "conta ausente NÃO vira segmento nem cai na outra");
  assertEquals(porSegmento.get("colacor")!.length, 1, "o pedido o1 é UMA cesta");
  assertEquals(
    Array.from(porSegmento.get("colacor")![0].produtos).sort(),
    ["A", "B"],
    "com os dois produtos dele",
  );
});

Deno.test("a ordem dos segmentos é estável — dois recomputes são comparáveis", () => {
  const linhas = [
    { sales_order_id: "o1", product_id: "A", account: "oben" },
    { sales_order_id: "o2", product_id: "B", account: "colacor" },
    { sales_order_id: "o3", product_id: "C", account: "zzz" },
  ];
  assertEquals(
    Array.from(agruparCestasPorSegmento(linhas).porSegmento.keys()),
    ["colacor", "oben", "zzz"],
    "segmentos saem ordenados pelo nome, independente da ordem de leitura",
  );
});

Deno.test("o mesmo pedido lido em várias linhas é UMA cesta, não N", () => {
  // Se a cesta contasse por LINHA, o denominador inflaria e todo support encolheria em
  // silêncio — a mesma família de defeito que esta fatia corrige, um nível abaixo.
  const linhas = Array.from({ length: 8 }, (_, i) => ({
    sales_order_id: "unico",
    product_id: `P${i}`,
    account: "c",
  }));
  const { porSegmento } = agruparCestasPorSegmento(linhas);
  assertEquals(porSegmento.get("c")!.length, 1, "8 linhas do mesmo pedido = 1 cesta");
  assertEquals(porSegmento.get("c")![0].produtos.size, 8, "com os 8 produtos");
});
