import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Guardrail anti-regressão (MONEY-PATH). O auto-commit "Changes" / deploy do Lovable já
// reverteu correções nessas edges DUAS vezes: #1076 (revertido por 22d2a4fd, re-aplicado
// aqui) e #1077 (revertido, restaurado por #1080). Estes testes FALHAM no CI se:
//   - a janela do PesquisarPedCompra voltar a terminar em "hoje" — o filtro é por DATA DE
//     PREVISÃO DE ENTREGA, então isso esconde TODO pedido a caminho (entrega futura) →
//     estoque_pendente_entrada subestimado → COMPRA DUPLA;
//   - o loop voltar a confiar no nTotalPaginas (o Omie SUB-REPORTA → perde POs além da 1ª pág);
//   - o upsert voltar a ser N+1 (estoura o wall-clock do cron → sync incompleto).
// O CI verde NÃO garante que a EDGE EM PROD está correta (deploy é manual no Lovable) — ele
// garante que o REPO não regrediu. Ver docs/agent/reposicao.md (§ "Duas edges varrem...").

function edgeSrc(rel: string): string {
  return readFileSync(resolve(process.cwd(), rel), "utf8");
}

describe("guardrail money-path: omie-sync-pedidos-compra (réplica purchase_orders_tracking)", () => {
  const src = edgeSrc("supabase/functions/omie-sync-pedidos-compra/index.ts");

  it("janela cobre o FUTURO — delega ao helper testado e não termina em 'hoje' (#1076 + on-order)", () => {
    // A janela (passado por MODO, FUTURO fixo) foi extraída p/ ../_shared/janela-pedidos-compra.ts
    // (computeJanelaPrevisao) — testado em janela-pedidos-compra.test.ts + paridade byte-idêntica. Aqui
    // garantimos que a edge AINDA usa o helper (não voltou a janela inline com dataAte=hoje).
    expect(src, "edge não usa mais computeJanelaPrevisao — janela voltou a ser inline (risco de regressão #1072)")
      .toMatch(/computeJanelaPrevisao/);
    expect(src, "import do helper espelhado sumiu — paridade src×edge quebrada")
      .toMatch(/_shared\/janela-pedidos-compra/);
    expect(src).toMatch(/fimJanela/);
    // a regressão EXATA que o 'Changes' do Lovable reintroduziu:
    expect(src, "REGRESSÃO: dataAte voltou a 'hoje' → corta pedido a caminho → some do tracking")
      .not.toMatch(/dataAte\s*=\s*formatDateBR\(\s*hoje\s*\)/);
  });

  it("pagina ATÉ A PÁGINA VAZIA — não confia em nTotalPaginas (#1076)", () => {
    expect(src).toMatch(/MAX_PAGINAS/);
    expect(src).toMatch(/FIM_SEM_REGISTROS/);
    expect(src, "REGRESSÃO: loop voltou a depender de nTotalPaginas (sub-reporta → perde POs)")
      .not.toMatch(/while\s*\(\s*pagina\s*<=\s*totalPaginas\s*\)/);
  });

  it("upsert em LOTE — não N+1 (#1076 wall-clock)", () => {
    expect(src).toMatch(/upsertPedidosLote/);
  });

  it("caminho cron detectado pelo BODY (trigger), não só pelo header (on-order jun/2026)", () => {
    // o omie-cron-diario chama com Authorization: service_role e NÃO repassa x-cron-secret p/ a filha →
    // detectar cron só por header deixaria waitUntil/incremental sem disparar (bug latente do #1081).
    expect(src, "detecção de cron por body.trigger sumiu — waitUntil/incremental nunca disparariam via cron")
      .toMatch(/body\.trigger\s*===\s*["']cron["']/);
  });

  it("decide incremental×completo por marcador de cadência, NÃO por hora (on-order jun/2026)", () => {
    expect(src, "deveRodarCompleto sumiu — a decisão de modo voltaria a janela fixa ou hora frágil")
      .toMatch(/deveRodarCompleto/);
    expect(src, "marcador de cadência dedicado sumiu — last_full_at no metadata sofre lost-update (Codex)")
      .toMatch(/pedidos_compra_full/);
  });

  it("NÃO responde cedo no cron (sem 202/EdgeRuntime) — preserva a ordem pedidos→nfes→ctes (Codex on-order)", () => {
    // Responder antes de o espelho existir solta os steps seguintes do orquestrador → órfãs (insertOrfa).
    // Casa MARCADORES DE CÓDIGO (não a palavra "waitUntil" que aparece em comentário didático): a resposta
    // 202, o flag background:true e o uso de EdgeRuntime são inequívocos do caminho de retorno-cedo.
    expect(src, "voltou o retorno-cedo (202/EdgeRuntime/background) — soltaria nfes/ctes/sku antes do espelho → órfãs")
      .not.toMatch(/EdgeRuntime|status:\s*202|background:\s*true/);
  });
});

describe("guardrail: omie-cron-diario sinaliza o step pedidos como cron (on-order jun/2026)", () => {
  const src = edgeSrc("supabase/functions/omie-cron-diario/index.ts");

  it("o step pedidos manda trigger:'cron' no body (a edge detecta por body, não header)", () => {
    expect(src, "o step pedidos parou de mandar trigger:'cron' — a edge cairia no caminho manual/síncrono")
      .toMatch(/omie-sync-pedidos-compra[\s\S]{0,160}?trigger:\s*["']cron["']/);
  });
});

describe("guardrail money-path: omie-sync-estoque ('a caminho' do MOTOR, #1072)", () => {
  const src = edgeSrc("supabase/functions/omie-sync-estoque/index.ts");

  it("janela do a-caminho cobre o FUTURO [hoje-365,+120] (#1072)", () => {
    expect(src, "REGRESSÃO: janela futuro sumiu — motor volta a subestimar a caminho → compra dupla")
      .toMatch(/PEDIDOS_JANELA_FUTURO_DIAS/);
    expect(src).toMatch(/fimJanela/);
  });
});
