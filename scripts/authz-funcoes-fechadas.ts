/**
 * authz-funcoes-fechadas.ts — allowlist CURADA do EXECUTE das funções sensíveis classificadas.
 * ============================================================================================
 *
 * Fonte de verdade única do gate estático (scripts/lib/authz-funcoes.ts → Parte E do
 * `authz:check`) e do audit de prod (db/audit-grants-funcoes-fechadas.ts). Irmã exata da
 * `AUTHZ_TABELAS_FECHADAS`, um nível abaixo: lá o objeto protegido é a TABELA, aqui é a FUNÇÃO.
 *
 * O VETOR, e ele não é teórico (§7.4 item 1 / §8.5 item 4 de
 * docs/historico/sentinela-authz-controle-nao-mencao.md): `CREATE OR REPLACE FUNCTION` PRESERVA o
 * ACL; o par `DROP FUNCTION` + `CREATE FUNCTION` **não** — a função renasce herdando o default
 * privilege do projeto. Antes desta entrega, o `authz:check` verificava o GATE no corpo (Partes
 * A/D) e os GRANTS de TABELA (Parte C), e **nada** verificava grant de FUNÇÃO.
 *
 * ⚠️ O DEFAULT PRIVILEGE FOI MEDIDO, não presumido (psql-ro, 2026-08-15, `pg_default_acl`):
 *     schema `public`, objtype `f` → {postgres=X, anon=X, authenticated=X, service_role=X, …}
 * Isto é, uma função nova em `public` nasce **executável por `anon` E `authenticated`** — o vetor
 * concede à role ANÔNIMA, não só à autenticada. E o schema `private` **não tem** default privilege
 * de função: lá a função nasce com `proacl` NULL, que é EXECUTE implícito a PUBLIC.
 *
 * ⚠️ O "pior ainda" que esta nota trazia na 1ª versão estava ERRADO no EFEITO, e a correção
 * importa para não se desenhar defesa contra o risco errado: `proacl` NULL e o default de
 * `public` deixam AMBOS o `anon` com EXECUTE. A diferença é de FORMA, e favorece `private` —
 * com `proacl` NULL um `REVOKE ... FROM PUBLIC` basta, enquanto em `public` é preciso revogar
 * de `anon`/`authenticated` POR NOME (a armadilha do CLAUDE.md).
 *
 * As 3 funções de `private` que estavam nesse estado (2 delas SECDEF) foram FECHADAS em
 * 20260818120000_authz_private_execute_fecho.sql e estão declaradas no fim desta allowlist. A
 * CAUSA-RAIZ segue de pé de propósito: um `ALTER DEFAULT PRIVILEGES IN SCHEMA private REVOKE
 * EXECUTE ON FUNCTIONS FROM PUBLIC` fecharia a classe para funções FUTURAS, mas só vale para
 * objetos criados pelo ROLE que o executa — cobertura parcial com aparência de total — e mudaria
 * a premissa medida deste cabeçalho (a Parte E emite [FUNCAO_DEFAULT_PRIVILEGE_ALTERADO] de
 * propósito). É entrega própria, com prova própria; o raciocínio completo está no cabeçalho
 * daquela migration.
 *
 * MEDIÇÃO QUE JUSTIFICA CADA ENTRADA (psql-ro, 2026-08-15, `has_function_privilege` +
 * `proacl` cru, nas então 40 funções de `AUTHZ_MANIFEST` ∪ `ACKNOWLEDGED_SENSITIVE`):
 *   · 40 de 40 presentes no banco, **0** com `proacl` NULL;
 *   · **`anon` não alcança NENHUMA** — reconfirma a medição de 2026-08-14 e é o que autoriza
 *     `permitido.anon = false` em todas (declarar sem medir fabricaria contrato falso, o erro que
 *     o cabeçalho de scripts/authz-manifest.ts adverte);
 *   · as 19 do `AUTHZ_MANIFEST` têm `authenticated=X` — é a definição delas: fecham por GATE NO
 *     CORPO, e o browser precisa alcançá-las;
 *   · 20 das 21 de `ACKNOWLEDGED_SENSITIVE` **não** têm — fecham por PRIVILÉGIO. A 21ª,
 *     `get_carteira_margem_faixa`, tem `authenticated=X` de propósito (fecha por gate de ESCOPO e
 *     PROJEÇÃO, não por privilégio) e é a única exceção; ela está anotada abaixo.
 *
 * REMEDIÇÃO 2026-08-18 (após entrarem as 3 de `private`): o conjunto tem **43** funções (19
 * manifest + 24 ACK), 43 de 43 presentes. Enquanto o fecho não for colado no SQL Editor, a
 * medição de prod acusa **3** com `proacl` NULL e **3** alcançáveis por `anon` — são exatamente
 * as 3 novas, e `bun run authz:funcoes:prod` as reporta como `[FUNCAO_NAO_APLICADA]`. Depois do
 * apply o esperado volta a ser `proacl` NULL = 0, `anon` = 0 e `authenticated` = 20 (as 19 do
 * manifest + `get_carteira_margem_faixa`); hoje são 23 porque `proacl` NULL concede a PUBLIC.
 * Este parágrafo é o que impede o bloco acima de virar afirmação falsa — releia-o junto.
 *
 * `fechadaPor` é a ÂNCORA: a última migration do repo que estabelece o ACL declarado aqui. A
 * vigilância é dela **para a frente, INCLUSIVE** — diferente da Parte C de tabela, que olha só o
 * estritamente-posterior. A razão é medida: das 5 recriações de função do contrato no repo, **as
 * 5** fazem `DROP`+`CREATE`+`REVOKE` na PRÓPRIA migration-âncora. Excluí-la deixaria de fora
 * justamente a forma que o vetor tem neste repo.
 *
 * Como adicionar uma função: (1) MEÇA o EXECUTE em prod (`has_function_privilege` para `anon` e
 * `authenticated` + o `proacl` cru — `bun run authz:funcoes:prod` faz isso); (2) declare
 * `permitido` a partir do MEDIDO, não do desejado; (3) aponte `fechadaPor` para a migration que
 * estabelece esse ACL, ou `null` enquanto o fecho não estiver no repo (o gate avisa: FECHO_PENDENTE).
 */

/** Roles vigiadas — as duas que o PostgREST expõe ao browser. */
export type RoleVigiada = 'anon' | 'authenticated';

export interface FuncaoFechada {
  /** Migration que estabelece o ACL declarado (âncora, nome do arquivo em supabase/migrations/).
   *  null = o fecho NÃO está no repo (aplicado à mão em prod, ou herdado do snapshot). */
  fechadaPor: string | null;
  /** A role pode ter EXECUTE? `false` = proibido (allowlist, fail-closed). Só há um privilégio
   *  de função, então é booleano — não a lista de privilégios que `TabelaFechada` precisa. */
  permitido: Record<RoleVigiada, boolean>;
  motivo: string;
}

/** fecha por GATE no corpo ⇒ o browser autenticado PRECISA alcançar; `anon`, nunca. */
const PORTA_GATE = { anon: false, authenticated: true } as const;
/** fecha por PRIVILÉGIO ⇒ nenhuma das duas roles do browser alcança; só service_role/cron/trigger. */
const PORTA_FECHADA = { anon: false, authenticated: false } as const;

export const AUTHZ_FUNCOES_FECHADAS: Record<string, FuncaoFechada> = {
  // ═══════════ AUTHZ_MANIFEST — fecham por GATE, `authenticated` alcança de propósito ═══════════
  // Para estas, o que a Parte E protege é o `anon`: um DROP+CREATE sem REVOKE devolve a RPC
  // gateada ao anônimo, e aí o gate no corpo é a ÚNICA tranca (auth.uid() NULL ⇒ has_role false
  // ⇒ hoje bloqueia, mas passa a depender de o gate ser fail-closed no uid NULL — e o próprio
  // manifesto documenta que `pedido_compra_split` NÃO é, por compatibilidade com cron).
  'public.fin_estimar_estoque_omie': {
    fechadaPor: '20260528150000_fin_estoque_omie_feed.sql',
    permitido: PORTA_GATE,
    motivo: 'capital imobilizado a custo — cockpit financeiro; gate private.cap_custo_ler',
  },
  'public.medir_abaixo_piso_tier': {
    fechadaPor: '20260704120000_preco_por_tier.sql',
    permitido: PORTA_GATE,
    motivo: 'folga de margem vs piso de markup; gate private.cap_custo_ler',
  },
  'public.get_preco_cockpit': {
    fechadaPor: '20260615150000_cockpit_preco_fixes.sql',
    permitido: PORTA_GATE,
    motivo: 'cockpit de preços — staff no browser; gate has_role(employee|master)',
  },
  'public.get_defasagem_cliente': {
    fechadaPor: '20260627180100_get_defasagem_cliente.sql',
    permitido: PORTA_GATE,
    motivo: 'defasagem de preço por cliente vs custo — staff no browser',
  },
  'public.get_regua_preco': {
    // Recriada por DROP+CREATE nesta mesma migration, que restaura o fecho (REVOKE + GRANT).
    fechadaPor: '20260723150000_authz_custo_fu4f_fase2_regua.sql',
    permitido: PORTA_GATE,
    motivo: 'régua de preço da vendedora — mascara piso_mc por cap_custo_ler',
  },
  'public.get_regua_preco_customer360': {
    fechadaPor: '20260723150000_authz_custo_fu4f_fase2_regua.sql',
    permitido: PORTA_GATE,
    motivo: 'régua no customer 360 — repassa o pacote já mascarado da irmã',
  },
  'public.get_skus_margem_positiva': {
    fechadaPor: '20260725120000_authz_custo_fu4f_fase3_ranking_rpc.sql',
    permitido: PORTA_GATE,
    motivo: 'conjunto de SKUs com margem > 0 p/ os engines filtrarem — a vendedora precisa',
  },
  'public.registrar_exibicao_regua': {
    fechadaPor: '20260723150000_authz_custo_fu4f_fase2_regua.sql',
    permitido: PORTA_GATE,
    motivo: 'writer do log da régua; gate de ESCRITA private.cap_regua_log_escrever',
  },
  'public.registrar_aplicacao_regua': {
    fechadaPor: '20260723150000_authz_custo_fu4f_fase2_regua.sql',
    permitido: PORTA_GATE,
    motivo: 'fecha o outcome da régua; só o vendedor dono (UPDATE filtra por auth.uid())',
  },
  'public.get_ultimos_precos_cliente': {
    // A recriação MAIS instrutiva do repo: DROP + CREATE + `REVOKE EXECUTE … FROM anon, PUBLIC`,
    // sem GRANT a authenticated — que volta pelo default privilege. O autor sabia do vetor e
    // restaurou o fecho à mão; nada no CI exigia isso dele. É o buraco que a Parte E fecha.
    fechadaPor: '20260704120000_preco_por_tier.sql',
    permitido: PORTA_GATE,
    motivo: 'últimos preços praticados por cliente — staff no browser',
  },
  'public.melhoria_clientes_por_produto': {
    fechadaPor: '20260610130000_melhorias_canal.sql',
    permitido: PORTA_GATE,
    motivo: 'clientes por produto (preço/volume 12m) — staff no browser',
  },
  'public.atp_consultar': {
    fechadaPor: '20260806101417_atp_reserva_estoque_fase1.sql',
    permitido: PORTA_GATE,
    motivo: 'disponibilidade ATP p/ staff de venda; gate private.cap_estoque_reservar',
  },
  'public.reservar_estoque': {
    fechadaPor: '20260806101417_atp_reserva_estoque_fase1.sql',
    permitido: PORTA_GATE,
    motivo: 'writer único de estoque_reservas; gate private.cap_estoque_reservar',
  },
  'public.liberar_reserva_checkout': {
    fechadaPor: '20260806101417_atp_reserva_estoque_fase1.sql',
    permitido: PORTA_GATE,
    motivo: 'libera reservas de um checkout; gate private.cap_estoque_reservar',
  },
  'public.expirar_reservas_vencidas': {
    fechadaPor: '20260806225052_atp_reserva_estoque_fase1_1_hardening.sql',
    permitido: PORTA_GATE,
    motivo: 'RPC pública que delega na higiene sem gate de private/ — gate cap_estoque_reservar',
  },
  'public.reposicao_pos_candidatos': {
    // Âncora é a 20260814022626 — a MESMA migration que a Parte D baselina por reescrever a
    // definição VIVA. As duas partes olham coisas diferentes do mesmo arquivo: a D, o corpo que
    // o parser de CREATE não vê; a E, o `REVOKE ALL … FROM PUBLIC, anon` + `GRANT … TO
    // authenticated, service_role` que ele emite logo abaixo — esse é texto comum e auditável.
    fechadaPor: '20260814022626_reposicao_po_inexistente_antes_de.sql',
    permitido: PORTA_GATE,
    motivo: 'detector de PO sumido — protocolo/fornecedor/jsonb cru; gate private.cap_compras_ler',
  },
  'public.reposicao_pos_marcador': {
    fechadaPor: '20260814000125_reposicao_pos_frescor_marcador.sql',
    permitido: PORTA_GATE,
    motivo: 'marcador de frescor do detector de PO; mesmo cap_compras_ler da irmã',
  },
  'public.converter_sugestao_em_campanha_flat': {
    fechadaPor: '20260510235956_a5ace125-5cbf-43df-940b-0d517b819a49.sql',
    permitido: PORTA_GATE,
    motivo: 'converte sugestão em campanha de desconto flat — staff no browser',
  },
  'public.pedido_compra_split': {
    // ⚠️ O gate desta NÃO roda com uid NULL (idioma de compatibilidade com cron; ver o comentário
    // dela em scripts/authz-manifest.ts). O manifesto já declara que, se `anon` ganhasse EXECUTE,
    // ela viraria anônima — esta entrada é o que passa a IMPEDIR que isso aconteça por acidente.
    fechadaPor: '20260515161910_41c8e98a-7603-4e67-9984-d8dc711a3b08.sql',
    permitido: PORTA_GATE,
    motivo: 'divide pedido de compra aprovado em filhos — staff-only quando há JWT',
  },

  // ═══════ ACKNOWLEDGED_SENSITIVE — fecham por PRIVILÉGIO: nenhuma role do browser executa ═══════
  // Aqui a Parte E protege o fecho INTEIRO: sem o REVOKE, um DROP+CREATE devolve a função a
  // `anon` E `authenticated` de uma vez, e não há gate no corpo para segurar — é justamente por
  // isso que estas foram classificadas como ACK e não no manifesto.
  'private.atp_disponivel': {
    fechadaPor: '20260808012000_atp_reconciliacao_fase3.sql',
    permitido: PORTA_FECHADA,
    motivo: 'cálculo interno saldo−reservas−segurança; chamada só pelas 4 RPCs gateadas',
  },
  'private.margem_cliente_agregada': {
    fechadaPor: '20260726160000_margem_reconciliacao_universo_unico.sql',
    permitido: PORTA_FECHADA,
    motivo: 'helper compartilhado de margem por cliente — o REVOKE é o que fecha, não o schema',
  },
  'public._data_health_compute': {
    fechadaPor: '20260702212000_data_health_estoque_reposicao_fonte_dado.sql',
    permitido: PORTA_FECHADA,
    motivo: 'cômputo de saúde de dados — cron/service_role',
  },
  'public.tint_promote_sync_run': {
    fechadaPor: '20260726120000_tint_promote_error_details_completo.sql',
    permitido: PORTA_FECHADA,
    motivo: 'promoção do sync tintométrico — service_role',
  },
  'public.tint_calc_preco_final': {
    // Recriada por DROP+CREATE nesta migration, que emite o REVOKE de volta.
    fechadaPor: '20260611190000_tint_sync_codex_fixes.sql',
    permitido: PORTA_FECHADA,
    motivo: 'cálculo de preço tint chamado pelo sync — interno',
  },
  'public.tint_recalc_preco_oficial': {
    fechadaPor: '20260611190000_tint_sync_codex_fixes.sql',
    permitido: PORTA_FECHADA,
    motivo: 'recálculo de preço oficial tint — interno',
  },
  'public.aplicar_snapshot_pendente': {
    fechadaPor: '20260611195000_reposicao_aplicar_snapshot_pendente.sql',
    permitido: PORTA_FECHADA,
    motivo: 'aplica snapshot de reposição — cron/service_role',
  },
  'public.cmc_ledger_capture': {
    // Era a única das 40 sobre a qual NENHUMA migration emitia GRANT ou REVOKE — nem parcial: ela
    // nasce por `CREATE OR REPLACE` em 20260614170000_cmc_ledger.sql e herdava o default
    // privilege, e o fecho medido em prod ({postgres,service_role,sandbox_exec}, auth=NÃO,
    // anon=NÃO) vinha inteiramente de fora do repo. A âncora abaixo REGISTRA esse fecho (no-op em
    // prod, de propósito), que é o que a traz para dentro da vigilância estática da Parte E.
    fechadaPor: '20260818121919_authz_fecho_execute_registrado_3_funcoes.sql',
    permitido: PORTA_FECHADA,
    motivo: 'captura no ledger de cmc — trigger trg_cmc_ledger_capture em inventory_position',
  },
  'public.reposicao_cold_start_parametros': {
    fechadaPor: '20260627130000_reposicao_cold_start_fix_gate_cron.sql',
    permitido: PORTA_FECHADA,
    motivo: 'parâmetros cold-start da reposição — interno',
  },
  'public.get_customer_margin_summary': {
    fechadaPor: '20260726160000_margem_reconciliacao_universo_unico.sql',
    permitido: PORTA_FECHADA,
    motivo: 'margem agregada por cliente p/ o health score — edge calculate-scores via cron',
  },
  'public.get_carteira_margem_faixa': {
    // ⚠️ A EXCEÇÃO MEDIDA desta lista: ACK que `authenticated` alcança (auth=X em prod). Ela é a
    // "terceira categoria" do cabeçalho do manifesto — fecha por gate de ESCOPO
    // (carteira_visivel_para) e de PROJEÇÃO (CASE WHEN cap_custo_ler), nenhum deles um RAISE, e
    // por isso não cabe no AUTHZ_MANIFEST. Aqui ela cabe: o contrato desta lista é ACL, não gate.
    // O que a Parte E protege nela é o `anon` — que os dois gates NÃO seguram (sem auth.uid() o
    // escopo é vazio, mas a régua populacional e o `g` continuariam saindo).
    fechadaPor: '20260813234112_carteira_margem_faixa_motivo_gate_custo.sql',
    permitido: PORTA_GATE,
    motivo: 'margem por faixa na carteira — o vendedor no browser alcança; fecha por escopo+projeção',
  },
  // ⚠️ REVELADA pelo detector, e baselinada em vez de acomodada (§7 do histórico). Até
  // 20260818121919, a última migration a tocar o ACL desta era a 20260510235956 ("Fatia E3
  // Fase 1"), que revoga de `PUBLIC, anon` e **mantém `GRANT EXECUTE … TO authenticated`** — ou
  // seja, o repo AFIRMAVA que authenticated executa, enquanto prod dizia o contrário (medido
  // 2026-08-15 e reconfirmado 2026-08-18: auth=NÃO, ACL `{postgres,service_role,sandbox_exec}`).
  // A saída NÃO foi declarar `permitido.authenticated = true` para calar o gate — isso fabricaria
  // contrato falso na pior direção, AUTORIZANDO a role que hoje não alcança e deixando verde um
  // DROP+CREATE que a reabrisse. Foi REGISTRAR o fecho: a âncora abaixo revoga de `authenticated`
  // por NOME (revogar de PUBLIC não a tiraria), no-op em prod, e o gate estático passa a vigiar.
  'public.detectar_skus_sem_grupo': {
    fechadaPor: '20260818121919_authz_fecho_execute_registrado_3_funcoes.sql',
    permitido: PORTA_FECHADA,
    motivo:
      'self-heal de SKU sem grupo — cron detectar-outliers-diario, que roda como postgres (superuser)',
  },
  'public.reposicao_alerta_pedido_minimo_tick': {
    fechadaPor: '20260615210000_reposicao_auto_aprovacao_v2.sql',
    permitido: PORTA_FECHADA,
    motivo: 'tick do alerta de pedido mínimo — cron reposicao-alerta-pedido-minimo',
  },
  'public.sayerlack_retry_orfaos': {
    fechadaPor: '20260528040000_sayerlack_retry_motor.sql',
    permitido: PORTA_FECHADA,
    motivo: 'retry de envios órfãos ao portal — cron sayerlack-retry-orfaos',
  },
  'public.reposicao_pedido_auto_aprovavel': {
    fechadaPor: '20260629140000_reposicao_preco_ausente_null.sql',
    permitido: PORTA_FECHADA,
    motivo: 'veredito de auto-aprovação — chamada só pelo tick, nunca direto',
  },
  'public.reposicao_aplicar_depara_sayerlack_auto': {
    fechadaPor: '20260626193000_reposicao_depara_sayerlack_auto.sql',
    permitido: PORTA_FECHADA,
    motivo: 'de-para automático do boletim Sayerlack — edge via cron, service_role',
  },
  'public.envio_portal_lock_candidatos': {
    fechadaPor: '20260530230000_fix_portal_lock_retry_blindspot.sql',
    permitido: PORTA_FECHADA,
    motivo: 'lock dos candidatos a envio — edge enviar-pedido-portal-sayerlack',
  },
  'public.envio_portal_claim_ids': {
    fechadaPor: '20260604180000_envio_portal_claim_ids_lista_positiva.sql',
    permitido: PORTA_FECHADA,
    motivo: 'claim por lista positiva de ids — edges de disparo e envio ao portal',
  },
  'public.iniciar_envio_portal_pre_claim': {
    fechadaPor: '20260605140000_iniciar_envio_portal_pre_claim.sql',
    permitido: PORTA_FECHADA,
    motivo: 'pré-claim antes do disparo — edge disparar-pedidos-aprovados',
  },
  'public.reposicao_persistir_qtde_inteira': {
    fechadaPor: '20260606190000_reposicao_qtde_inteira_persist.sql',
    permitido: PORTA_FECHADA,
    motivo: 'arredonda/persiste qtde inteira do pedido — edge disparar-pedidos-aprovados',
  },
  // ⚠️ Mesmo caso da `detectar_skus_sem_grupo` acima — mesma 20260510235956 concedendo a
  // authenticated, mesma âncora registrando o fecho. Sendo `RETURNS trigger`, o EXECUTE nem é o
  // que a faz rodar: Postgres não checa esse privilégio no disparo do trigger (provado em
  // db/test-authz-fecho-execute-registrado.sh), então aqui o fecho é 2ª tranca — vale contra a
  // chamada DIRETA por PostgREST, não contra o trigger.
  'public.set_status_envio_portal_on_disparo': {
    fechadaPor: '20260818121919_authz_fecho_execute_registrado_3_funcoes.sql',
    permitido: PORTA_FECHADA,
    motivo:
      'RETURNS trigger em pedido_compra_sugerido (trg_set_status_envio_portal), sem rota PostgREST',
  },

  // ═══════════ schema `private` — as 3 que nasciam com `proacl` NULL (#1768 §9.1) ═══════════
  // MEDIDO (psql-ro, 2026-08-15, reconfirmado 2026-08-18): `pg_default_acl` não tem NENHUMA linha
  // para o schema `private` ⇒ função criada lá nasce com `proacl` NULL = EXECUTE implícito a
  // PUBLIC. E `private` concede USAGE a `anon` E `authenticated` (nspacl), então o schema não é
  // barreira de EXECUTE — só de ROTA (o PostgREST não o publica). Estas 3 eram as únicas de 23
  // nesse estado; as outras 20 já tinham ACL explícito.
  //
  // Nenhuma era explorável quando o fecho foi escrito — mas por razões que NÃO eram privilégio, e
  // é isso que o fecho corrige. Provado em db/test-authz-private-execute-fecho.sh (15 asserts,
  // 3 falsificações, verde em lc_messages C e pt_BR.UTF-8).
  'private.custo_canonico': {
    fechadaPor: '20260818120000_authz_private_execute_fecho.sql',
    permitido: PORTA_FECHADA,
    motivo:
      'helper puro do custo canônico (SECURITY INVOKER, não lê tabela). Barrava anon só por ' +
      'ACIDENTE — chama private.regua_num_finito, que nega anon; F3 do harness abre o helper e ' +
      'mostra anon EXECUTANDO. Consumidor real: public.get_skus_margem_positiva (SECDEF, owner ' +
      'postgres), que segue chamando após o REVOKE (L8)',
  },
  'private.frec_sem_margem': {
    fechadaPor: '20260818120000_authz_private_execute_fecho.sql',
    permitido: PORTA_FECHADA,
    motivo:
      'RETURNS trigger do scrub de margem do FU4-F fase 3 (nulifica m_ij/lie em ' +
      'farmer_recommendations). Chamada direta já morria em 0A000 no EXECUTOR, com ou sem ' +
      'EXECUTE (L3) — o REVOKE é 2ª tranca; disparar trigger não checa EXECUTE (L9)',
  },
  'private.fbrec_sem_margem': {
    fechadaPor: '20260818120000_authz_private_execute_fecho.sql',
    permitido: PORTA_FECHADA,
    motivo:
      'irmã da acima em farmer_bundle_recommendations (nulifica m_bundle/lie_bundle e remove ' +
      'cost/margin do jsonb bundle_products). Mesma barreira de executor e mesma 2ª tranca (L10)',
  },
};
