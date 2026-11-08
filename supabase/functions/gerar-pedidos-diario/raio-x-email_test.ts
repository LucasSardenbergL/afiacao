// `eq`/`ok` locais em vez de std/assert remoto: `test:edges` roda com `--no-remote`.
import { blocoRaioXHtml, CAMINHO_RAIO_X, lerResumoRaioX, resumirRaioX } from "./raio-x-email.ts";

function eq(atual: unknown, esperado: unknown, msg: string) {
  if (JSON.stringify(atual) !== JSON.stringify(esperado)) {
    throw new Error(`${msg}: esperado ${JSON.stringify(esperado)}, veio ${JSON.stringify(atual)}`);
  }
}
function ok(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

const FOTO = "2026-11-01T18:25:26Z";
const coorte = [
  { sku_codigo_omie: 1, valor: 1000, congelada_em: FOTO },
  { sku_codigo_omie: 2, valor: "500.5", congelada_em: FOTO },
  { sku_codigo_omie: 3, valor: null, congelada_em: FOTO },
  { sku_codigo_omie: 4, valor: 200, congelada_em: FOTO },
];

Deno.test("raio-x e-mail: pendente = sem decisão com destino; valor congelado soma só quem tem custo", () => {
  const r = resumirRaioX(coorte, [
    { sku_codigo_omie: 4, destino: "liquidar" },
    { sku_codigo_omie: 2, destino: null }, // linha sem destino ainda é pendente
  ]);
  eq(r, { tipo: "ok", total: 4, pendentes: 3, valorPendentes: 1500.5, semCusto: 1, fotoEm: "01/11" }, "resumo");
  const html = blocoRaioXHtml(r, "https://app");
  ok(html.includes("Raio-X: 3 pendentes do Top 61"), "conta os pendentes");
  ok(html.includes("parado na foto de 01/11"), "rotula o valor como o da foto");
  ok(html.includes("+ 1 sem custo"), "sem custo não vira R$ 0");
  ok(html.includes(`href="https://app${CAMINHO_RAIO_X}"`), "link da fila com origem=email");
  ok(CAMINHO_RAIO_X.endsWith("&origem=email"), "origem do sensor no link");
  ok(html.includes("Decidir agora"), "chamada");
});

Deno.test("raio-x e-mail: ausente ≠ zero — leitura falhou vira indisponível, nunca 0 pendentes", () => {
  for (const r of [resumirRaioX(null, null), resumirRaioX(coorte, null)]) {
    eq(r.tipo, "indisponivel", "tipo");
    const html = blocoRaioXHtml(r, "https://app");
    ok(html.includes("Raio-X: indisponível"), "diz indisponível");
    ok(!/\b0 pendentes/.test(html), "nunca 0 pendentes");
  }
});

Deno.test("raio-x e-mail: empresa sem coorte → sem bloco", () => {
  eq(resumirRaioX([], []).tipo, "sem_coorte", "coorte vazia");
  eq(blocoRaioXHtml({ tipo: "sem_coorte" }, "https://app"), "", "html vazio");
});

Deno.test("raio-x e-mail: todos os pendentes sem custo → valor indisponível, nunca R$ 0", () => {
  const r = resumirRaioX([{ sku_codigo_omie: 9, valor: null, congelada_em: FOTO }], []);
  eq(r.tipo === "ok" ? r.valorPendentes : "x", null, "valor null");
  const html = blocoRaioXHtml(r, "https://app");
  ok(html.includes("valor indisponível"), "diz indisponível");
  ok(!html.includes("R$"), "sem R$ fabricado");
});

Deno.test("raio-x e-mail: tudo decidido é zero REAL (lido), não ausência", () => {
  const r = resumirRaioX(coorte, coorte.map((c) => ({ sku_codigo_omie: c.sku_codigo_omie, destino: "estrategico" })));
  const html = blocoRaioXHtml(r, "https://app");
  ok(html.includes("Top 61 todo decidido (4 de 4)"), "fechado");
});

// Fake do supabase-js: encadeia e devolve o resultado configurado por tabela.
function fakeDb(res: Record<string, { data: unknown; error: { message: string } | null } | "throw">) {
  const chamadas: string[] = [];
  return {
    chamadas,
    from(t: string) {
      chamadas.push(t);
      const r = res[t];
      const q: Record<string, unknown> = {};
      for (const m of ["select", "eq", "order", "in"]) q[m] = () => q;
      q.then = (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) =>
        r === "throw" ? Promise.reject(new Error("rede")).then(ok, ko) : Promise.resolve(r).then(ok, ko);
      return q;
    },
  };
}

Deno.test("raio-x e-mail: leitor — OBEN lê coorte de 'oben'; erro em decisões → indisponível", async () => {
  const db = fakeDb({
    raio_x_coorte_top: { data: coorte, error: null },
    raio_x_decisao: { data: null, error: { message: "permission denied" } },
  });
  eq((await lerResumoRaioX(db, "OBEN")).tipo, "indisponivel", "decisões com erro");
  eq(db.chamadas, ["raio_x_coorte_top", "raio_x_decisao"], "tabelas lidas");
});

Deno.test("raio-x e-mail: leitor — erro/throw na coorte → indisponível; empresa desconhecida → sem bloco", async () => {
  eq((await lerResumoRaioX(fakeDb({ raio_x_coorte_top: { data: null, error: { message: "x" } } }), "OBEN")).tipo,
    "indisponivel", "erro na coorte");
  eq((await lerResumoRaioX(fakeDb({ raio_x_coorte_top: "throw" }), "OBEN")).tipo, "indisponivel", "throw");
  const db = fakeDb({});
  eq((await lerResumoRaioX(db, "XPTO")).tipo, "sem_coorte", "fora do domínio");
  eq(db.chamadas.length, 0, "nem consulta");
});

Deno.test("raio-x e-mail: leitor — caminho feliz", async () => {
  const db = fakeDb({
    raio_x_coorte_top: { data: coorte, error: null },
    raio_x_decisao: { data: [{ sku_codigo_omie: 1, destino: "trocar" }], error: null },
  });
  const r = await lerResumoRaioX(db, "OBEN");
  eq(r.tipo === "ok" ? [r.pendentes, r.valorPendentes] : r, [3, 700.5], "pendentes e valor");
});
