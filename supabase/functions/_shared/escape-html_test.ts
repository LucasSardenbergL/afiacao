// Testa o CÓDIGO REAL de escape-html.ts no runtime Deno.
import { escapeHtml } from "./escape-html.ts";

function igual(a: string, b: string) {
  if (a !== b) throw new Error(`esperado ${JSON.stringify(b)}; veio ${JSON.stringify(a)}`);
}

Deno.test("escapeHtml: neutraliza tag, atributo e entidade", () => {
  igual(escapeHtml('<a href="https://x.y">clique</a>'), "&lt;a href=&quot;https://x.y&quot;&gt;clique&lt;/a&gt;");
  igual(escapeHtml("<img src=x onerror='alert(1)'>"), "&lt;img src=x onerror=&#39;alert(1)&#39;&gt;");
  igual(escapeHtml("Tintas & Cia"), "Tintas &amp; Cia");
  igual(escapeHtml("&lt;"), "&amp;lt;");
});

Deno.test("escapeHtml: ausente vira vazio e número vira texto", () => {
  igual(escapeHtml(undefined), "");
  igual(escapeHtml(null), "");
  igual(escapeHtml(3), "3");
  igual(escapeHtml("Serra circular 250mm"), "Serra circular 250mm");
});
