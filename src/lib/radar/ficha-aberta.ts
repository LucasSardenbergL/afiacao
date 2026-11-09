/**
 * Qual versão do lead a ficha do /radar mostra (pacote I, item 1).
 *
 * O defeito: cadastrar no Omie tira o lead da fila (vira `ja_cliente`), e a ficha caía num SNAPSHOT guardado num
 * `useRef`. A invalidação do react-query (`invalidarRadar`) não alcança um ref, então a ficha seguia dizendo
 * "a contatar" sem "já é cliente". O mesmo valia para o lead lido pelo link, guardado num `useState`.
 *
 * Agora o lead fora da fila é lido por uma query SOB `['radar']` (`useRadarEmpresa`), que a mesma invalidação relê.
 * A ordem de preferência:
 *   1. a linha da fila carregada (é a leitura mais nova quando o lead está nela);
 *   2. a leitura avulsa do servidor, quando ela ASSENTOU (não está relendo). Enquanto relê, o dado em cache pode ser
 *      mais velho que o snapshot (ex.: lido pelo link, depois atualizado pela fila), então ele não vence;
 *   3. o snapshot do mesmo CNPJ (o que a ficha já mostrava). Ele serve só de ponte até a releitura chegar;
 *   4. a leitura avulsa mesmo relendo, se não houver snapshot (melhor que ficha nenhuma).
 * Leitura avulsa `null` (o lead não existe mais) não apaga o snapshot: quem decide fechar é a página.
 */
export interface FontesDaFicha<E extends { cnpj: string }> {
  cnpj: string;
  daLista: E | null;
  doServidor: E | null | undefined;
  /** true enquanto a leitura avulsa está buscando (1ª leitura ou releitura depois de uma invalidação). */
  servidorRelendo: boolean;
  snapshot: E | null;
}

export function escolherFichaAberta<E extends { cnpj: string }>(f: FontesDaFicha<E>): E | null {
  const mesmo = (e: E | null | undefined): E | null => (e && e.cnpj === f.cnpj ? e : null);
  const lista = mesmo(f.daLista);
  if (lista) return lista;
  const servidor = mesmo(f.doServidor);
  if (servidor && !f.servidorRelendo) return servidor;
  return mesmo(f.snapshot) ?? servidor;
}
