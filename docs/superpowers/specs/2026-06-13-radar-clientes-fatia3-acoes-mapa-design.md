# Radar de Clientes — Fatia 3: totalizador/ranking de cidades + ações (Omie + Tarefa) + mapa — Design

**Data:** 2026-06-13 · **Status:** design fechado com o founder (brainstorming + 2ª opinião Codex gpt-5.5), aguardando review da spec
**Decisores:** founder (produto/escopo) + Claude (arquitetura) + Codex (2ª opinião priorizada)
**Pré-requisito de IMPLEMENTAÇÃO:** ✅ smoke da Fatia 2 no device PASSOU (2026-06-13 — MG carrega instantâneo após o fix da RLS por-linha #792; filtros CNAE/município #789 OK). A base está validada em runtime; pode empilhar.

---

## 1. Contexto

Fatia 1 (fundação, 526k empresas RFB) e Fatia 2 (tela `/radar`: lista server-side + filtros + KPIs + registrar-contato com undo) estão **em produção e validadas no smoke**. A Fatia 3 fecha a v1 do Radar com o que de fato destrava venda:

- **Totalizador/ranking por cidade** — "onde caçar hoje" (pedido explícito do founder + apontado por mim e pelo Codex, independentemente, como a feature de **maior valor**).
- **Contatabilidade** — separar quem tem telefone de quem não tem, e agir (WhatsApp).
- **Ações sobre o lead** — cadastrar no Omie (Oben) + atribuir Tarefa.
- **Mapa** — visão geográfica (mesma fonte de dados do ranking).

### Decisões do founder (2026-06-13, fechadas uma a uma)

| Decisão | Escolha | Por quê |
| --- | --- | --- |
| **Cadastro no Omie** | **SÓ Oben** (uma conta) | Founder: "senão me engano ao cadastrar em uma empresa, cadastra em todas". Codex alertou risco de duplicidade/empresa errada nas 3 contas. Oben é a conta comercial que revende pro segmento moveleiro (o alvo do Radar). |
| **Totalizador por cidade** | **Ranking acionável** ("onde caçar"), não só número | Convergência independente eu+Codex: o número cru vale menos que a fila de cidades ordenada por densidade de prospect. |
| **Mapa** | **Na v1** (Leaflet agregado por cidade) | Founder quer agora; custo marginal baixo (compartilha a RPC do ranking + padrão `AdminRoutePlanner` pronto). |
| **Preset "rota de amanhã"** | **CORTADO da Fatia 3** | Founder: "Anderson entrega, eu visito" — entrega ≠ visita, então a premissa do Codex ("carona na entrega") não se sustenta. O ranking de cidades cobre o "onde ir". Reposicionado como follow-up (§8). |
| **Atribuir Tarefa** | Sempre pro founder (`assigned_to = quem clicou`), redistribui depois | Lead não tem vendedora dona. |

---

## 2. Arquitetura

### 2a. Motor do totalizador/ranking/mapa — RPC `radar_contagem_por_municipio(filtros)`

**Uma RPC alimenta três usos** (ranking, totalizador, mapa). `SECURITY DEFINER`, gate gestor/master.

- **Agrega por `municipio_codigo` + `uf`** (código TOM da RFB — Codex: agrupar por código+UF, não por nome, que repete entre estados), join `radar_municipios` (codigo→nome/lat/lng).
- **Aplica os MESMOS filtros ESTRUTURAIS da lista** (espelha o predicado de `useRadarLista`): `uf`, `cnae` (prefixo/exato via `digitosCnae`), `status` (default exclui `descartado`), `incluir_ja_clientes`, faixa de `data_abertura` (preset novas/estabelecidas). **NÃO** aplica a busca textual livre (razão/fantasia) — busca por nome é pra achar 1 empresa, não pra ranking geográfico; omitir evita o `ILIKE '%%'` full-scan que o Codex alertou.
- **Parâmetros tipados** (sem SQL/ordenação dinâmica — Codex): `p_uf text`, `p_cnae_prefix text`, `p_cnae_exato text`, `p_status text`, `p_incluir_ja_clientes bool`, `p_data_abertura_min date`, `p_data_abertura_max date`.
- **Retorno** por município: `municipio_codigo, municipio_nome, uf, lat, lng, total, com_telefone, a_contatar`, ordenado `total DESC`. Onde `com_telefone = COUNT(*) FILTER (WHERE telefone1 IS NOT NULL OR telefone2 IS NOT NULL)` e `a_contatar = COUNT(*) FILTER (WHERE prospeccao_status='a_contatar')`.
- **Performance:** GROUP BY com scan; a RLS InitPlan (#792) já evita avaliação por-linha do gate. No front: **debounce** (não a cada tecla) + **cache React Query por conjunto de filtros**. Pior caso medido no PG17 = sem filtro (Brasil 526k) / só UF (MG 64k). Se o caso sem-filtro passar de ~1s, **materializa** uma tabela-resumo `radar_municipio_resumo` recomputada no `finalize` (follow-up §8) — **não** materializar preventivamente (YAGNI; a maioria dos usos tem UF/CNAE que reduz o scan).
- **Gate:** valida `pode_ver_carteira_completa((SELECT auth.uid()))` **uma vez no início** (`IF NOT ... THEN RAISE`), `SET search_path = public`, `REVOKE ALL FROM anon, public`. Fail-closed.

### 2b. Cadastrar no Omie (Oben) — edge `omie-sync` action `radar_cadastrar_cliente`

Reusa o caminho comprovado do **`criar_cliente_afiacao`** (omie-sync:779), que já: busca o CNPJ via `ListarClientes` **antes** de criar (reconciliação — existe? devolve `codigo_cliente_omie`, `created:false`); monta o cliente com `codigo_cliente_integracao` determinístico, razão/fantasia/cnpj/endereço/telefone; trata "cliente já cadastrado".

A action nova:
- Recebe `{ cnpj }`. **Lê os dados do lead de `radar_empresas` server-side** (não confia no client — anti-spoof do payload Omie).
- **Uma conta: Oben** (`OMIE_OBEN_APP_KEY/SECRET`, padrão `getOmieAccounts`). `ListarClientes(cnpj)` → existe? reconcilia (usa o código retornado). Senão `IncluirCliente`.
- **Persistência** (migration): `ALTER radar_empresas ADD omie_codigo_cliente text` + `omie_cadastrado_em timestamptz`. Em sucesso/já-existia: grava o código + timestamp, marca `prospeccao_status='virou_cliente'` + `ja_cliente=true`, loga em `radar_contatos` (ação `virou_cliente`, nota "Cadastrado no Omie/Oben (cód. X)" ou "já existia"). ⚠️ **NÃO** grava em `omie_clientes` (essa tabela é por `user_id`; o lead não tem conta no app — o vínculo do Radar é por CNPJ).
- **Idempotência forte:** re-clicar é seguro (o `ListarClientes`-first intercepta e reconcilia em vez de duplicar). `codigo_cliente_integracao` determinístico (`RADAR_<cnpj>` — não timestamp, pra não criar PV-de-integração novo a cada clique).
- **Gate:** o front chama a RPC `radar_cadastrar_omie(cnpj)` `SECURITY DEFINER` gestor/master, que invoca a edge com service-role (mesmo padrão das ações que cruzam pro Omie). A RPC valida o gate 1× e repassa; a edge confia no service-role. (Alternativa — edge valida JWT master direto — decidir no plano pelo menor atrito; preferência: RPC definer, consistente com o resto do Radar.)
- **Money-path:** `IncluirCliente` escreve no ERP (cadastro, não pedido). Risco menor que disparo de compra, mas ainda escreve → **review adversarial + idempotência por `ListarClientes`-first**.

### 2c. Atribuir Tarefa — RPC `radar_atribuir_tarefa(cnpj, dias_retomada?)`

`SECURITY DEFINER` gestor/master. Cria 1 linha em `tarefas` (tabela do PR #545, em prod):
- `assigned_to = auth.uid()` (founder/gestor que clicou — "vai pra mim"); `created_by = auth.uid()`.
- `customer_user_id = NULL` (lead não tem profile — coluna nullable, confirmado na spec da Fatia 1).
- `categoria` = valor que o CHECK aceitar (confirmar no plano; default `'outro'`).
- `empresa = 'oben'` (a conta comercial do Radar).
- `descricao` pré-preenchida: `"Prospecção: <razão/fantasia> · <cidade/UF> · <telefone>"`.
- `modo` data fixa com backstop: `due_date = now() + (dias_retomada ?? 7)` dias. **Sem auto-satisfy** (o matcher casa por cliente, que o lead não tem — honesto; baixa manual).
- **Próxima ação com data (refinamento do Codex):** o `RadarOutcomeMenu` (Fatia 2), ao registrar `em_conversa` ou `contatado_sem_resposta`, oferece "lembrar de retomar em N dias" → chama esta RPC com `dias_retomada`. Sem isso o Radar é lista de descoberta, não processo comercial. (Implementação mínima: o botão "Criar tarefa" aceita o N; a oferta pós-outcome é o mesmo caminho.)
- Dedupe curto (advisory lock + 2min) anti duplo-clique, como `registrar_contato_radar`.
- Disponível a qualquer momento (não exige cadastro Omie prévio).

### 2d. Contatabilidade — filtro "com telefone" + WhatsApp

- **Filtro/badge "com telefone"** na lista: `telefone1 IS NOT NULL OR telefone2 IS NOT NULL`. No PostgREST = `.or('telefone1.not.is.null,telefone2.not.is.null')` — positivo (linha sem telefone simplesmente não casa o OR; sem o footgun NULL-blind da negação, lição #702). O contador `com_telefone` já vem da RPC de contagem (2a).
- **Botão WhatsApp** no Sheet: `https://wa.me/55<numero>` quando o número **parecer celular** (helper puro decide celular×fixo, reusa/espelha `src/lib/phone.ts`). Fixo → só `tel:`. (ligar/email/Maps já existem no Sheet desde a Fatia 2.)
- **Otimização da lista (Codex):** `useRadarLista` hoje faz `select('*')`. Trocar por **campos resumidos** (cnpj, razão/fantasia, cnae, município/uf, status, ja_cliente, flags `tem_telefone/tem_email` derivadas) na LISTA; telefone/email/sócios completos **só no detalhe** (Sheet faz um fetch por CNPJ). Reduz payload sobre centenas de milhares.

### 2e. Mapa — componente `RadarMapa` (Leaflet lazy)

- Lê a **mesma RPC `radar_contagem_por_municipio`** (filtros ativos) → bolhas por cidade.
- Espelha `AdminRoutePlanner`: `import L from 'leaflet'` + css; `L.map` + tileLayer OSM + `L.layerGroup`; pin por cidade via `L.divIcon` (círculo com a contagem `n`, tamanho/cor escalando com `n`); `bindPopup` nome+n; **clique no pin → seta o filtro `municipio`** (sincroniza com a lista).
- **Toggle Lista | Mapa** na página (estado em `useUrlState`). Endereço individual do lead abre via link Google Maps (Fatia 2) — sem geocodificação por endereço.

---

## 3. UI (adições à página `/radar` + `RadarDetailSheet`)

- **Ranking de cidades** ("onde caçar"): painel/card no topo da lista (top-N cidades por `total`/`a_contatar` dos filtros ativos, da RPC 2a), cada linha clicável → filtra a lista+mapa pra aquela cidade. É a materialização do "totalizador" pedido.
- **Totalizador no header da lista:** "N empresas · M com telefone" do filtro atual (somatório da RPC de contagem) + selo **"lote YYYY-MM"** visível (Codex: o lag mensal tem que aparecer).
- **Toggle Lista | Mapa.**
- **Sheet** (detalhe), abaixo de "Registrar contato": botões **"Cadastrar no Omie (Oben)"** (resultado ✓/já-existia/erro honesto; marca virou_cliente) e **"Criar tarefa pra mim"** (campo opcional de N dias). Botão **WhatsApp** ao lado de ligar/email/Maps. Todos **desabilitados na lente "Ver como"** (o write-guard já bloqueia na fonte; é só UX honesta).
- Padrões do repo: `PageSkeleton`, `EmptyState tone="operational"`, `text-status-*`, telemetria `track('radar.*')` (`radar.lead_cadastrado_omie`, `radar.tarefa_criada`, `radar.cidade_selecionada`, `radar.mapa_aberto`).

---

## 4. Validação

- **PG17** (`db/test-radar-fatia3.sh`, base `verify-snapshot-replay.sh`): `radar_contagem_por_municipio` (agrega por código+UF certo, respeita cada filtro, gate nega não-gestor, REVOKE anon, **mede o caso sem-filtro** e o só-UF → decide se materializa); `radar_atribuir_tarefa` (cria tarefa `assigned_to=caller`, `customer_user_id NULL`, gate, dedupe); `radar_cadastrar_omie` (gate, idempotência do marca-virou_cliente); colunas novas existem.
- **Helpers puros TDD**: payload Omie do lead (razão/fantasia/cnpj/endereço/telefone → `IncluirCliente`) + interpretação do resultado (criado/já-existia/erro → virou_cliente?); celular×fixo (WhatsApp); descrição da tarefa; seleção de campos resumidos da lista. Espelhados verbatim na edge.
- **Edge:** `deno check`; lógica do cadastro com reconciliação testada via helper puro (chamada Omie real mockada; smoke real com o founder).
- **UI:** testes de unidade dos helpers; smoke no device (headless não renderiza a SPA).

---

## 5. Entrega (1 PR; subagent-driven, two-stage review por task)

1. **Migration** (`20260613xxxxxx_radar_fatia3.sql`, manual): `ALTER radar_empresas ADD omie_codigo_cliente text, omie_cadastrado_em timestamptz` + RPCs `radar_contagem_por_municipio` / `radar_atribuir_tarefa` / `radar_cadastrar_omie` + PG17.
2. **Helpers puros TDD** (payload Omie + interpretação + celular×fixo + descrição tarefa).
3. **Edge** `omie-sync` action `radar_cadastrar_cliente` (+ deploy manual pós-merge via chat Lovable).
4. **Hooks** (`useRadarContagemMunicipios`, `useRadarCadastrarOmie`, `useRadarAtribuirTarefa`) + ajuste do `useRadarLista` (campos resumidos + filtro com-telefone).
5. **UI:** ranking de cidades + totalizador/selo-lote no header + toggle Lista|Mapa + `RadarMapa` + 2 botões no Sheet + WhatsApp.
6. **CI** (typecheck strict + test + lint + build) + PR + **rollout** (migration manual no SQL Editor + deploy edge + Publish + smoke no device).

---

## 6. Riscos / decisões a fechar no plano

- **Performance do agregado sem-filtro** — medir no PG17; materializar só se >~1s (decisão data-driven, não preventiva).
- **Gate do cadastro Omie** — RPC definer→edge service-role (preferido) vs edge valida JWT master. Escolher o de menor atrito.
- **CHECK de `categoria`/`empresa` em `tarefas`** — confirmar valores aceitos no plano (`empresa='oben'`, `categoria='outro'` ou um valor de prospecção se o CHECK permitir).
- **`omie_codigo_cliente`** guarda o vínculo; reconciliação futura = re-clicar (idempotente).
- **Qualidade RFB exibida honesta** (Codex): porte `00` = "não informado" (não "grande"), capital social ≠ faturamento, telefone pode ser do contador — a UI rotula, não promete; campo vazio = "—".

---

## 7. Não-objetivos da Fatia 3 (cortes conscientes)

- Cadastrar nas 3 contas Omie (founder cortou — só Oben).
- Preset "rota de amanhã" (cortado — entrega ≠ visita; reposicionado em §8).
- Disparar pedido/compra no Omie (só cadastro de cliente).
- Atribuir tarefa escolhendo a vendedora (v1 = sempre founder; seletor é v2).
- Geocodificação por endereço / pin exato por empresa (link Maps cobre).
- Materializar a tabela-resumo de municípios preventivamente (só se o PG17/prod provar lentidão).
- Editar/desfazer o cadastro Omie pela UI (reconciliação = re-clicar; correção no Omie).

---

## 8. Follow-ups registrados (pós-Fatia 3, priorizados pelo uso real)

**Fatia 4 candidatos (valem sem depender de uso):**
- **Opt-out estruturado** + motivos de descarte ricos (LGPD: legítimo interesse B2B pede opt-out simples e respeitado; suprime novas abordagens). O descarte-com-motivo já existe (Fatia 2); o incremento é o vocabulário estruturado + a supressão.
- **Sugestão de abordagem por CNAE** — mapa determinístico `CNAE → linha de produto + argumento de venda` (curadoria simples supera IA genérica — Codex). Precisa do founder curar os argumentos uma vez.

**Gatilhados pelo uso (faço quando o founder sentir a dor):**
- **Preset rota reposicionado** — não "carona na visita do founder" (entrega ≠ visita), e sim "prospects da cidade da rota de amanhã → **Tarefa de ligação** pra vendedora" (a vendedora já liga pros clientes daquelas cidades via `/rota/ligacoes`). Avaliar depois que o ranking de cidades rodar algumas semanas.
- **Agrupar matriz/filiais por raiz do CNPJ** — só importa se elas confundirem a lista na prática.

**v2 distante:**
- **CNAE secundários** (~640k, coluna `match_via`) — só se os 526k via CNAE principal esgotarem (Codex + eu cortamos por ruído).
- **Materializar `radar_municipio_resumo`** se o agregado ao vivo doer.
- **LGPD formal:** teste de balanceamento, aviso de privacidade, identificação no 1º contato (o Codex recomenda; não bloqueia a v1, que é triagem interna sem disparo em massa). Não substitui validação jurídica.
