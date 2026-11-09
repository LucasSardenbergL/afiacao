/** Conteúdo do popup de uma cidade, montado com nós DOM (textContent, sem HTML cru): as linhas de resumo e a ação
 *  EXPLÍCITA "Ver empresas desta cidade". O 1º toque no pino só abre o popup; navegar para a fila é este botão
 *  (pacote C, C6 — antes o 1º toque já trocava para a lista e o popup nem era lido). */
export function popupCidade(titulo: string, linhas: string[], onVer: () => void): HTMLElement {
  const el = document.createElement('div');
  const forte = document.createElement('strong');
  forte.textContent = titulo;
  el.append(forte);
  for (const l of linhas) {
    el.append(document.createElement('br'), document.createTextNode(l));
  }
  const botao = document.createElement('button');
  botao.type = 'button';
  botao.textContent = 'Ver empresas desta cidade';
  botao.className = 'mt-2 block w-full rounded border px-2 py-1 text-xs font-medium hover:bg-muted';
  botao.addEventListener('click', onVer);
  el.append(botao);
  return el;
}
