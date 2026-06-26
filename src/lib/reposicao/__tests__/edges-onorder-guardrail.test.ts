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

  it("janela cobre o FUTURO — não termina em 'hoje' (#1076)", () => {
    expect(src, "JANELA_FUTURO_DIAS sumiu — janela voltou a cortar entrega futura").toMatch(/JANELA_FUTURO_DIAS/);
    expect(src).toMatch(/fimJanela/);
    // a regressão EXATA que o 'Changes' do Lovable reintroduziu:
    expect(src, "REGRESSÃO: dataAte voltou a 'hoje' → corta pedido a caminho → compra dupla")
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
});

describe("guardrail money-path: omie-sync-estoque ('a caminho' do MOTOR, #1072)", () => {
  const src = edgeSrc("supabase/functions/omie-sync-estoque/index.ts");

  it("janela do a-caminho cobre o FUTURO [hoje-365,+120] (#1072)", () => {
    expect(src, "REGRESSÃO: janela futuro sumiu — motor volta a subestimar a caminho → compra dupla")
      .toMatch(/PEDIDOS_JANELA_FUTURO_DIAS/);
    expect(src).toMatch(/fimJanela/);
  });
});
