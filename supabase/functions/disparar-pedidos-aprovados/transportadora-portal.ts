// 7.3 do plano Sayerlack (revisão 2): a TRANSPORTADORA que o portal mostra no pedido vai para a observação do PO no Omie.
//
// Fonte: a evidência imutável da leitura (`sayerlack_portal_evidencia.itens_brutos`, 7.2), o retorno cru do
// `busca-itens-pedido`, cujo `data_pedido.transportadora` traz o nome (ex.: "SPMINAS"). Lida da evidência, e não
// gravada no pedido, para não abrir um 2º escritor no pedido nem mexer na RPC de importação.
//
// Ausente ≠ inventada: sem evidência, sem o campo, ou com texto ilegível, a linha simplesmente não entra no `cObs`.
// Frete NÃO entra: nenhuma leitura real mostrou ainda onde o portal o informa (fica para a evidência dizer).

/** Teto do nome no `cObs` (o portal usa siglas curtas; texto maior é lixo, não transportadora). */
const TETO_NOME = 60;

/** `data_pedido.transportadora` do retorno cru do busca-itens, limpo; null quando não há nome legível. */
export function transportadoraDosItensBrutos(itensBrutos: unknown): string | null {
  if (!itensBrutos || typeof itensBrutos !== "object" || Array.isArray(itensBrutos)) return null;
  const dp = (itensBrutos as { data_pedido?: unknown }).data_pedido as { transportadora?: unknown } | null | undefined;
  const t = dp?.transportadora;
  if (typeof t !== "string") return null;
  // Caractere de controle no nome = ilegível (não é transportadora; não vai ao Omie).
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return null;
  }
  const limpo = t.replace(/\s+/g, " ").trim();
  if (limpo === "" || limpo.length > TETO_NOME) return null;
  return limpo;
}

/** Observação do PO: a base de sempre e, se houver, a transportadora que o portal mostrou. */
export function montarObservacaoPo(base: string, transportadora: string | null): string {
  return transportadora ? `${base} · Transportadora (portal Sayerlack): ${transportadora}` : base;
}
