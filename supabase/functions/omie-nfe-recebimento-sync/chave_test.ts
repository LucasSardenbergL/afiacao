// Testa o CÓDIGO REAL de chave.ts no runtime real (Deno).
// Roda com: deno test supabase/functions/omie-nfe-recebimento-sync/chave_test.ts
//
// O caminho por chave substitui o botão que chamava `omie-nfe-webhook` (401 sempre: o browser não
// tem o segredo do webhook). Os casos que importam: a falha transitória do Omie vira "aguarde",
// não erro; o texto do Omie que vai ao browser sai sem a app_key; e nada é importado quando o
// detalhe não é a NF-e pedida, está cancelada ou já foi recebida no Omie.
import { avaliarDetalhePorChave, classificarConsultaPorChave, normalizarChaveAcesso } from "./chave.ts";

function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(msg ?? `assertEquals falhou: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`);
  }
}

const CHAVE = "31260912345678000190550010000123451000123456";

Deno.test("normalizarChaveAcesso: 44 dígitos, com os espaços do DANFE tolerados", () => {
  assertEquals(normalizarChaveAcesso(CHAVE), CHAVE);
  assertEquals(normalizarChaveAcesso(CHAVE.replace(/(\d{4})/g, "$1 ").trim()), CHAVE);
});

Deno.test("normalizarChaveAcesso: o que não é chave vira null", () => {
  assertEquals(normalizarChaveAcesso(CHAVE.slice(1)), null, "43 dígitos");
  assertEquals(normalizarChaveAcesso(`${CHAVE.slice(1)}X`), null, "letra no meio");
  assertEquals(normalizarChaveAcesso(undefined), null);
  assertEquals(normalizarChaveAcesso(Number(CHAVE.slice(0, 15))), null, "número não é string");
});

Deno.test("classificarConsultaPorChave: consumo redundante vira aguardar com os segundos do Omie", () => {
  const r = classificarConsultaPorChave(500, {
    faultstring: "Consumo redundante detectado. Aguarde 37 segundos (REDUNDANT)",
  });
  assertEquals(r.tipo, "aguardar");
  assertEquals(r.tipo === "aguardar" ? r.segundos : "?", 37);
});

Deno.test("classificarConsultaPorChave: requisição do mesmo método em curso também é aguardar", () => {
  const r = classificarConsultaPorChave(500, {
    faultstring: "Já existe uma requisição desse método sendo executada",
  });
  assertEquals(r.tipo === "aguardar" ? r.segundos : r.tipo, null);
});

Deno.test("classificarConsultaPorChave: falha não transitória é recusada — com a app_key redigida", () => {
  const r = classificarConsultaPorChave(500, {
    faultstring: "Chave de acesso não cadastrada para o aplicativo [1503123456]",
  });
  assertEquals(r.tipo, "recusada");
  const mensagem = r.tipo === "recusada" ? r.mensagem : "";
  assertEquals(mensagem.includes("1503123456"), false, "a app_key vazou para a resposta");
  assertEquals(mensagem.includes("[redigido]"), true);
});

Deno.test("classificarConsultaPorChave: sem faultstring, o status e o cabeçalho decidem", () => {
  assertEquals(classificarConsultaPorChave(502, "<html>Bad Gateway</html>").tipo, "erro");
  assertEquals(classificarConsultaPorChave(200, { infoCadastro: {} }).tipo, "erro", "200 sem cabec");
  assertEquals(classificarConsultaPorChave(200, { cabec: { cChaveNFe: CHAVE } }).tipo, "ok");
});

Deno.test("avaliarDetalhePorChave: a NF-e pedida, aberta e não recebida é importável", () => {
  assertEquals(
    avaliarDetalhePorChave({ cabec: { cChaveNFe: CHAVE, nIdReceb: 1234567 }, infoCadastro: {} }, CHAVE),
    { tipo: "importavel", nIdReceb: 1234567 },
  );
  assertEquals(
    avaliarDetalhePorChave({ cabec: { cChaveNfe: CHAVE, nIdReceb: "1234567" } }, CHAVE),
    { tipo: "importavel", nIdReceb: 1234567 },
    "a grafia cChaveNfe e o nIdReceb em string também valem",
  );
});

Deno.test("avaliarDetalhePorChave: outra NF-e, cancelada, já recebida ou sem nIdReceb — nada importa", () => {
  const status = (d: Parameters<typeof avaliarDetalhePorChave>[0]) => {
    const r = avaliarDetalhePorChave(d, CHAVE);
    return r.tipo === "recusada" ? r.status : r.tipo;
  };
  assertEquals(status({ cabec: { cChaveNFe: `${CHAVE.slice(0, 43)}9`, nIdReceb: 1 } }), "chave_divergente");
  assertEquals(status({ cabec: { nIdReceb: 1 } }), "chave_divergente", "chave ausente no detalhe");
  assertEquals(status({ cabec: { cChaveNFe: CHAVE, nIdReceb: 1 }, infoCadastro: { cCancelada: "S" } }), "cancelada");
  assertEquals(status({ cabec: { cChaveNFe: CHAVE, nIdReceb: 1 }, infoCadastro: { cRecebido: "S" } }), "ja_recebida_no_omie");
  assertEquals(status({ cabec: { cChaveNFe: CHAVE, nIdReceb: "12a" } }), "sem_id_recebimento");
  assertEquals(status({ cabec: { cChaveNFe: CHAVE } }), "sem_id_recebimento");
});
