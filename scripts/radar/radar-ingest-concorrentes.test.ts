import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { removerComentarios } from "../../src/lib/gates/limpeza-fonte";

// Fiação da camada de concorrentes (frente 4 do radar) lida como TEXTO: a edge roda em Deno, fora do vitest,
// e o sync do Lovable pode reverter o arquivo. O que importa aqui é a ORDEM e o ISOLAMENTO: a carga publica
// os concorrentes DEPOIS do finalize, e a falha da ação não passa pelo catch geral que marca o lote de leads
// como `error` (isso tiraria a foto vigente da fila por causa de uma camada do mapa).

const RAIZ = join(__dirname, "..", "..");
const ler = (rel: string) => readFileSync(join(RAIZ, rel), "utf8");
const edge = removerComentarios(ler("supabase/functions/radar-ingest/index.ts"));
const carga = removerComentarios(ler("scripts/radar/carga.ts"));
const bloco = (texto: string, de: string, ate: string) => {
  const i = texto.indexOf(de);
  expect(i, `âncora ausente: ${de}`).toBeGreaterThan(-1);
  const j = texto.indexOf(ate, i + de.length);
  expect(j, `âncora de fim ausente: ${ate}`).toBeGreaterThan(-1);
  return texto.slice(i, j);
};

describe("radar-ingest — publicar_concorrentes (texto)", () => {
  it("[K1] a ação chama a RPC com os 4 parâmetros e aparece na lista de ações do 400", () => {
    const b = bloco(edge, 'action === "publicar_concorrentes"', 'action === "status"');
    expect(b).toContain('admin.rpc("radar_concorrentes_publicar"');
    for (const p of ["p_lote: mes", "p_cnaes: cnaes", "p_linhas: linhas", "p_estabelecimentos: estabelecimentos"]) {
      expect(b).toContain(p);
    }
    expect(edge).toMatch(/acoes: \[[^\]]*"publicar_concorrentes"/);
  });

  it("[K2] erro da ação é tratado nela mesma e NÃO toca radar_ingest_state", () => {
    const b = bloco(edge, 'action === "publicar_concorrentes"', 'action === "status"');
    expect(b).toMatch(/catch \(e\) \{[\s\S]*return json\(\{ error: msg \}, 500\);/);
    expect(b).not.toContain("radar_ingest_state");
  });

  it("[K3] carga: publica DEPOIS do finalize, e a falha vira exitCode 6 (job vermelho), não abort da fila", () => {
    const iFin = carga.indexOf('action: "finalize"');
    const iUltimaChamada = carga.lastIndexOf("await publicarConcorrentes()");
    expect(iFin).toBeGreaterThan(-1);
    expect(iUltimaChamada).toBeGreaterThan(iFin);
    expect(carga.slice(iUltimaChamada - 80)).toContain("process.exitCode = 6");
    const f = bloco(carga, "async function publicarConcorrentes()", 'if (SO_CONCORRENTES) process.exit(');
    expect(f).toContain('action: "publicar_concorrentes"');
    expect(f).toMatch(/if \(pub\.estabelecimentos === 0\)[^\n]*return false;/);
    expect(f).toMatch(/catch \(e\) \{[\s\S]*return false;/);
  });

  it("[K4] concorrentes NÃO entram em radar_empresas: o parquet do universo segue só com o filtro de leads", () => {
    expect(carga).toContain("FROM scan WHERE ${filtroUniverso}");
    expect(carga).toMatch(/FROM scan WHERE \$\{filtroConcorrentes\} GROUP BY mun, uf, cnae1/);
    expect(carga).not.toMatch(/cnaes-alvo[\s\S]{0,200}CNAES_CONCORRENTES/);
  });
});
