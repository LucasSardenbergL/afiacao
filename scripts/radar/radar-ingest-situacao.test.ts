import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { removerComentarios } from "../../src/lib/gates/limpeza-fonte";

// Invariantes da edge `radar-ingest` lidas como TEXTO (a edge roda em Deno, fora do vitest; o deploy pelo
// chat do Lovable pode reverter um merge e commitar a reversão — docs/agent/deploy.md). Vigia o WIRING da
// situação cadastral: as duas ações existem, o finalize aplica a situação DEPOIS do recruzar e propaga erro,
// o upsert do chunk_situacao conflita em (cnpj, lote) e NÃO manda `alertado_em` (1 escritor: a função SQL),
// e a versão servida pela sonda mudou junto com o comportamento.

const RAIZ = join(__dirname, "..", "..");
const ler = (rel: string) => readFileSync(join(RAIZ, rel), "utf8");
const edge = removerComentarios(ler("supabase/functions/radar-ingest/index.ts"));
const versao = ler("supabase/functions/radar-ingest/versao.ts");
const carga = removerComentarios(ler("scripts/radar/carga.ts"));
const entre = (texto: string, de: string, ate: string) => {
  const i = texto.indexOf(de);
  expect(i, `âncora ausente: ${de}`).toBeGreaterThan(-1);
  const j = texto.indexOf(ate, i + de.length);
  return j === -1 ? texto.slice(i) : texto.slice(i, j);
};

describe("edge radar-ingest — situação cadastral (texto)", () => {
  it("[E1] ações cnpjs_conhecidos e chunk_situacao existem e aparecem na lista de ações do 400", () => {
    expect(edge).toContain('action === "cnpjs_conhecidos"');
    expect(edge).toContain('action === "chunk_situacao"');
    expect(edge).toMatch(/acoes: \[[^\]]*"cnpjs_conhecidos"[^\]]*"chunk_situacao"[^\]]*\]/);
  });

  it("[E2] cnpjs_conhecidos pagina pela RPC radar_cnpjs_conhecidos com p_apos/p_limite e devolve `proximo`", () => {
    const bloco = entre(edge, 'action === "cnpjs_conhecidos"', 'action === "chunk_situacao"');
    expect(bloco).toContain('admin.rpc("radar_cnpjs_conhecidos", { p_apos: apos, p_limite: limite })');
    expect(bloco).toContain("if (error) throw error;");
    expect(bloco).toContain("proximo:");
  });

  it("[E3] chunk_situacao valida por motivo, conflita em (cnpj, lote) e NÃO escreve alertado_em", () => {
    const bloco = entre(edge, 'action === "chunk_situacao"', 'action === "finalize"');
    expect(bloco).toContain("validarLinhaSituacao(l)");
    expect(bloco).toContain('.from("radar_situacao_cadastral").upsert(finalPayload, { onConflict: "cnpj,lote" })');
    expect(bloco).toContain("if (error) throw error;");
    expect(bloco).not.toContain("alertado_em");
    expect(bloco).toContain("descartadas_por_motivo");
  });

  it("[E4] finalize chama radar_aplicar_situacao DEPOIS de radar_recruzar_ja_cliente, propaga o erro e devolve o resultado", () => {
    const bloco = entre(edge, 'action === "finalize"', 'action === "status"');
    const iRe = bloco.indexOf('admin.rpc("radar_recruzar_ja_cliente")');
    const iSit = bloco.indexOf('admin.rpc("radar_aplicar_situacao", { p_lote: mes })');
    expect(iRe).toBeGreaterThan(-1);
    expect(iSit).toBeGreaterThan(iRe);
    expect(bloco).toContain("if (eSit) throw eSit;");
    expect(bloco).toContain("situacao });");
    // Ordem de FATO: a foto só é aplicada depois do ja_cliente fresco — é o que impede cliente virar lead descartado.
    expect(bloco.indexOf("if (eRe) throw eRe;")).toBeLessThan(iSit);
  });

  it("[E5] VERSAO bumpada para a situação cadastral e EFEITO cita o alerta ao gestor", () => {
    expect(versao).toContain('export const VERSAO = "v1.2-situacao-cadastral";');
    expect(versao).toContain("radar_aplicar_situacao");
  });

  it("[E6] carga: pede a lista à edge ANTES dos zips, aborta em resposta sem cnpjs (ausente ≠ vazio) e envia chunk_situacao antes do finalize", () => {
    const iLista = carga.indexOf('action: "cnpjs_conhecidos"');
    const iZips = carga.indexOf("Estabelecimentos${i}.zip");
    const iChunk = carga.indexOf('action: "chunk_situacao"');
    const iFin = carga.indexOf('action: "finalize"');
    expect(iLista).toBeGreaterThan(-1);
    expect(iLista).toBeLessThan(iZips);
    expect(iChunk).toBeGreaterThan(-1);
    expect(iChunk).toBeLessThan(iFin);
    expect(carga).toContain("if (!r?.cnpjs) throw new Error(");
    expect(carga).toContain("if (!resp?.descartadas_por_motivo) throw new Error(");
    // Um scan só por zip: as duas condições no mesmo read_csv, nunca uma segunda passada.
    expect(carga).toContain("WHERE (${filtroUniverso}) OR ${filtroConhecidos};");
    expect((carga.match(/read_csv\('\$\{WORK\}\/est\/\*'/g) ?? []).length).toBe(1);
  });
});
