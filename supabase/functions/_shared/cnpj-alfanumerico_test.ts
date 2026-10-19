// Testa o CÓDIGO REAL de _shared/cnpj-alfanumerico.ts no runtime real (Deno).
// Roda com: deno test --no-remote supabase/functions/_shared/cnpj-alfanumerico_test.ts
//
// Contrato com o SQL: `radar_recruzar_ja_cliente()` (migration 20261019110000) só casa o
// documento gravado se `regexp_replace(btrim(upper(doc)), '[-./]', '', 'g') ~ '^[0-9A-Z]{12}[0-9]{2}$'`.
// O literal `12ABC34501DE35` abaixo é o MESMO semeado em `db/test-radar-recruzar-origem-omie.sh`:
// este teste prova que o escritor emite esse byte; o SQL prova que o recruzar o marca.
import { CNPJ_RE, cnpjValido, documentoParaCadastro, dvCnpj, ehCnpjAlfanumerico, normalizarDocumento } from "./cnpj-alfanumerico.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${msg ?? "assertEquals"}\n  esperado: ${JSON.stringify(b)}\n  recebido: ${JSON.stringify(a)}`);
  }
}

// Oráculo externo: exemplo OFICIAL da RFB (12.ABC.345/01DE-35).
Deno.test("dvCnpj reproduz o exemplo oficial da RFB", () => {
  assertEquals(dvCnpj("12ABC34501DE"), "35");
});

Deno.test("dvCnpj coincide com a regra clássica para base numérica (e resto<2 → 0)", () => {
  assertEquals(dvCnpj("000001230001"), "22");
  assertEquals(dvCnpj("998887770001"), "00");
});

Deno.test("cnpjValido: formato E DV; minúscula é inválida (fail-closed no validador cru)", () => {
  assertEquals(cnpjValido("12ABC34501DE35"), true);
  assertEquals(cnpjValido("12ABC34501DE36"), false);
  assertEquals(cnpjValido("12abc34501DE35"), false);
  assertEquals(CNPJ_RE.test("12ABC34501DE3A"), false);
});

// ── normalizarDocumento: o contrato dos ESCRITORES ────────────────────────────────────────────
// Invariante 1: CPF/CNPJ numérico (com ou sem máscara) → byte-idêntico ao `.replace(/\D/g, "")` de hoje.
Deno.test("numérico: byte-idêntico ao só-dígitos atual (máscara, espaços, vazio, null)", () => {
  const casos: unknown[] = [
    "12.345.678/0001-90", "12345678000190", "123.456.789-09", "12345678909",
    " 12.345.678/0001-90 ", "", null, undefined, "CPF: 123.456.789-09", "abc", "12 345", "1234567800019A",
    "12345678000191", // DV numérico errado: segue só-dígitos como hoje (o escritor nunca validou DV)
  ];
  for (const c of casos) {
    assertEquals(normalizarDocumento(c), String(c ?? "").replace(/\D/g, ""), `caso ${JSON.stringify(c)}`);
  }
});

// Invariante 2: CNPJ alfanumérico VÁLIDO → upper, sem separadores de máscara, letras preservadas.
Deno.test("alfanumérico válido: preserva letras, tira máscara, sobe caixa", () => {
  assertEquals(normalizarDocumento("12.ABC.345/01DE-35"), "12ABC34501DE35");
  assertEquals(normalizarDocumento("12ABC34501DE35"), "12ABC34501DE35");
  assertEquals(normalizarDocumento("12abc34501de35"), "12ABC34501DE35");
  assertEquals(normalizarDocumento("  12.abc.345/01de-35\n"), "12ABC34501DE35");
});

// Invariante 3: o que sai no caminho alfanumérico SEMPRE passa no filtro do SQL (CNPJ_RE).
Deno.test("alfanumérico válido satisfaz o regex do recruzar (contrato SQL)", () => {
  const out = normalizarDocumento("12.ABC.345/01DE-35");
  assertEquals(CNPJ_RE.test(out), true);
  assertEquals(ehCnpjAlfanumerico(out), true);
});

// Invariante 4: letra SEM DV válido ou fora do formato → cai no só-dígitos de hoje (nunca inventa doc).
Deno.test("alfanumérico inválido: DV errado / formato errado → só-dígitos (comportamento atual)", () => {
  assertEquals(normalizarDocumento("12.ABC.345/01DE-36"), "123450136");
  assertEquals(normalizarDocumento("12ABC34501DE3"), "12345013");
  assertEquals(normalizarDocumento("12 ABC34501DE35"), "123450135"); // espaço interno não é separador (espelha o SQL)
  assertEquals(ehCnpjAlfanumerico("123450136"), false);
  assertEquals(ehCnpjAlfanumerico("12345678000190"), false); // numérico não é "alfanumérico"
});

// ── documentoParaCadastro: o ramo de IncluirCliente ────────────────────────────────────────────
Deno.test("documentoParaCadastro: numérico passa como hoje; alfanumérico válido passa com letras", () => {
  assertEquals(documentoParaCadastro("12.345.678/0001-90"), "12345678000190");
  assertEquals(documentoParaCadastro("CPF: 123.456.789-09"), "12345678909");
  assertEquals(documentoParaCadastro("12.ABC.345/01DE-35"), "12ABC34501DE35");
});

Deno.test("documentoParaCadastro: letra DEPOIS do 1º dígito sem CNPJ alfanumérico válido → lança com a marca do ramo", () => {
  // 12ABC34501DE36 = DV errado → antes virava "CPF" de 9 dígitos; 123ABC45678909 = CNPJ inválido cujos
  // dígitos formam o CPF 12345678909 de OUTRA pessoa (Codex MÉDIO) — os dois têm de lançar.
  for (const bruto of ["12.ABC.345/01DE-36", "123ABC45678909", "1234567800019A"]) {
    let msg = "";
    try {
      documentoParaCadastro(bruto);
    } catch (e) {
      msg = (e as Error).message;
    }
    assertEquals(msg.includes("cadastro recusado"), true, `bruto ${bruto}: mensagem ${JSON.stringify(msg)}`);
  }
});
