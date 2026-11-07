// Ações de sócios (QSA PF com CPF MASCARADO) da edge `radar-ingest` — passo 3 do "Radar sucessor"
// (migration 20261107040000). O protocolo inteiro vive nas RPCs (manifesto imutável, chunk só em lote
// 'carregando', reconciliação e troca de ponteiro, limpeza em fatias); aqui só o transporte e a FRONTEIRA DE ERRO.
//
// ⚠️ LGPD: nome + CPF parcial é dado pessoal. Nenhum erro desta superfície pode ecoar linha, payload, `details`
// ou `hint` do PostgREST — só o CÓDIGO `RSOC_*` que as RPCs levantam (achado Codex P1 do desenho). E uma falha
// aqui NUNCA marca o lote da fila de leads como `error`: a camada de sócios roda depois do `finalize`.

const ACOES_SOCIOS = ["socios_iniciar", "chunk_socios", "publicar_socios", "limpar_socios"] as const;
export type AcaoSocios = (typeof ACOES_SOCIOS)[number];

const MAX_LINHAS_CHUNK_SOCIOS = 5000;

export function ehAcaoSocios(a: string): a is AcaoSocios {
  return (ACOES_SOCIOS as readonly string[]).includes(a);
}

/** Código seguro para log/resposta. Só `RSOC_<MAIUSCULAS>` (+ contagens da reconciliação, que não são dado pessoal). */
export function codigoErroSocios(e: unknown): string {
  const msg = typeof e === "object" && e !== null && "message" in e ? String((e as { message: unknown }).message) : "";
  const rec = msg.match(/^RSOC_RECONCILIACAO linhas=\d+\/\d+ raizes=\d+\/\d+$/);
  if (rec) return rec[0];
  const cod = msg.match(/^RSOC_[A-Z_]+$/);
  return cod ? cod[0] : "RSOC_ERRO_INTERNO";
}

/** As 4 RPCs do protocolo. União de LITERAIS: o call-site (`index.ts`) chama cada uma pelo nome literal, que é o que o
 *  pré-flight de deploy (`preflight:rpcs`/`pendencias:pacote`) enxerga — nome por indireção deixa a lista INCOMPLETA
 *  e o gate recusa o pacote (exit 3). */
type RpcSocios = "radar_socios_iniciar" | "radar_socios_receber" | "radar_socios_publicar" | "radar_socios_limpar";

type Pedido =
  | { ok: true; rpc: RpcSocios; args: Record<string, unknown> }
  | { ok: false; erro: string };

/** Valida o corpo da ação e monta a chamada da RPC (sem tocar banco — testável sem rede). */
export function montarPedidoSocios(acao: AcaoSocios, body: Record<string, unknown>): Pedido {
  const lote = typeof body.lote === "string" ? body.lote : "";
  const loteOk = /^\d{4}-\d{2}-[0-9a-f]{8}$/.test(lote);
  switch (acao) {
    case "socios_iniciar": {
      const { mes, digest, versao, linhas, raizes, universo } = body;
      if (typeof mes !== "string" || !/^\d{4}-\d{2}$/.test(mes)) return { ok: false, erro: "mes inválido (YYYY-MM)" };
      if (typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest)) return { ok: false, erro: "digest inválido (sha256 hex)" };
      if (typeof versao !== "string" || versao.length < 1 || versao.length > 40) return { ok: false, erro: "versao inválida" };
      for (const [k, v] of Object.entries({ linhas, raizes, universo })) {
        if (!Number.isInteger(v) || (v as number) <= 0) return { ok: false, erro: `${k} inválido (inteiro > 0)` };
      }
      return { ok: true, rpc: "radar_socios_iniciar",
        args: { p_mes: mes, p_digest: digest, p_versao: versao, p_linhas: linhas, p_raizes: raizes, p_universo: universo } };
    }
    case "chunk_socios": {
      if (!loteOk) return { ok: false, erro: "lote inválido" };
      const linhas = body.linhas;
      if (!Array.isArray(linhas) || linhas.length === 0) return { ok: false, erro: "linhas vazio" };
      if (linhas.length > MAX_LINHAS_CHUNK_SOCIOS) return { ok: false, erro: `máx ${MAX_LINHAS_CHUNK_SOCIOS} linhas/chunk` };
      return { ok: true, rpc: "radar_socios_receber", args: { p_lote: lote, p_linhas: linhas } };
    }
    case "publicar_socios":
      if (!loteOk) return { ok: false, erro: "lote inválido" };
      return { ok: true, rpc: "radar_socios_publicar", args: { p_lote: lote } };
    case "limpar_socios": {
      const max = body.max ?? 20000;
      if (!Number.isInteger(max) || (max as number) < 1 || (max as number) > 50000) return { ok: false, erro: "max inválido (1..50000)" };
      return { ok: true, rpc: "radar_socios_limpar", args: { p_max: max } };
    }
  }
}
