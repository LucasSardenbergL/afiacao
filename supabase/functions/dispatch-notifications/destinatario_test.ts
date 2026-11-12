// Régua do destinatário do dispatch-notifications (Radar D1, 2026-11-06). Roda:
//   deno test supabase/functions/dispatch-notifications/destinatario_test.ts
import { destinatarioDe, falhaDeLeituraAborta, htmlDoVendedor, mapaDestinatarios, mapaPixels } from "./destinatario.ts";

function eq(a: unknown, b: unknown, msg: string) {
  const sa = JSON.stringify(a) ?? "<undefined>";
  const sb = JSON.stringify(b) ?? "<undefined>";
  if (sa !== sb) throw new Error(`${msg}: ${sa} !== ${sb}`);
}

Deno.test("alerta com envio de vendedor vai para o vendedor; o resto continua no endereço padrão", () => {
  const mapa = mapaDestinatarios([{ alerta_id: 10, destinatario_email: " regina@exemplo.com " }]);
  eq(destinatarioDe(10, mapa, "gestor@exemplo.com"), { to: "regina@exemplo.com", doVendedor: true }, "alerta 10");
  eq(destinatarioDe(11, mapa, "gestor@exemplo.com"), { to: "gestor@exemplo.com", doVendedor: false }, "alerta 11");
});

Deno.test("e-mail vazio ou malformado no envio não vira destinatário (cai no padrão)", () => {
  const mapa = mapaDestinatarios([
    { alerta_id: 1, destinatario_email: null },
    { alerta_id: 2, destinatario_email: "" },
    { alerta_id: 3, destinatario_email: "sem-arroba" },
  ]);
  eq(mapa.size, 0, "nenhum destinatário válido");
});

Deno.test("leitura do envio: tabela ausente segue; qualquer outra falha aborta o dispatch", () => {
  eq(falhaDeLeituraAborta(null), false, "sem erro");
  eq(falhaDeLeituraAborta({ code: "42P01", message: "relation does not exist" }), false, "42P01");
  eq(falhaDeLeituraAborta({ code: "PGRST205", message: "Could not find the table" }), false, "PGRST205");
  eq(falhaDeLeituraAborta({ code: "42501", message: "permission denied" }), true, "42501");
  eq(falhaDeLeituraAborta({ code: null, message: "fetch failed" }), true, "rede");
});

Deno.test("corpo do vendedor: escapa HTML e torna o link clicável", () => {
  const html = htmlDoVendedor(
    "Radar: 1 empresa <b>",
    "1. Marcenaria & Cia\n   Abrir no Radar: https://app.exemplo.com/radar/abrir/abc/00000000000101\n",
  );
  eq(html.includes("Radar: 1 empresa &lt;b&gt;"), true, "título escapado");
  eq(html.includes("Marcenaria &amp; Cia"), true, "corpo escapado");
  eq(
    html.includes(
      '<a href="https://app.exemplo.com/radar/abrir/abc/00000000000101">https://app.exemplo.com/radar/abrir/abc/00000000000101</a>',
    ),
    true,
    "link",
  );
  eq(html.includes("<br/>"), true, "quebra de linha");
});

Deno.test("resumo de venda: destinatário do envio + pixel só nele; radar e padrão sem pixel", () => {
  const resumos = [{ alerta_id: 20, destinatario_email: "tatyana@exemplo.com", token_abertura: "tok-20" }];
  const mapa = mapaDestinatarios([{ alerta_id: 10, destinatario_email: "regina@exemplo.com" }, ...resumos]);
  const pixels = mapaPixels(resumos);
  eq(destinatarioDe(20, mapa, "gestor@exemplo.com", pixels),
    { to: "tatyana@exemplo.com", doVendedor: true, pixel: "tok-20" }, "resumo com pixel");
  eq(destinatarioDe(10, mapa, "gestor@exemplo.com", pixels),
    { to: "regina@exemplo.com", doVendedor: true }, "radar sem pixel");
  eq(destinatarioDe(30, mapa, "gestor@exemplo.com", pixels), { to: "gestor@exemplo.com", doVendedor: false }, "padrão");
  eq(mapaPixels([{ alerta_id: 21, destinatario_email: "sem-arroba", token_abertura: "t" }]).size, 0, "e-mail inválido sem pixel");
});

Deno.test("html do vendedor: pixel escapado no fim; sem url, sem img", () => {
  const com = htmlDoVendedor("T", "corpo", "https://x.supabase.co/functions/v1/dispatch-notifications?abertura=a&b");
  eq(com.endsWith('<img src="https://x.supabase.co/functions/v1/dispatch-notifications?abertura=a&amp;b" width="1" height="1" alt="" style="display:none"/>'), true, "img no fim, & escapado");
  eq(htmlDoVendedor("T", "corpo").includes("<img"), false, "sem pixel");
});
