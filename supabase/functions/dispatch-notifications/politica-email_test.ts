// Régua de canal do dispatch-notifications (pedido do founder, 2026-09-25). Roda:
//   deno test supabase/functions/dispatch-notifications/politica-email_test.ts
import { separarPorCanal, TIPOS_SO_NO_APP, vaiPorEmail } from "./politica-email.ts";

function eq(a: unknown, b: unknown, msg: string) {
  const sa = JSON.stringify(a) ?? "<undefined>";
  const sb = JSON.stringify(b) ?? "<undefined>";
  if (sa !== sb) throw new Error(`${msg}: ${sa} !== ${sb}`);
}

Deno.test("o resumo diário de parâmetros de reposição fica só no app", () => {
  eq(vaiPorEmail("param_auto_resumo"), false, "param_auto_resumo");
  eq(vaiPorEmail(" param_auto_resumo "), false, "com espaço");
  eq([...TIPOS_SO_NO_APP], ["param_auto_resumo"], "a lista é exatamente esta — ampliar é decisão, não efeito colateral");
});

Deno.test("todo o resto continua indo por e-mail — inclusive tipo desconhecido (fail-OPEN no aviso)", () => {
  // Os tipos do CHECK de fornecedor_alerta, menos o silenciado: nenhum deles pode sumir do e-mail
  // por arrasto. Tipo novo/desconhecido também vai: silenciar é sempre explícito.
  for (const tipo of [
    "promocao_suspensa", "aumento_anunciado", "promocao_nova", "polling_erro", "mapeamento_pendente",
    "oportunidade_calculada", "tarefa_atrasada", "whatsapp_sla", "erro_app", "outro",
    "reposicao_pedido_minimo", "tipo_que_ainda_nao_existe", "",
  ]) {
    eq(vaiPorEmail(tipo), true, tipo || "(vazio)");
  }
  eq(vaiPorEmail(null), true, "null");
  eq(vaiPorEmail(undefined), true, "undefined");
});

Deno.test("separarPorCanal preserva a ordem da fila e não perde nenhum alerta", () => {
  const fila = [
    { id: 1, tipo: "outro" },
    { id: 2, tipo: "param_auto_resumo" },
    { id: 3, tipo: "erro_app" },
    { id: 4, tipo: "param_auto_resumo" },
  ];
  const { porEmail, soNoApp } = separarPorCanal(fila);
  eq(porEmail.map((a) => a.id), [1, 3], "por e-mail");
  eq(soNoApp.map((a) => a.id), [2, 4], "só no app");
  eq(porEmail.length + soNoApp.length, fila.length, "partição completa");
});
