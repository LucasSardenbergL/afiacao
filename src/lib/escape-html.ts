/**
 * Escapa os 5 caracteres especiais de HTML para suas entidades. Helper CANÔNICO
 * de escape do app — use SEMPRE que interpolar dado em string que vira HTML cru.
 *
 * Vale para todo sink que monta HTML sem o React no meio (o React já escapa):
 *  - Leaflet `divIcon({ html })` / `bindPopup(html)` (mapas: Roteirizador, Radar);
 *  - `el.innerHTML = …` / `printWindow.document.write(…)` (layouts de impressão:
 *    pedido, venda, certificado, QR, cockpit de reposição).
 * Interpolar dado de cliente/fornecedor cru (profiles.name, razão social,
 * nome de fornecedor) vira XSS stored — um `<img onerror=…>` executa ao renderizar.
 *
 * `null`/`undefined` → '' (drop-in para campos opcionais). O `&` é trocado
 * PRIMEIRO; senão o `&` das demais entidades (`&lt;`…) seria re-escapado.
 */
export function escapeHtml(input: string | null | undefined): string {
  if (!input) return '';
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
