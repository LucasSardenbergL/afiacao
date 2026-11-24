// Origem da navegação lida do NAVEGADOR (não de hook do router), para quem abre a 360 ou mede um destino.
//
// Por quê sem `useLocation`: estes pontos moram em cards, linhas e hooks que rodam também fora de um
// <Router> (testes isolados, cards montados soltos). Com o BrowserRouter, `window.location` é a URL
// atual e o `state` do react-router 6 mora em `history.state.usr` — é a mesma fonte, lida sem contexto.
import { estadoComOrigemTela, rotuloDaTela, type OrigemTela } from './clientes';

/** `state` para o `<Link>`/`navigate` que abre a 360 a partir da tela atual. `rotulo` explícito vence. */
export function estadoOrigemTelaAtual(rotulo?: string): { origemTela: OrigemTela } {
  const { pathname, search } = window.location;
  return estadoComOrigemTela(rotulo ?? rotuloDaTela(pathname), { pathname, search });
}

/** `location.state` da entrada atual do histórico (react-router 6: `history.state.usr`), ou `undefined`. */
export function estadoDaNavegacaoAtual(): unknown {
  const h = window.history.state as { usr?: unknown } | null;
  return h && typeof h === 'object' ? h.usr : undefined;
}
