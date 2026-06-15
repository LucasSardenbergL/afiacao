/**
 * Escapa os 5 caracteres especiais de HTML para suas entidades.
 *
 * Necessário porque o Leaflet renderiza `divIcon({ html })` e `bindPopup(html)`
 * como HTML cru (equivalente a `dangerouslySetInnerHTML`). Interpolar dado de
 * cliente/prospect (profiles.name, razão social de radar_empresas) direto na
 * string vira XSS stored — um `<img onerror=…>` no nome executa quando o gestor
 * abre o popup. Escapar antes de interpolar neutraliza o HTML embutido sem
 * alterar o texto visível.
 *
 * O `&` é trocado PRIMEIRO; senão o `&` das demais entidades (`&lt;`…) seria
 * re-escapado para `&amp;lt;`.
 */
export function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
