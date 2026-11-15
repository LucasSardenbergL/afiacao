// Escape de texto para interpolar em HTML de e-mail (scanner Lovable Security `ec253a34`, lote 3).
// Todo valor que veio de input (nome, telefone, item digitado) passa por aqui antes de entrar no
// template: sem isso, um `<a href>` ou `<img>` digitado num pedido vira HTML no e-mail da equipe.
// PURO e sem import remoto: `test:edges` roda com `--no-remote`.
export function escapeHtml(valor: unknown): string {
  return String(valor ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
