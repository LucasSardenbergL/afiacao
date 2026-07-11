// src/lib/carteira/vendedor-oben.ts
// Money-path P0-B-bis (ponta 2/2): o vendedor da carteira vem da PROOF account-correta
// (omie_customer_account_map_fresco, account=oben), NÃO do espelho poluído omie_clientes.
//
// Esta função resolve, por user_id, o omie_codigo_vendedor OBEN a partir das linhas frescas da proof.
// Invariantes (Codex R2 / handoff):
//  - Conta explícita: só recebe linhas já filtradas por account=oben (o caller filtra na query).
//  - Fail-closed na ambiguidade (precisão>recall): user com 2+ vendedores oben DISTINTOS → NÃO atribui
//    (cai pro Hunter no rebuild) e é registrado em `ambiguos`. Nunca chuta o primeiro.
//  - Herança cross-account eliminada por construção: como o mapa só carrega vendedores OBEN, um clone
//    colacor_sc (que não tem linha oben) resolve para AUSENTE — nunca injeta seu vendedor no gêmeo oben.
//  - Só inteiro seguro positivo conta como vendedor (0/negativo/≥2^53 = não-atribuído), espelhando
//    extrairCodigoVendedor do writer (defesa em profundidade na leitura).
export interface OmieVendedorObenRow {
  user_id: string;
  omie_codigo_vendedor: number | null;
}

export interface VendedorObenResolvido {
  /** user_id → código do vendedor oben, apenas para users com EXATAMENTE 1 vendedor distinto. */
  vendedorPorUser: Map<string, number>;
  /** users com 2+ vendedores oben distintos — fail-closed: não atribuídos (Hunter), registrados p/ auditoria. */
  ambiguos: string[];
}

// MIRROR-START carteira-vendedor-oben — espelhado verbatim em supabase/functions/carteira-rebuild/index.ts
export function resolverVendedorObenPorUser(rows: OmieVendedorObenRow[]): VendedorObenResolvido {
  const codigoValido = (v: number | null): v is number =>
    typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
  const porUser = new Map<string, Set<number>>();
  for (const r of rows) {
    if (!r.user_id) continue;
    let s = porUser.get(r.user_id);
    if (!s) { s = new Set<number>(); porUser.set(r.user_id, s); }
    if (codigoValido(r.omie_codigo_vendedor)) s.add(r.omie_codigo_vendedor);
  }
  const vendedorPorUser = new Map<string, number>();
  const ambiguos: string[] = [];
  for (const [user, vends] of porUser) {
    if (vends.size === 1) vendedorPorUser.set(user, [...vends][0]);
    else if (vends.size > 1) ambiguos.push(user); // size 0 → órfão (fora do mapa, sem vendedor)
  }
  return { vendedorPorUser, ambiguos };
}
// MIRROR-END
