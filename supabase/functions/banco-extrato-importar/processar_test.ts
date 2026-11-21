// Testes de `processar` com deps falsas (sem rede). Roda com:
//   deno test --no-remote --allow-read=supabase/functions supabase/functions/banco-extrato-importar/
import { dataEmSaoPaulo, processar, type Deps, type Entrada } from "./processar.ts";
import { chavesDasLinhas } from "../_shared/extrato-nucleo.ts";
import { ESTRATEGIA_CHAVE_PADRAO } from "./versao.ts";

const CONTA = "11111111-1111-4111-8111-111111111111";
const USUARIO = { id: "22222222-2222-4222-8222-222222222222" };
const enc = (s: string) => new TextEncoder().encode(s);
type CorpoErroParse = { erro_parse: { motivo: unknown; detalhe?: unknown } };

function igual(recebido: unknown, esperado: unknown, msg: string): void {
  const a = JSON.stringify(recebido), b = JSON.stringify(esperado);
  if (a !== b) throw new Error(`${msg}\n  recebido: ${a}\n  esperado: ${b}`);
}

// Agência 0000 / conta 000000: nada de número real em fixture.
const OFX = [
  "OFXHEADER:100", "DATA:OFXSGML", "VERSION:102", "SECURITY:NONE", "ENCODING:USASCII",
  "CHARSET:1252", "COMPRESSION:NONE", "OLDFILEUID:NONE", "NEWFILEUID:NONE", "",
  "<OFX>", "<SIGNONMSGSRSV1>", "<SONRS>", "<STATUS><CODE>0<SEVERITY>INFO</STATUS>",
  "<DTSERVER>20261120101500[-3:BRT]", "<LANGUAGE>POR", "</SONRS>", "</SIGNONMSGSRSV1>",
  "<BANKMSGSRSV1>", "<STMTTRNRS>", "<TRNUID>1", "<STATUS><CODE>0<SEVERITY>INFO</STATUS>",
  "<STMTRS>", "<CURDEF>BRL", "<BANKACCTFROM>", "<BANKID>0341", "<BRANCHID>0000",
  "<ACCTID>000000", "<ACCTTYPE>CHECKING", "</BANKACCTFROM>", "<BANKTRANLIST>",
  "<DTSTART>20261101000000[-3:BRT]", "<DTEND>20261120000000[-3:BRT]",
  "<STMTTRN>", "<TRNTYPE>DEBIT", "<DTPOSTED>20261103000000[-3:BRT]", "<TRNAMT>-1234.56",
  "<FITID>202611030001", "<CHECKNUM>000123", "<MEMO>TARIFA PACOTE", "</STMTTRN>",
  "<STMTTRN>", "<TRNTYPE>CREDIT", "<DTPOSTED>20261119000000[-3:BRT]", "<TRNAMT>5000.00",
  "<FITID>202611190002", "<REFNUM>REF9", "<NAME>PIX RECEBIDO", "</STMTTRN>",
  "</BANKTRANLIST>", "<LEDGERBAL>", "<BALAMT>-250.10", "<DTASOF>20261119000000[-3:BRT]",
  "</LEDGERBAL>", "</STMTRS>", "</STMTTRNRS>", "</BANKMSGSRSV1>", "</OFX>",
].join("\n");

interface Falsas {
  deps: Deps;
  baixados: string[];
  registrados: Record<string, unknown>[];
}
function falsas(
  bytes: Uint8Array,
  resposta: unknown = { resultado: "aceito" },
  agora = new Date("2026-11-20T12:00:00Z"),
): Falsas {
  const baixados: string[] = [];
  const registrados: Record<string, unknown>[] = [];
  return {
    baixados,
    registrados,
    deps: {
      baixar: (p) => { baixados.push(p); return Promise.resolve(bytes); },
      registrar: (p) => { registrados.push(p); return Promise.resolve(resposta); },
      agora: () => agora,
    },
  };
}
const entrada = (over: Partial<Entrada> = {}): Entrada => ({
  storage_path: `${CONTA}/abc.ofx`,
  banco_conta_id: CONTA,
  estrategia_chave: null,
  ...over,
});

Deno.test("path de outra conta -> 400 e nem baixa", async () => {
  const f = falsas(enc(OFX));
  const r = await processar(f.deps, entrada({ storage_path: `99999999-9999-4999-8999-999999999999/abc.ofx` }), USUARIO);
  igual(r.status, 400, "status");
  igual(f.baixados, [], "nao pode baixar de outra pasta");
  igual(f.registrados.length, 0, "nao registra");
});

Deno.test("prefixo parecido sem barra (CONTA + 'x/') -> 400", async () => {
  const f = falsas(enc(OFX));
  const r = await processar(f.deps, entrada({ storage_path: `${CONTA}x/abc.ofx` }), USUARIO);
  igual(r.status, 400, "status");
});

Deno.test("path com .. ou subpasta -> 400", async () => {
  const f = falsas(enc(OFX));
  for (const p of [`${CONTA}/../x.ofx`, `${CONTA}/a/b.ofx`, `${CONTA}/`]) {
    const r = await processar(f.deps, entrada({ storage_path: p }), USUARIO);
    igual(r.status, 400, `status para ${p}`);
  }
});

Deno.test("OFX valido -> registrar com 1 linha por STMTTRN e as chaves de chavesDasLinhas", async () => {
  const f = falsas(enc(OFX));
  const r = await processar(f.deps, entrada(), USUARIO);
  igual(r.status, 200, "status");
  igual(r.corpo, { resultado: "aceito" }, "corpo = JSON da RPC");
  igual(f.baixados, [`${CONTA}/abc.ofx`], "baixou o path");
  igual(f.registrados.length, 1, "registrar 1x");
  const p = f.registrados[0] as Record<string, unknown>;
  igual(p.banco_conta_id, CONTA, "banco_conta_id");
  igual(p.formato, "ofx", "formato");
  igual(p.storage_path, `${CONTA}/abc.ofx`, "storage_path");
  igual(p.enviado_por, USUARIO.id, "enviado_por");
  igual(p.estrategia_chave, ESTRATEGIA_CHAVE_PADRAO, "estrategia padrao quando a conta e null");
  igual(p.hoje, "2026-11-20", "hoje");
  igual(/^[0-9a-f]{64}$/.test(String(p.sha256)), true, "sha256 hex minusculo");
  const dig = await crypto.subtle.digest("SHA-256", enc(OFX));
  igual(p.sha256, [...new Uint8Array(dig)].map((b) => b.toString(16).padStart(2, "0")).join(""), "sha256 sobre os bytes");
  igual(typeof p.gerado_em, "string", "gerado_em string");
  igual(/(Z|[+-]\d{2}:?\d{2})$/.test(String(p.gerado_em)), true, "gerado_em com fuso");
  const ext = p.extrato as Record<string, unknown>;
  igual(ext.agencia, "0000", "agencia");
  igual(ext.conta, "000000", "conta");
  igual(ext.periodo_inicio, "2026-11-01", "periodo_inicio");
  igual(ext.periodo_fim, "2026-11-19", "periodo_fim");
  igual(ext.saldo_inicial_centavos, null, "saldo inicial ausente fica null, nunca 0");
  igual(ext.saldo_final_centavos, -25010, "saldo final");
  const linhas = ext.linhas as Record<string, unknown>[];
  igual(linhas.length, 2, "1 linha por STMTTRN");
  igual(linhas[0].sentido, "D", "sentido D");
  igual(linhas[0].valor_centavos, 123456, "valor positivo em centavos");
  igual(linhas[1].sentido, "C", "sentido C");
  igual(linhas[0].id_bancario, "202611030001", "id_bancario");
  igual(typeof linhas[1].descricao, "string", "descricao string");
  // as chaves vem de chavesDasLinhas, nao de outra conta
  const { parseOfx } = await import("../_shared/extrato-parser-ofx.ts");
  const parse = parseOfx(enc(OFX));
  if (!parse.ok) throw new Error("fixture invalida");
  const esperadas = chavesDasLinhas(parse.extrato.linhas, ESTRATEGIA_CHAVE_PADRAO);
  igual(linhas.map((l) => l.chave), esperadas, "chaves");
});

Deno.test("estrategia da conta vence a padrao", async () => {
  const f = falsas(enc(OFX));
  await processar(f.deps, entrada({ estrategia_chave: "id_bancario" }), USUARIO);
  const p = f.registrados[0] as Record<string, unknown>;
  igual(p.estrategia_chave, "id_bancario", "estrategia");
  const linhas = (p.extrato as Record<string, unknown>).linhas as Record<string, unknown>[];
  igual(linhas.map((l) => l.chave), ["id:202611030001", "id:202611190002"], "chaves id_bancario");
});

Deno.test("arquivo que nao fecha -> 200 com o motivo nao_fecha vindo da RPC", async () => {
  const rpc = { resultado: "recusado", motivo: "nao_fecha", detalhe: "x" };
  const f = falsas(enc(OFX), rpc);
  const r = await processar(f.deps, entrada(), USUARIO);
  igual(r.status, 200, "status");
  igual(r.corpo, rpc, "corpo = JSON da RPC, sem reinterpretar");
});

Deno.test("CNAB de 239 colunas -> 422 formato_desconhecido, sem registrar", async () => {
  const f = falsas(enc(["A".repeat(239), "B".repeat(239)].join("\r\n")));
  const r = await processar(f.deps, entrada(), USUARIO);
  igual(r.status, 422, "status");
  igual((r.corpo as CorpoErroParse).erro_parse.motivo, "formato_desconhecido", "motivo");
  igual(f.registrados.length, 0, "nao chama a RPC");
});

Deno.test("CNAB de 240 colunas -> 422 formato_desconhecido/cnab240_ainda_nao_suportado (Ruling 11)", async () => {
  const f = falsas(enc(["A".repeat(240), "B".repeat(240)].join("\r\n")));
  const r = await processar(f.deps, entrada(), USUARIO);
  igual(r.status, 422, "status");
  igual((r.corpo as CorpoErroParse).erro_parse, { motivo: "formato_desconhecido", detalhe: "cnab240_ainda_nao_suportado" }, "erro_parse");
  igual(f.registrados.length, 0, "nao chama a RPC");
});

Deno.test("arquivo vazio e lixo -> 422 formato_desconhecido", async () => {
  for (const b of [new Uint8Array(0), enc("isto nao e extrato")]) {
    const f = falsas(b);
    const r = await processar(f.deps, entrada(), USUARIO);
    igual(r.status, 422, "status");
    igual((r.corpo as CorpoErroParse).erro_parse.motivo, "formato_desconhecido", "motivo");
    igual(f.registrados.length, 0, "nao registra");
  }
});

Deno.test("OFX malformado (sem BALAMT) -> 422 com o motivo do parser, sem registrar", async () => {
  const quebrado = OFX.replace("<BALAMT>-250.10", "");
  const f = falsas(enc(quebrado));
  const r = await processar(f.deps, entrada(), USUARIO);
  igual(r.status, 422, "status");
  igual(typeof (r.corpo as CorpoErroParse).erro_parse.motivo, "string", "motivo");
  igual(f.registrados.length, 0, "nao registra");
});

Deno.test("hoje: 20/11 01:00 UTC -> 2026-11-19 em America/Sao_Paulo", async () => {
  igual(dataEmSaoPaulo(new Date("2026-11-20T01:00:00Z")), "2026-11-19", "dataEmSaoPaulo");
  igual(dataEmSaoPaulo(new Date("2026-11-20T03:00:00Z")), "2026-11-20", "03:00Z ja e dia 20 em SP");
  const f = falsas(enc(OFX), { resultado: "aceito" }, new Date("2026-11-20T01:00:00Z"));
  await processar(f.deps, entrada(), USUARIO);
  igual((f.registrados[0] as Record<string, unknown>).hoje, "2026-11-19", "hoje no payload");
});

Deno.test("erro da RPC (inclusive 22023) -> 500 generico, nunca 'recusado'", async () => {
  const f = falsas(enc(OFX));
  f.deps.registrar = () => Promise.reject(Object.assign(new Error("campo gerado_em invalido"), { code: "22023" }));
  const r = await processar(f.deps, entrada(), USUARIO);
  igual(r.status, 500, "status");
  igual(r.corpo, { erro: "erro_interno" }, "mensagem generica, sem vazar detalhe");
});

Deno.test("falha ao baixar -> 502 e nao registra", async () => {
  const f = falsas(enc(OFX));
  f.deps.baixar = () => Promise.reject(new Error("storage fora"));
  const r = await processar(f.deps, entrada(), USUARIO);
  igual(r.status, 502, "status");
  igual(f.registrados.length, 0, "nao registra");
});

Deno.test("estrategia id_bancario com linha sem FITID -> chavesDasLinhas null -> 500, sem chamar a RPC", async () => {
  const semFitid = OFX.replace("<FITID>202611030001\n", "");
  const f = falsas(enc(semFitid));
  const r = await processar(f.deps, entrada({ estrategia_chave: "id_bancario" }), USUARIO);
  igual(r.status, 500, "falha interna, nao 'recusado'");
  igual(r.corpo, { erro: "erro_interno" }, "corpo generico");
  igual(f.registrados.length, 0, "nao chama a RPC");
});

Deno.test("estrategia_chave desconhecida na conta -> 500, sem chamar a RPC", async () => {
  const f = falsas(enc(OFX));
  const r = await processar(f.deps, entrada({ estrategia_chave: "xyz" }), USUARIO);
  igual(r.status, 500, "status");
  igual(f.registrados.length, 0, "nao chama a RPC");
});
