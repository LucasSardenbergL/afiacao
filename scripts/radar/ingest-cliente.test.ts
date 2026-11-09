import { describe, expect, it } from "vitest";
import { criarClienteIngest, type FetchLike } from "./ingest-cliente";

// Edge FALSA com o protocolo da carga em staging (migration 20261110130000): `recebendo` aceita chunk (replay é
// upsert por cnpj), `falhou` recusa com RCARGA_LOTE_FECHADO, `falhar` só fecha lote `recebendo`. A edge v1.8
// NÃO marca `falhou` no catch — o 5xx transitório deixa a fase como estava. `marcarNoCatch` reproduz a v1.7
// (o bug) para provar que este teste distingue as duas.
function edgeFalsa(opts: { falhasTransitorias: Record<string, number>; marcarNoCatch?: boolean }) {
  const estado = { fase: "" as "" | "recebendo" | "validada" | "falhou", staging: new Set<string>(), chamadas: [] as string[] };
  const falhas = { ...opts.falhasTransitorias };
  const resp = (status: number, body: unknown) => ({
    ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body),
  });
  const fetch: FetchLike = async (_url, init) => {
    const b = JSON.parse(init.body) as { action: string; linhas?: { cnpj: string }[]; esperado?: number };
    estado.chamadas.push(b.action);
    if ((falhas[b.action] ?? 0) > 0) {
      falhas[b.action]--;
      if (opts.marcarNoCatch && estado.fase === "recebendo") estado.fase = "falhou";
      return resp(503, { error: "upstream connect error (transitório)" });
    }
    switch (b.action) {
      case "begin_lote": estado.fase = "recebendo"; estado.staging.clear(); return resp(200, { ok: true });
      case "chunk":
        if (estado.fase !== "recebendo") return resp(500, { error: `RCARGA_LOTE_FECHADO: fase ${estado.fase}` });
        for (const l of b.linhas ?? []) estado.staging.add(l.cnpj);
        return resp(200, { ok: true, upserted: b.linhas?.length ?? 0 });
      case "finalize":
        if (estado.fase !== "recebendo") return resp(422, { error: `fase ${estado.fase}` });
        if (estado.staging.size !== b.esperado) { estado.fase = "falhou"; return resp(422, { error: "RCARGA_CONTAGEM_DIVERGE" }); }
        estado.fase = "validada"; return resp(200, { ok: true, publicacao: "cron" });
      case "falhar":
        if (estado.fase === "recebendo") estado.fase = "falhou";
        return resp(200, { ok: true });
      default: return resp(200, { ok: true });
    }
  };
  return { estado, fetch };
}

const cnpjs = (de: number, n: number) => Array.from({ length: n }, (_, i) => ({ cnpj: String(de + i) }));

async function carga(fetch: FetchLike) {
  const c = criarClienteIngest({ url: "x", segredo: "s", fetch, esperar: async () => {}, avisar: () => {} });
  await c.post({ action: "begin_lote", mes: "2026-11" });
  c.abrirLote("2026-11");
  let entregues = 0;
  for (const linhas of [cnpjs(0, 3), cnpjs(3, 3), cnpjs(6, 2)]) {
    const r = (await c.post({ action: "chunk", mes: "2026-11", linhas })) as { upserted: number };
    entregues += r.upserted;
  }
  await c.post({ action: "finalize", mes: "2026-11", esperado: entregues });
  c.fecharLote();
  return c;
}

describe("cliente da carga do radar — erro transitório é recuperável", () => {
  it("[K1] 5xx transitório num chunk → repetição → lote VALIDADO (sem `falhar`)", async () => {
    const e = edgeFalsa({ falhasTransitorias: { chunk: 2 } });
    await carga(e.fetch);
    expect(e.estado.fase).toBe("validada");
    expect(e.estado.staging.size).toBe(8);
    expect(e.estado.chamadas).not.toContain("falhar");
  });

  it("[K2] controle: a edge v1.7 (marca `falhou` no catch) derruba a MESMA carga — o teste distingue", async () => {
    const e = edgeFalsa({ falhasTransitorias: { chunk: 1 }, marcarNoCatch: true });
    await expect(carga(e.fetch)).rejects.toThrow(/RCARGA_LOTE_FECHADO/);
    expect(e.estado.fase).toBe("falhou");
  });

  it("[K3] desistir (4 falhas) com o lote aberto declara `falhar` UMA vez e relança o erro original", async () => {
    const e = edgeFalsa({ falhasTransitorias: { chunk: 4 } });
    await expect(carga(e.fetch)).rejects.toThrow(/POST chunk falhou \(503\)/);
    expect(e.estado.chamadas.filter((a) => a === "falhar")).toHaveLength(1);
    expect(e.estado.chamadas.filter((a) => a === "chunk")).toHaveLength(4);
    expect(e.estado.fase).toBe("falhou");
  });

  it("[K4] depois do finalize (lote fechado) uma camada que falha NÃO declara `falhar`", async () => {
    const e = edgeFalsa({ falhasTransitorias: { publicar_concorrentes: 4 } });
    const c = await carga(e.fetch);
    await expect(c.post({ action: "publicar_concorrentes", mes: "2026-11" })).rejects.toThrow(/503/);
    expect(e.estado.chamadas).not.toContain("falhar");
    expect(e.estado.fase).toBe("validada");
  });

  it("[K5] falha antes de abrir o lote (begin) não declara `falhar`", async () => {
    const e = edgeFalsa({ falhasTransitorias: { begin_lote: 4 } });
    await expect(carga(e.fetch)).rejects.toThrow(/POST begin_lote falhou \(503\)/);
    expect(e.estado.chamadas).not.toContain("falhar");
  });

  it("[K6] rede (fetch rejeita) também é re-tentada", async () => {
    const e = edgeFalsa({ falhasTransitorias: {} });
    let n = 0;
    const comRede: FetchLike = (u, init) => (n++ === 1 ? Promise.reject(new Error("ECONNRESET")) : e.fetch(u, init));
    await carga(comRede);
    expect(e.estado.fase).toBe("validada");
  });
});
