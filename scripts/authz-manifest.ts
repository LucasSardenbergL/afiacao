/**
 * authz-manifest.ts — contrato de autorização das RPCs SECURITY DEFINER sensíveis.
 * ============================================================================================
 *
 * Fonte de verdade CURADA do check anti-regressão de gate (scripts/authz-gate-check.ts).
 * Cada função SECDEF que toca custo/preço/estoque e é EXECUTÁVEL por `authenticated` DEVE estar
 * aqui, com o gate de bloqueio esperado. O check garante que nenhuma migration recrie a função
 * sem esse gate (Parte A) e que nenhuma SECDEF sensível nova fique sem classificação (Parte B).
 *
 * Ao adicionar/gatear uma função SECDEF sensível: classifique-a aqui (o CI falha até você fazê-lo).
 * Ao MUDAR o gate de uma função (decisão de política): atualize o requiredGate aqui — é o ponto
 * de revisão consciente. Chave = `schema.name` (sem assinatura: overloads compartilham o gate).
 *
 * Semeado 2026-07-09 a partir do inventário PROD (psql-ro) — todas gateadas na criação do check.
 */
import type { RequiredGate } from './lib/authz-contract';

export interface AuthzEntry {
  sensitive: true;
  requiredGate: RequiredGate;
  motivo: string;
}

export const AUTHZ_MANIFEST: Record<string, AuthzEntry> = {
  // E2/FU4 (2026-07-18): estas duas leem CUSTO, e o gate único `pode_ver_carteira_completa`
  // as concedia ao papel gerencial operacional junto com preço e crédito. Passaram a exigir
  // `private.cap_custo_ler` — master + estrategico + super_admin. Mudança de POLÍTICA revisada
  // conscientemente aqui, como manda o cabeçalho deste arquivo.
  'public.fin_estimar_estoque_omie': {
    sensitive: true,
    requiredGate: { anyOf: [{ call: 'cap_custo_ler' }] },
    motivo: 'capital imobilizado em estoque a custo (Σ saldo×cmc) — PR #1264; E2/FU4 estreitou p/ estrategico+',
  },
  'public.medir_abaixo_piso_tier': {
    sensitive: true,
    requiredGate: { anyOf: [{ call: 'cap_custo_ler' }] },
    motivo: 'folga negativa de margem vs piso de markup — cockpit financeiro; E2/FU4 estreitou p/ estrategico+',
  },
  'public.get_preco_cockpit': {
    sensitive: true,
    requiredGate: { anyOf: [{ call: 'has_role', roles: ['employee', 'master'] }, { call: 'pode_ver_carteira_completa' }] },
    motivo: 'cockpit de preços — bloqueia staff; pode_ver_carteira_completa afina o detalhe',
  },
  'public.get_defasagem_cliente': {
    sensitive: true,
    requiredGate: { anyOf: [{ call: 'has_role', roles: ['employee', 'master'] }, { call: 'pode_ver_carteira_completa' }] },
    motivo: 'defasagem de preço por cliente vs custo',
  },
  // FU4-F fase 2 (2026-07-20): as duas continuam com gate de ENTRADA `has_role(employee|master)`
  // DE PROPÓSITO — a vendedora precisa do SINAL ("abaixo do piso"). O que mudou é interno: elas
  // pararam de emitir `cmc`/`aliquota_venda` e passaram a mascarar `piso_mc`/`piso_gap_pct` atrás
  // de `v_pode_num := private.cap_custo_ler(...)`, no padrão do get_preco_cockpit.
  //
  // ⚠️ LIMITE DESTE CHECK, declarado para quem vier depois: `requiredGate` só sabe verificar gate
  // em FORMA DE BLOQUEIO (`IF NOT gate() THEN RAISE`). Mascaramento de CAMPO não é expressável
  // aqui — pôr cap_custo_ler no requiredGate exigiria um RAISE e bloquearia a vendedora inteira,
  // matando a régua. A anti-regressão do mascaramento é o assert estrutural A4 da migration
  // 20260723150000 + db/test-authz-custo-fu4f-fase2-regua.sh (A10-A14). Mesma situação do
  // get_preco_cockpit, cujo `v_pode_num` também não aparece aqui.
  'public.get_regua_preco': {
    sensitive: true,
    requiredGate: { anyOf: [{ call: 'has_role', roles: ['employee', 'master'] }] },
    motivo: 'régua de preço a partir do cmc; desde FU4-F/2 devolve SINAL (abaixo_piso) e mascara piso_mc por cap_custo_ler',
  },
  'public.get_regua_preco_customer360': {
    sensitive: true,
    requiredGate: { anyOf: [{ call: 'has_role', roles: ['employee', 'master'] }] },
    motivo: 'régua de preço no customer 360 — repassa o pacote já mascarado da get_regua_preco',
  },
  // FU4-F fase 3 (#1520). Toca product_costs com privilégio, mas NÃO devolve custo: responde
  // só "este SKU tem margem > 0?" para os engines de recomendação filtrarem candidatos. O
  // ranqueamento ficou no cliente, por afinidade — nada que toque custo.
  //
  // Gate é `employee OR master`, NÃO cap_custo_ler, e isso é deliberado: a vendedora PRECISA
  // do conjunto (é o filtro da feature dela), e usar a capability de custo aqui a excluiria —
  // exatamente o "fechar e deixar degradar" que apagaria cross-sell e bundles (§5 do spec).
  // A capability continua governando o dado BRUTO, na policy de product_costs.
  //
  // ⚠️ LIMITE, no mesmo espírito do bloco acima: este check não expressa "quanto vaza pela
  // resposta". O resíduo aceito é 1 bit por SKU POR SNAPSHOT, acumulável no tempo — e ele NÃO
  // está fechado enquanto `omie_products.valor_unitario` (o limiar da comparação) for
  // escrevível por employee, o que hoje é o caso. Follow-up no corpo do #1520; a
  // anti-regressão desta função é db/test-authz-custo-fu4f-fase3-ranking.sh.
  'public.get_skus_margem_positiva': {
    sensitive: true,
    requiredGate: { anyOf: [{ call: 'has_role', roles: ['employee', 'master'] }] },
    motivo: 'conjunto de SKUs vendáveis (margem > 0) p/ os engines filtrarem candidatos sem ler custo; sem parâmetro, para não virar oráculo ajustável',
  },
  // Writer do closed-loop da régua. Gate de ESCRITA próprio (`private.cap_regua_log_escrever`,
  // employee|master) — NUNCA cap_custo_ler: o §4.2 do spec de 2026-07-18 proíbe reusar a função de
  // leitura em escrita, e reusá-la deixaria estrategico/super_admin registrar em nome de outro
  // vendedor (bloqueador P1 do Codex na fase 1). Toca inventory_position.cmc porque apura o custo
  // do log NO SERVIDOR — o cliente não o recebe mais e não teria como informá-lo.
  'public.registrar_exibicao_regua': {
    sensitive: true,
    requiredGate: { anyOf: [{ call: 'cap_regua_log_escrever' }] },
    motivo: 'grava exibição da régua com piso_mc/cmc_usado apurados server-side; salesperson_id fixado em auth.uid()',
  },
  // Fecha o loop do log. Não toca custo (por isso a Parte B do check não a exigia), mas é SECDEF
  // que ESCREVE no log de custo — classificar torna o par writer/updater visível na auditoria em
  // vez de deixar metade dele fora do inventário. Gate de escrita + predicado de ownership
  // (`salesperson_id = auth.uid()` no UPDATE), para staff não fechar o outcome alheio.
  'public.registrar_aplicacao_regua': {
    sensitive: true,
    requiredGate: { anyOf: [{ call: 'cap_regua_log_escrever' }] },
    motivo: 'fecha o outcome da régua; só o vendedor DONO do registro (UPDATE filtra por auth.uid())',
  },
  'public.get_ultimos_precos_cliente': {
    sensitive: true,
    requiredGate: { anyOf: [{ call: 'has_role', roles: ['employee', 'master'] }] },
    motivo: 'últimos preços praticados por cliente',
  },
  'public.melhoria_clientes_por_produto': {
    sensitive: true,
    requiredGate: { anyOf: [{ call: 'has_role', roles: ['employee', 'master'] }] },
    motivo: 'clientes por produto (preço/volume 12m)',
  },
  // ATP fase 1 (2026-08-06, programa Cabreúva Pista B): as 4 RPCs de reserva de estoque leem
  // disponibilidade derivada de inventory_position (via private.atp_disponivel) e escrevem
  // estoque_reservas. Gate único private.cap_estoque_reservar = staff (employee/master) OU
  // service_role (engines/reconciliação fase 3). Custo (cmc) NUNCA atravessa o retorno.
  'public.atp_consultar': {
    sensitive: true,
    requiredGate: { anyOf: [{ call: 'cap_estoque_reservar' }] },
    motivo: 'disponibilidade ATP (saldo−reservas−segurança) p/ staff de venda — sem custo',
  },
  'public.reservar_estoque': {
    sensitive: true,
    requiredGate: { anyOf: [{ call: 'cap_estoque_reservar' }] },
    motivo: 'cria reserva de estoque (writer único de estoque_reservas)',
  },
  'public.liberar_reserva_checkout': {
    sensitive: true,
    requiredGate: { anyOf: [{ call: 'cap_estoque_reservar' }] },
    motivo: 'libera reservas ativas de um checkout (cancelamento/abandono)',
  },
  'public.expirar_reservas_vencidas': {
    sensitive: true,
    requiredGate: { anyOf: [{ call: 'cap_estoque_reservar' }] },
    motivo: 'higiene de reservas vencidas (cron da fase 3 via service_role)',
  },
  // 2026-08-14 — a RPC do card "pedido sem PO no Omie". SECDEF com GRANT EXECUTE a `authenticated`,
  // devolve protocolo do portal, fornecedor e a `resposta_canal` jsonb CRUA. Gate master-only
  // `private.cap_compras_ler` (FU4-G: "compras não é carteira" — o gate anterior,
  // `pode_ver_carteira_completa`, liberava o papel gerencial).
  //
  // ⚠️ POR QUE ESTAVA FORA — e a lição, que vale para toda RPC nova: a Parte B só EXIGE
  // classificação de SECDEF que toca o eixo custo/preço/estoque (SENSITIVE_* em
  // scripts/lib/authz-contract.ts). Esta não toca nenhum desses tokens; o que ela vaza é dado
  // COMERCIAL de compras. Ou seja: a cobertura automática não a alcançava, e sem esta entrada
  // nenhuma recriação futura era vigiada — a defesa era um bloco `DO $pos$` de regex que rodou
  // UMA vez, na própria migration 20260813195914, e não protege a PRÓXIMA (o FU4-G já reescreveu
  // esta função uma vez, por regexp_replace). Registrar aqui troca "uma vez" por "toda recriação",
  // via last-writer + fail-closed da Parte A.
  //
  // ⚠️ Registrá-la exigiu ANTES consertar `blocksOnCall`: a forma real
  // `(SELECT private.cap_compras_ler((SELECT auth.uid()))) IS NOT TRUE` era lida como gate
  // DECORATIVO (medido em 2026-08-14). O detector estava calibrado só na forma canônica — e é
  // por isso que o eixo nunca foi tentado. Detector cego não é ausência de risco.
  //
  // O limite desta entrada, declarado: ela prova que a CHAMADA governa um ramo alcançável que
  // levanta exceção. NÃO prova que a exceção acontece para quem deve — isso é asserção
  // EXECUTADA, em db/test-pos-candidatos-guard-temporal.sh (D1/D4 + falsificações N1/N2/N3).
  'public.reposicao_pos_candidatos': {
    sensitive: true,
    requiredGate: { anyOf: [{ call: 'cap_compras_ler' }] },
    motivo:
      'detector de PO sumido — protocolo/fornecedor/jsonb cru p/ authenticated; master-only pelo FU4-G',
  },
  // ⚠️ ATP fase 1.1 (migration 20260806225052): existe uma 5ª função que ESCREVE em
  // estoque_reservas e NÃO tem gate — `private.expirar_reservas_vencidas_job()`. É
  // DE PROPÓSITO e não é furo: pg_cron nativo roda SEM JWT, então auth.role() e
  // auth.uid() são NULL e cap_estoque_reservar devolve false — com o gate, a higiene
  // era INAGENDÁVEL (42501; medido em prod antes do fix). A defesa dela não é gate de
  // papel, é PRIVILÉGIO: vive em `private`, com REVOKE de PUBLIC/anon/authenticated,
  // então só o owner (postgres, que é quem o pg_cron usa) a executa. A RPC pública
  // acima segue gateada e agora apenas DELEGA nela — 1 writer da lógica. Não entra no
  // manifesto porque o manifesto cataloga superfície ALCANÇÁVEL por anon/authenticated,
  // e esta não é; se um dia ganhar GRANT para authenticated, ela PRECISA de gate.
};

/**
 * SECDEF que tocam dado sensível mas NÃO precisam de gate customer-facing — baseline 2026-07-09.
 * Cada entrada é uma decisão consciente: a função não é executável por `authenticated` (só
 * service_role/cron/staff-internal) OU o "toque" é falso-positivo do parser (menção em string
 * já mascarada / coluna homônima). Justificativa por linha. Semeado a partir do inventário PROD
 * (psql-ro: 20 SECDEF tocam sensível, 8 expostas a authenticated = o AUTHZ_MANIFEST acima).
 * v2: auditar cada uma individualmente e cruzar com os grants reais.
 */
export const ACKNOWLEDGED_SENSITIVE = new Set<string>([
  // ATP fase 1 (2026-08-06): cálculo interno disponivel = saldo−reservas−segurança. Lê
  // inventory_position mas NÃO é executável por authenticated/anon (REVOKE ALL na própria
  // migration; GRANT só service_role) — chamada exclusivamente pelas 4 RPCs gateadas acima.
  'private.atp_disponivel',
  // Baseline 2026-07-09: as 7 SECDEF abaixo tocam custo/preço/estoque mas NÃO são executáveis por
  // authenticated nem anon (confirmado psql-ro: auth_exec=f, anon_exec=f) — service_role/cron/
  // trigger/interno, não customer-facing. Vazamento customer-facing exige EXECUTE p/ authenticated.
  'public._data_health_compute', // cômputo de saúde de dados (cron/service_role)
  'public.tint_promote_sync_run', // sync tintométrico → promoção (service_role)
  'public.tint_calc_preco_final', // cálculo de preço tint, chamado pelo sync (interno)
  'public.tint_recalc_preco_oficial', // recálculo de preço oficial tint (interno)
  'public.aplicar_snapshot_pendente', // aplica snapshot de reposição (cron/service_role)
  'public.cmc_ledger_capture', // captura no ledger de cmc (trigger/service_role)
  'public.reposicao_cold_start_parametros', // parâmetros cold-start da reposição (interno)
  // 2026-07-21 (#1495): margem bruta por cliente p/ o health score do farmer. Lê product_costs, mas
  // a própria migration a fecha por PRIVILÉGIO — REVOKE ALL de PUBLIC/anon/authenticated + GRANT
  // EXECUTE só a service_role (a edge calculate-scores, via cron). Só a margem AGREGADA por cliente
  // atravessa; o custo unitário não sai do banco. Mesmo perfil da irmã get_customer_sales_summary
  // (confirmado psql-ro: auth_exec=f, anon_exec=f, svc_exec=t). Reconfirmar após o apply em prod.
  'public.get_customer_margin_summary',

  // 2026-07-21 — helper COMPARTILHADO de margem por cliente (PR #1519). Fecha por PRIVILÉGIO,
  // não por gate no corpo, e é por isso que entra aqui e não no AUTHZ_MANIFEST:
  //   · o REVOKE é o que fecha: de PUBLIC + anon + authenticated (função nova nasce com
  //     proacl NULL = EXECUTE implícito a PUBLIC, e o default privilege do Supabase concede às
  //     roles nomeadas — revogar dos dois jeitos), GRANT só a service_role;
  //   · `private` fecha a rota HTTP (o PostgREST só publica os schemas configurados), mas
  //     ⚠️ NÃO é barreira de EXECUTE: medido em prod, `private` concede USAGE a authenticated E
  //     anon (`nspacl = {…,authenticated=U/postgres,anon=U/postgres,…}`). Quem depender do schema
  //     como se fosse trava está enganado — é o REVOKE, e só ele;
  //   · os consumidores é que carregam o gate: `get_carteira_margem_faixa` (FU4-F fase 3) aplica
  //     cap_custo_ler na PROJEÇÃO do número e cap_carteira_ler/carteira_visivel_para no ESCOPO;
  //     `get_customer_margin_summary` (#1495, acima) passa a DERIVAR deste helper em vez de ter
  //     cálculo próprio — as duas discordavam em 28,5% dos clientes na faixa.
  // Provado em db/test-margem-cliente-helper-compartilhado.sh (L1-L5): anon/authenticated/PUBLIC
  // com has_function_privilege=f, service_role=t, e a função residindo em `private`.
  'private.margem_cliente_agregada',

  // 2026-07-22 — FU4-F fase 3. TERCEIRA CATEGORIA (gate de FILTRO/PROJEÇÃO; ver cabeçalho).
  // ⚠️ O parser não a flagou sozinha: o corpo não cita `product_costs`/`cost_price`, porque ela
  // deriva de `private.margem_cliente_agregada()`. É um PONTO CEGO do detector — função
  // cost-derived VIA HELPER passa despercebida —, então está aqui por registro manual, não por
  // varredura. Ela É sensível (margem por cliente ⇒ custo agregado) e É executável por
  // `authenticated` (o vendedor no browser). O gate é duplo e nenhum dos dois é RAISE:
  //   · ESCOPO (quais linhas): `WHERE v_cap_todo OR carteira_visivel_para(cid, uid)` — espelha a
  //     policy `fcs_select_carteira` de farmer_client_scores; sem carteira ⇒ zero linhas;
  //   · PROJEÇÃO (qual campo): `CASE WHEN v_pode_num THEN b.pct END` — sem `cap_custo_ler` o
  //     NÚMERO vem NULL, mas a FAIXA e o `g` saem sempre ("o número fecha, o sinal fica").
  // Ambos provados em db/test-fu4f-fase3-carteira-margem-faixa.sh (32 asserts): E1-E5b
  // (escopo), F1-F5 (projeção), G1-G4 (classificação), H1-H5 (a régua populacional e o `g`
  // NULL≠0), I1-I4 (ACL). Fail-closed sem `auth.uid()` em E5/E5b.
  // As falsificações K1-K5 sabotam a migration por `sed` cirúrgico e exigem o VERMELHO do
  // assert que cada uma mira — K1 o fail-closed (E5b), K2 o CASE de projeção (F2), K3 a régua
  // populacional (H1), K4 o WHERE de escopo (E1), K5 o `g` NULL virando 0 (H5); K6 é o canário
  // que prova que a migration íntegra voltou. `sed` que não casa nada FALHA o harness, em vez
  // de deixá-lo verde com uma sabotagem que nunca aconteceu.
  //
  // 2026-08-13 — fase 3b: o gate de PROJEÇÃO só vale se o LIMIAR não for escrevível por quem ele
  // barra. `v_piso`/`v_meta` vêm de `public.farmer_algorithm_config` (keys `margem_faixa_*`), e
  // essa tabela era escrita por QUALQUER staff (policy FOR ALL master OR employee + DML de
  // `authenticated`): mover o piso e reler a FAIXA é uma comparação por chamada, e ~13 delas
  // reconstroem a margem por busca binária — o número saía pelo canal lateral que o `CASE WHEN
  // v_pode_num` fechava. Corrigido por 3 policies RESTRICTIVE (INSERT/UPDATE/DELETE) em
  // `farmer_algorithm_config` gateadas pelo MESMO `private.cap_custo_ler` — quem já lê o número
  // não ganha nada movendo o limiar, então esse é o corte exato (e não `has_role(master)`, que
  // criaria um segundo eixo de autorização divergente deste). O SELECT fica aberto de propósito.
  // ⚠️ Lição transferível: um gate de PROJEÇÃO é derrotado por qualquer entrada ESCREVÍVEL que
  // mude o veredito exposto. Ao fechar um número atrás de um cap, feche também os PARÂMETROS que
  // decidem o sinal que continua saindo.
  // ⚠️ TRUNCATE não passa por RLS — policy nenhuma o vê. `authenticated` o tinha nesta tabela
  // (o `D` do `arwdDxtm` default do Supabase), e truncar apagaria os limiares devolvendo a RPC
  // ao COALESCE default: as 3 policies viravam decoração sem serem violadas. Revogado por NOME
  // na mesma migration. Ao fechar escrita por RLS, cheque TRUNCATE — a RLS não o cobre.
  // (Não era alcançável pelo browser: o PostgREST não tem verbo de TRUNCATE.)
  // Provado em db/test-farmer-config-limiar-faixa.sh (22 asserts): aplica a RPC real do #1543,
  // exerce o ataque ponta-a-ponta (M3) e traz a CONTRAPROVA (M2 — o master move o limiar e a
  // faixa VIRA amarelo), sem a qual M3 passaria por vacuidade. 4 sabotagens exigem o vermelho
  // exato, incluindo "UPDATE sem USING" (S2), que prova que o USING não é decorativo: só com
  // WITH CHECK, `SET key='outra' WHERE key='margem_faixa_piso_pct'` some com a key protegida e
  // devolve o limiar ao default.
  //
  // 2026-08-13 — fase 3c: `motivo` entra no gate de PROJEÇÃO, junto de `margem_pct`. A revisão
  // adversarial do #1723 (Codex gpt-5.6-sol) achou um vazamento de LEITURA pior que o oráculo de
  // ESCRITA que a fase 3b fechou — este não precisa escrever nada e resolve numa ÚNICA resposta.
  // Mecanismo: `g` é AFIM na margem (`margem_pct = A + B*g`, A=100*p10, B=100*max(p90-p10,0.01)),
  // e `motivo` dava as duas ÂNCORAS ABSOLUTAS que faltavam ('abaixo_do_piso' ⇒ margem<30,
  // 'abaixo_da_meta' ⇒ 30≤margem<50). Tomando o MAIOR `g` de cada motivo, o atacante resolve
  // B=(50-30)/(g50-g30) e A=30-B*g30 e inverte a carteira inteira.
  // MEDIDO em prod (read-only, 2026-08-13): A_est=29,4560 vs 29,4260 real (erro 0,03 pp) e
  // B_est=45,7780 vs 45,7780 (erro ZERO); 859 dos 1.075 clientes com margem reconstruídos com
  // erro MÁXIMO de 0,03 pp. Não era risco teórico.
  // ⚠️ Lição transferível (irmã da fase 3b): lá o gate de projeção caía por uma entrada
  // ESCREVÍVEL; aqui cai por um rótulo LEGÍVEL que ancora a escala. Um campo derivado que é
  // transformação MONÓTONA do número protegido só resiste enquanto ninguém publicar dois pontos
  // conhecidos da curva — e um vocabulário categórico com limiares FIXOS é exatamente isso.
  // Ao gatear um número, enumere o que mais na MESMA resposta permite reconstruí-lo.
  // ⚠️ O que NÃO foi feito, e por quê: `g` continua saindo sem gate. Gateá-lo fecharia o eixo,
  // mas `calcularHealthScore` renormaliza os pesos com `g` null, então o score de quem não tem
  // cap MUDARIA — produto embutido em entrega de autorização (o que o #1543 evitou). O custo foi
  // MEDIDO antes de descartar (harness `scripts/impacto-gate-g.ts`): 640 visões de cliente
  // mudariam de score nos 2 farmers sem cap (Δ médio 5,88/6,02; máx 14,5), 91 mudariam de classe,
  // AGENDA idêntica. Decisão do founder (2026-08-13): fechar a âncora, preservar o score.
  // ⚠️ Limite honesto da defesa: ela depende de `p10 > 0` (hoje 29,43%). A fronteira 'vermelho'
  // (margem<0) só não é 2ª âncora porque está SATURADA (todo pct<p10 tem g=0). Se a população
  // ganhar margem negativa relevante, p10 cai e aquela fronteira devolve a âncora sozinha. E a
  // ORDENAÇÃO por margem segue exposta por construção. Quem mexer na régua revisita isto.
  // Provado em db/test-carteira-margem-faixa-motivo-gate.sh (24 asserts): A1-A4 (com cap nada
  // regride), B1-B3 (sem cap a âncora some), C1-C3 (faixa e `g` PRESERVADOS — a prova de que não
  // houve mudança de produto), D1-D5 (escopo/ACL/idempotência), E1-E3 (a calibração não fecha, e
  // o master legítimo AINDA calibra — sem E3 os E1/E2 passariam por vacuidade). Falsificações
  // K1-K3 exigem o vermelho exato (K2 sabota gateando `g`, que é o assert que protege o produto)
  // e K4/K4b são o canário do restore.
  'public.get_carteira_margem_faixa',
]);

/** chave de lookup a partir de schema+name (case-insensitive, sem assinatura) */
export function manifestKey(schema: string, name: string): string {
  return `${schema}.${name}`.toLowerCase();
}
