import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Guardrails anti-regressão (MONEY-PATH) — padrão de mitigação de reversão do Lovable
// (Componente 3 do design 2026-06-26-lovable-revert-mitigation). O bot do Lovable commita
// direto na main sem CI e às vezes reverte correções que COMPILAM (o CI passa) → só um
// teste-invariante específico pega. Falsificar cada um (vermelho na versão regredida).
//
// (O on-order tem o seu próprio guardrail: src/lib/reposicao/__tests__/edges-onorder-guardrail.test.ts.
//  Novos guardrails de edges revertidas pelo Lovable, fora de reposição, vêm AQUI.)

function edgeSrc(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}

describe("guardrail money-path: analyze-unified-order — Omie é FALLBACK, não override [#1077/#1080]", () => {
  const src = edgeSrc("supabase/functions/analyze-unified-order/index.ts");

  it("toda aplicação de preço do Omie é guardada por !priceMap[productId] (só preenche gap)", () => {
    // order_items é o preço PRATICADO (fonte de verdade); o Omie só cobre gaps (produtos sem
    // pedido local). O deploy do Lovable já reverteu o fallback p/ OVERRIDE 1× (08431871 pós-#1077):
    // o Omie pega o "primeiro encontrado" do ListarPedidos (ordem não garantida) e MASCARAVA o
    // último preço praticado → preço-cliente errado. Restaurado no #1080. Invariante: cada
    // `priceMap[productId] = price` (aplicar preço Omie) precisa de um guard `!priceMap[productId]`.
    const atribuicoes = (src.match(/priceMap\[productId\]\s*=\s*price/g) || []).length;
    const guards = (src.match(/!priceMap\[productId\]/g) || []).length;
    expect(atribuicoes, "esperado ≥2 aplicações de preço Omie (merge inicial + re-aplicação)")
      .toBeGreaterThanOrEqual(2);
    expect(
      guards,
      `REGRESSÃO #1080: ${atribuicoes} aplicações de preço Omie mas só ${guards} guards ` +
        `!priceMap[productId] — o Omie voltou a SOBRESCREVER o preço praticado (order_items) em vez ` +
        `de só preencher gaps → preço-cliente errado. Restaure o fallback (docs/agent/deploy.md).`,
    ).toBeGreaterThanOrEqual(atribuicoes);
  });
});
