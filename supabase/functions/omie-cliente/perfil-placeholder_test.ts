// Sem rede (`--no-remote` do test:edges): assert inline.
import { linhaPerfilPlaceholder, ORIGEM_PERFIL_PLACEHOLDER } from "./perfil-placeholder.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (a !== b) throw new Error(msg ?? `esperado ${String(b)}, veio ${String(a)}`);
}

const BASE = {
  userId: "00000000-0000-0000-0000-000000000001",
  nomeFantasia: "Marcenaria Exemplo",
  razaoSocial: "Exemplo Móveis Ltda",
  email: "compras@exemplo.com.br",
  phone: "(47) 3333-4444",
  document: "12345678000190",
};

Deno.test("linhaPerfilPlaceholder: marca a origem omie_import (o que tira o fantasma da fila, C7)", () => {
  assertEquals(ORIGEM_PERFIL_PLACEHOLDER, "omie_import");
  assertEquals(linhaPerfilPlaceholder(BASE).prospect_source, "omie_import");
});

Deno.test("linhaPerfilPlaceholder: preserva os campos que o insert gravava antes", () => {
  const l = linhaPerfilPlaceholder(BASE);
  assertEquals(l.user_id, BASE.userId);
  assertEquals(l.name, "Marcenaria Exemplo");
  assertEquals(l.email, "compras@exemplo.com.br");
  assertEquals(l.phone, "(47) 3333-4444");
  assertEquals(l.document, "12345678000190");
});

Deno.test("linhaPerfilPlaceholder: nome cai para razão social e depois para 'Cliente'; e-mail vazio vira null", () => {
  assertEquals(linhaPerfilPlaceholder({ ...BASE, nomeFantasia: "" }).name, "Exemplo Móveis Ltda");
  assertEquals(linhaPerfilPlaceholder({ ...BASE, nomeFantasia: null, razaoSocial: null }).name, "Cliente");
  assertEquals(linhaPerfilPlaceholder({ ...BASE, email: "" }).email, null);
  assertEquals(linhaPerfilPlaceholder({ ...BASE, email: undefined }).email, null);
});

Deno.test("linhaPerfilPlaceholder: NÃO aprova (sem is_approved: vale o default false da coluna)", () => {
  const l = linhaPerfilPlaceholder(BASE) as unknown as Record<string, unknown>;
  assertEquals("is_approved" in l, false, "a linha não pode carregar is_approved");
  assertEquals("is_employee" in l, false, "a linha não pode carregar is_employee");
  assertEquals(Object.keys(l).sort().join(","), "document,email,name,phone,prospect_source,user_id");
});

// Forma do index.ts: TODO insert em `profiles` desta edge passa pelo helper. Um terceiro escritor
// que volte a montar a linha à mão recria o C7 (perfil sem origem caindo na fila de aprovações).
Deno.test("index.ts: os 2 inserts em profiles usam linhaPerfilPlaceholder, nenhum monta a linha à mão", async () => {
  const fonte = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const inserts = [...fonte.matchAll(/\.from\(\s*["']profiles["']\s*\)\s*\.insert\(\s*([A-Za-z_{]+)/g)];
  assertEquals(inserts.length, 2, `esperava 2 inserts em profiles, achei ${inserts.length}`);
  for (const m of inserts) {
    assertEquals(m[1], "linhaPerfilPlaceholder", `insert em profiles sem o helper: começa com '${m[1]}'`);
  }
  // `upsert` em profiles também criaria linha: nenhum é tolerado sem passar por aqui.
  assertEquals(/\.from\(\s*["']profiles["']\s*\)\s*\.upsert\(/.test(fonte), false, "upsert em profiles");
});
