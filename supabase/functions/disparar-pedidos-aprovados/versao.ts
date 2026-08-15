// Sensor de versão + sonda de diagnóstico da edge `disparar-pedidos-aprovados`.
//
// POR QUE ISTO EXISTE (2026-08-14): esta edge não tinha NENHUMA forma de responder "qual versão
// está no ar?" sem provocar efeito irreversível. `dry_run` NÃO é dry-run de verdade — ele chama
// `IncluirPedCompra` incondicionalmente e CRIA PEDIDO DE COMPRA REAL no Omie (só troca cObs,
// cObsInt e o status para `disparado_simulado`). E mesmo com ZERO aprovados o fluxo expira
// oportunidades e grava `sync_reprocess_log`. Ou seja: a única prova de deploy era esperar um
// pedido ser disparado de verdade — caro demais numa edge de money-path.
//
// Núcleo PURO e sem IO: `test:edges` roda com --no-remote e não pode importar o index.ts (que puxa
// dependência remota). Toda a decisão testável mora aqui.

/**
 * Marcador de versão servido pela edge. **Atualize a cada mudança relevante de comportamento** —
 * é ele que distingue um bundle novo de um velho em produção.
 *
 * `v1.1-marco-causal` = o guard temporal lê `omie_po_inexistente_antes_de` (marco causal do relógio
 * do BANCO, lido ANTES do IncluirPedCompra) em vez de `omie_registrado_em`. Ver #1739 / 654f8576.
 *
 * ⚠️ O sensor só prova versões a partir de si mesmo: um bundle que tenha o marco causal mas seja
 * ANTERIOR a este PR não responde `versao` nenhuma. Ausência do campo = bundle pré-sensor.
 */
export const VERSAO = "v1.1-marco-causal";

export type DecisaoSonda =
  | { tipo: "sonda" }
  | { tipo: "disparo" }
  | { tipo: "ambiguo"; valor: string };

const SONDA_SIM = new Set(["true", "1"]);
const SONDA_NAO = new Set(["false", "0"]);

/**
 * Decide se o corpo da requisição pede a SONDA (diagnóstico puro) ou o DISPARO (fluxo real).
 *
 * A assimetria manda no desenho (`docs/agent/sync.md` §"o default de um classificador cai no lado
 * CARO"):
 *   - ler sonda como disparo → pedido de compra REAL e irreversível no ERP;
 *   - ler disparo como sonda → o tick não dispara (visível no log, retentável).
 *
 * Daí as duas regras que um `body.probe === true` cru não dá:
 *   1. grafias que um humano digita no SQL Editor (`"true"`, `"1"`, com espaço/caixa) são SONDA —
 *      `jsonb_build_object('probe', true)` é fácil de virar string, e cair no disparo real seria
 *      catastrófico;
 *   2. `probe` presente com valor NÃO reconhecido é AMBÍGUO (o chamador quis sondar e errou a
 *      grafia) → recusa explícita, nunca disparo por omissão.
 *
 * A chave AUSENTE é o caminho do cron e segue direto para o disparo — sem isso, todo tick viraria
 * sonda e a compra do dia não sairia.
 */
export function classificarSonda(body: unknown): DecisaoSonda {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { tipo: "disparo" };
  }
  if (!("probe" in body)) return { tipo: "disparo" };

  const bruto = (body as { probe: unknown }).probe;
  if (typeof bruto === "boolean") return { tipo: bruto ? "sonda" : "disparo" };

  if (typeof bruto === "string" || typeof bruto === "number") {
    const norm = String(bruto).trim().toLowerCase();
    if (SONDA_SIM.has(norm)) return { tipo: "sonda" };
    if (SONDA_NAO.has(norm)) return { tipo: "disparo" };
  }

  return { tipo: "ambiguo", valor: JSON.stringify(bruto) ?? String(bruto) };
}

/**
 * Corpo da resposta da sonda. O eco `probe:true` é obrigatório: um bundle ANTERIOR à sonda IGNORA
 * o parâmetro e roda o FLUXO REAL (`docs/agent/deploy.md` §Canárias, armadilha 1) — sem o eco, a
 * resposta do fluxo real se confundiria com "a sonda respondeu". Resposta sem `probe:true` já é o
 * veredito: bundle velho.
 */
export function respostaSonda(): { ok: true; probe: true; versao: string } {
  return { ok: true, probe: true, versao: VERSAO };
}
