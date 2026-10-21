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
});

// Invariante 3 (Codex retroativo do #3175, PR #3192): separador só conta na POSIÇÃO EXATA da máscara.
// Tirar `[-./]` de qualquer posição transforma "aeg-123.456.789-09" (CPF com anotação) no CNPJ
// alfanumérico AEG12345678909, cujo DV confere POR COINCIDÊNCIA — e o escritor gravava o documento
// inflado em `omie_clientes_nao_vinculados.cnpj_cpf`. Espelha `normalizar_documento()` (migration
// 20261019140000) e `radar_recruzar_ja_cliente()` (20261019150000): cru OU máscara exata, só então remove.
Deno.test("máscara exata: separador fora da posição da máscara NÃO cola um CNPJ alfanumérico", () => {
  assertEquals(normalizarDocumento("aeg-123.456.789-09"), "12345678909"); // CPF anotado → só-dígitos
  assertEquals(normalizarDocumento("AEG-123.456.789-09"), "12345678909");
  assertEquals(normalizarDocumento("12ABC.34501DE-35"), "123450135"); // máscara fora de posição → só-dígitos
  assertEquals(normalizarDocumento("12.ABC.345/01DE-35"), "12ABC34501DE35"); // máscara exata → chave alnum
  assertEquals(normalizarDocumento("12ABC34501DE35"), "12ABC34501DE35"); // cru → chave alnum
  assertEquals(normalizarDocumento("12-ABC-345-01DE-35"), "123450135"); // separador certo, posição/tipo errados
  assertEquals(normalizarDocumento("12.ABC.345/01DE-35."), "123450135"); // separador sobrando no fim
  // Prova de que o caso é real: o resultado inflado de antes ERA um CNPJ alfanumérico válido.
  assertEquals(ehCnpjAlfanumerico("AEG12345678909"), true);
});

Deno.test("máscara exata: documentoParaCadastro NÃO herda o só-dígitos do normalizar (anotação ≠ rótulo)", () => {
  // normalizarDocumento("aeg-123.456.789-09") segue "12345678909" (chave de comparação, acima); para
  // CADASTRAR, "aeg-" não é rótulo da gramática → recusa (Codex ALTO 2026-10-20, rótulo heurístico).
  assertEquals(marcaDaRecusa("aeg-123.456.789-09"), "DOC_LETRA_FORA_DO_ROTULO");
  // letra depois do 1º dígito e máscara fora de posição → recusa
  assertEquals(marcaDaRecusa("12ABC.34501DE-35"), "DOC_LETRA_FORA_DO_ROTULO");
  assertEquals(ehCnpjAlfanumerico("123450136"), false);
  assertEquals(ehCnpjAlfanumerico("12345678000190"), false); // numérico não é "alfanumérico"
});

// ── documentoParaCadastro: o ramo de IncluirCliente ────────────────────────────────────────────
/** A marca do ramo que recusou (`DOC_…`), ou "PASSOU:<retorno>" — nunca "lançou algo". */
function marcaDaRecusa(bruto: unknown): string {
  try {
    return `PASSOU:${documentoParaCadastro(bruto)}`;
  } catch (e) {
    const msg = (e as Error).message;
    const marca = /^(DOC_[A-Z_]+):/.exec(msg)?.[1];
    if (!marca || !msg.includes("cadastro recusado")) throw e; // erro que não é recusa do ramo → re-lança
    return marca;
  }
}

Deno.test("documentoParaCadastro: numérico passa como hoje; alfanumérico válido passa com letras", () => {
  assertEquals(documentoParaCadastro("12.345.678/0001-90"), "12345678000190");
  assertEquals(documentoParaCadastro("CPF: 123.456.789-09"), "12345678909");
  assertEquals(documentoParaCadastro("12.ABC.345/01DE-35"), "12ABC34501DE35");
});

Deno.test("documentoParaCadastro: letra DEPOIS do 1º dígito sem CNPJ alfanumérico válido → lança com a marca do ramo", () => {
  // 12ABC34501DE36 = DV errado → antes virava "CPF" de 9 dígitos; 123ABC45678909 = CNPJ inválido cujos
  // dígitos formam o CPF 12345678909 de OUTRA pessoa (Codex MÉDIO) — os dois têm de lançar.
  for (const bruto of ["12.ABC.345/01DE-36", "123ABC45678909", "1234567800019A"]) {
    assertEquals(marcaDaRecusa(bruto), "DOC_LETRA_FORA_DO_ROTULO", `bruto ${bruto}`);
  }
});

// ── Gramática de rótulo (Codex ALTO 2026-10-20: "ABC12345678909" virava o CPF 12345678909) ──────
Deno.test("rótulo: letra antes do 1º dígito que NÃO é rótulo CPF/CNPJ recusa — nunca devolve o CPF alheio", () => {
  for (const bruto of [
    "ABC12345678909", // o achado
    "abc123.456.789-09",
    "AEG 123.456.789-09",
    "Doc: 123.456.789-09",
    "C.P.F. 123.456.789-09",
    "CPF-123.456.789-09", // hífen não é separador de rótulo
    "CPF12345678909", // rótulo colado não é rótulo
    "CPFCNPJ: 12345678909",
    "RG: 12345678909",
    "ÇPF: 123.456.789-09",
    "ÉÇ 123.456.789-09", // SÓ letra acentuada — também é letra (não só [A-Za-z])
    "CPF: CPF: 123.456.789-09", // só UM rótulo
    "CPF: 123.456.789-09 (titular)", // letra DEPOIS também
  ]) {
    assertEquals(marcaDaRecusa(bruto), "DOC_LETRA_FORA_DO_ROTULO", `bruto ${JSON.stringify(bruto)}`);
  }
});

Deno.test("rótulo: CPF:/CNPJ:/CPF /CNPJ  em qualquer caixa são removidos", () => {
  const casos: Array<[string, string]> = [
    ["CPF: 123.456.789-09", "12345678909"],
    ["CPF:123.456.789-09", "12345678909"],
    ["cpf : 123.456.789-09", "12345678909"],
    ["CPF 12345678909", "12345678909"],
    ["  Cpf   123.456.789-09  ", "12345678909"],
    ["CNPJ: 12.345.678/0001-90", "12345678000190"],
    ["cnpj 12345678000190", "12345678000190"],
    ["CNPJ: 12.ABC.345/01DE-35", "12ABC34501DE35"],
    ["cnpj 12abc34501de35", "12ABC34501DE35"],
  ];
  for (const [bruto, esperado] of casos) {
    assertEquals(marcaDaRecusa(bruto), `PASSOU:${esperado}`, `bruto ${JSON.stringify(bruto)}`);
  }
});

Deno.test("rótulo que contradiz o tamanho recusa (CPF ≠ 11, CNPJ ≠ 14)", () => {
  for (const bruto of ["CPF: 12.345.678/0001-90", "CNPJ: 123.456.789-09", "CPF: 12.ABC.345/01DE-35", "CPF: 1234567890"]) {
    assertEquals(marcaDaRecusa(bruto), "DOC_ROTULO_DIVERGENTE", `bruto ${JSON.stringify(bruto)}`);
  }
});

Deno.test("sem dígito recusa (ausente ≠ documento vazio)", () => {
  for (const bruto of ["CPF:", "CNPJ: ", "---", "", null, undefined]) {
    assertEquals(marcaDaRecusa(bruto), "DOC_SEM_DIGITO", `bruto ${JSON.stringify(bruto)}`);
  }
});

Deno.test("numérico com máscara e alfanumérico válido (cru, máscara, minúsculo) passam sem rótulo", () => {
  const casos: Array<[unknown, string]> = [
    ["123.456.789-09", "12345678909"],
    ["12345678909", "12345678909"],
    ["12.345.678/0001-90", "12345678000190"],
    [" 12 345 678 0001 90 ", "12345678000190"], // numérico segue o `.replace(/\D/g, "")` de sempre
    [12345678909, "12345678909"],
    ["12ABC34501DE35", "12ABC34501DE35"],
    ["12.ABC.345/01DE-35", "12ABC34501DE35"],
    ["12abc34501de35", "12ABC34501DE35"],
    ["12.abc.345/01de-35", "12ABC34501DE35"],
  ];
  for (const [bruto, esperado] of casos) {
    assertEquals(marcaDaRecusa(bruto), `PASSOU:${esperado}`, `bruto ${JSON.stringify(bruto)}`);
  }
});

Deno.test("alfanumérico com DV errado ou letra no DV recusa, com ou sem rótulo", () => {
  for (const bruto of ["12ABC34501DE36", "CNPJ: 12ABC34501DE36", "1234567800019A", "cnpj 12abc34501de36"]) {
    assertEquals(marcaDaRecusa(bruto), "DOC_LETRA_FORA_DO_ROTULO", `bruto ${JSON.stringify(bruto)}`);
  }
});
