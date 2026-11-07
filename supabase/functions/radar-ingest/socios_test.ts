// Testa o CÓDIGO REAL de radar-ingest/socios.ts no runtime real (Deno). Roda com: deno test --no-remote supabase/functions/radar-ingest/
function assertEquals(a: unknown, b: unknown, msg?: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${msg ?? "assertEquals"}\n  esperado: ${JSON.stringify(b)}\n  recebido: ${JSON.stringify(a)}`);
  }
}
import { codigoErroSocios, ehAcaoSocios, montarPedidoSocios } from "./socios.ts";

const DIG = "a".repeat(64);

Deno.test("codigoErroSocios: só o código RSOC_* sai; mensagem com linha/máscara vira erro interno", () => {
  assertEquals(codigoErroSocios({ message: "RSOC_LOTE_FECHADO" }), "RSOC_LOTE_FECHADO");
  assertEquals(codigoErroSocios({ message: "RSOC_RECONCILIACAO linhas=10/21 raizes=9/20" }), "RSOC_RECONCILIACAO linhas=10/21 raizes=9/20");
  // Violação de constraint do PostgREST ecoa a linha (com a máscara): NUNCA pode sair.
  assertEquals(codigoErroSocios({ message: 'new row violates check constraint', details: "Failing row contains (***123456**)" }), "RSOC_ERRO_INTERNO");
  assertEquals(codigoErroSocios({ message: "RSOC_LOTE_FECHADO ***123456**" }), "RSOC_ERRO_INTERNO");
  assertEquals(codigoErroSocios(new Error("RSOC_CHUNK_TAMANHO")), "RSOC_CHUNK_TAMANHO");
  assertEquals(codigoErroSocios(null), "RSOC_ERRO_INTERNO");
});

Deno.test("montarPedidoSocios: valida antes de chamar a RPC", () => {
  assertEquals(ehAcaoSocios("chunk_socios"), true);
  assertEquals(ehAcaoSocios("chunk"), false);
  const ini = montarPedidoSocios("socios_iniciar", { mes: "2026-10", digest: DIG, versao: "v1", linhas: 3, raizes: 2, universo: 9 });
  assertEquals(ini, { ok: true, rpc: "radar_socios_iniciar",
    args: { p_mes: "2026-10", p_digest: DIG, p_versao: "v1", p_linhas: 3, p_raizes: 2, p_universo: 9 } });
  assertEquals(montarPedidoSocios("socios_iniciar", { mes: "2026-10", digest: DIG, versao: "v1", linhas: 0, raizes: 2, universo: 9 }).ok, false);
  assertEquals(montarPedidoSocios("socios_iniciar", { mes: "2026-10", digest: "x", versao: "v1", linhas: 3, raizes: 2, universo: 9 }).ok, false);
  assertEquals(montarPedidoSocios("chunk_socios", { lote: "2026-10-aaaaaaaa", linhas: [] }).ok, false);
  assertEquals(montarPedidoSocios("chunk_socios", { lote: "2026-10-aaaaaaaa", linhas: new Array(5001).fill({}) }).ok, false);
  assertEquals(montarPedidoSocios("chunk_socios", { lote: "2026-10", linhas: [{}] }).ok, false);
  assertEquals(montarPedidoSocios("publicar_socios", { lote: "2026-10-aaaaaaaa" }),
    { ok: true, rpc: "radar_socios_publicar", args: { p_lote: "2026-10-aaaaaaaa" } });
  assertEquals(montarPedidoSocios("limpar_socios", {}), { ok: true, rpc: "radar_socios_limpar", args: { p_max: 20000 } });
  assertEquals(montarPedidoSocios("limpar_socios", { max: 0 }).ok, false);
});
