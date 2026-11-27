# Crédito-IA PR 8 — painel de crédito (`/credito/painel`) — 2026-11-25

Fecha o programa crédito-IA (plano `docs/superpowers/plans/2026-11-20-credito-ia.md`, linha 48). É só leitura, para gestor e master.

## O que entrega
- **RPC `credito_painel_resumo(p_dias int default 90)`** (migration `20261125120000_credito_painel_leitura.sql`).
  - É `SECURITY DEFINER` e devolve 1 jsonb. A agregação toda acontece no SQL, porque o PostgREST corta em 1.000 linhas, inclusive no `.rpc()`.
  - Gate: `pode_ver_carteira_completa(auth.uid())`, o mesmo predicado da policy das tabelas `credito_*`. Quem não passa recebe 42501.
  - ACL por allowlist: só `authenticated` executa. anon, service_role, PUBLIC e `sandbox_exec*` ficam de fora, e uma postcondição na migration confere isso.
- **Tela `/credito/painel`** (`src/pages/CreditoPainel.tsx`, módulo `vendas` no manifesto).
  - Período fica na URL (`useUrlState`, opções 30/90/180/365 d).
  - Usa `PageSkeleton` e `EmptyState`. 42501 aparece como "Sem acesso".
- **Sensor de uso:** `navegacao.rota_servida` com a chave `/credito/painel` no ledger (`analytics_outbox`). Já é gravado pelo `PageViewTracker`, então não precisou de máquina nova. A leitura com denominador está em `db/sensor-credito-painel.sql`. Há também um `track('credito.painel_aberto')` como conveniência.

## Definições (premissas do founder)
- **Grupo** = a raiz de `credito_grupo_raiz(company, código)`, do PR 2, somando Oben, Colacor e Colacor SC.
  - Par que não resolve vai para "não consolidados", separado por motivo (`sem_grupo` ou `grupo_conflito`). Nunca é encaixado num grupo adivinhado.
  - Grupo que tem par na Colacor SC leva o selo **parcial SC**: a SC não tem pedido no app, então só existem títulos, sem trânsito e sem decisões.
- **Exposição** = títulos abertos, no vocabulário do núcleo do gate (OPEN_TITLE_STATUSES + PAGTO PARCIAL), mais as reservas ativas *efetivas*.
  - A reserva só é medida depois que o gate efetivo grava a 1ª decisão (PR 6). Antes disso vem `null`, nunca 0.
  - Título sem saldo entra na contagem de indeterminados e o valor aparece como "≥".
- **Liberado que atrasou** = pedido criado no app (`created_by` preenchido) que chegou ao Omie e que tem título derivado vencido há mais de 15 dias (data civil em SP, spec §5.8), sem baixa.
  - "Sem baixa" quer dizer: status diferente de RECEBIDO/CANCELADO e, além disso, PAGTO PARCIAL ou nenhuma baixa inferida em `v_titulo_baixas` com `tipo='CR'`.
  - A taxa é atrasados ÷ maturados. Sem pedido maturado, a taxa é `null`.

## Lições (pegas em prod ou na falsificação)
- **O pedido do app grava o PV com zeros à esquerda** (`000000000010520`); o título e o gêmeo importado gravam `10520`. Com o join cru, os 20 pedidos do app casaram **0 títulos**. A correção compara `ltrim(…,'0')`. Junto veio outra regra: o pedido do app continua `enviado` para sempre, e o estado real fica no **gêmeo** (`gemeo_importado_id`). Se o gêmeo foi cancelado no Omie, o pedido não conta como liberado.
- **`v_titulo_baixas.tipo` vale `CR`/`CP`, não `E`/`S`.** Conferi em prod antes de escrever o filtro.
- **`CREATE OR REPLACE` preserva o ACL da função já existente.** Na falsificação, a sabotagem do fecho de ACL ficou VERDE porque a reinstalação herdava o ACL fechado da instalação anterior. Corrigi o harness: cada variante começa com `DROP FUNCTION`, como na 1ª aplicação em prod.
- **`claude_ro` não executa `credito_grupo_raiz` nem `pode_ver_carteira_completa`** (estão fechadas por desenho). Medir em prod exigiu replicar a lógica em SQL. Também não dá para criar nem função `pg_temp` em sessão read-only.

## Deploy (2026-11-26)
- **Migration APLICADA**: `bun run db:aplicar` a partir da main (merge `e9f28f6b3` do #4190) → tentativa **#1443** `aplicada`, sha256 `2cd06b1c…` (= o do último ensaio).
- **2ª testemunha (psql-ro, por fora):** `credito_painel_resumo(integer)` é `SECURITY DEFINER` · `STABLE` · `search_path=public`; ACL `{postgres=X, authenticated=X}` — anon ✗, service_role ✗, authenticated ✓; **md5 do corpo em prod = md5 do corpo no repo** (`afae4546…`).
- **Publish: pendente (founder).** Sem ele `/credito/painel` não existe no app. Depois do Publish, o 1º sinal de uso é `db/sensor-credito-painel.sql`.
- Sombra: a view `credito_sombra_pv_atual` (PR 5) **ainda não está em prod** no momento do apply → o bloco mostra "PR 5 não aplicado" até ela entrar; acende sozinho depois.

## Estado em prod na entrega (psql-ro 2026-11-25)
- 246 grupos com título aberto e R$ 881,7 mil em aberto. Os 329 pares resolveram para grupo, e 51 grupos têm par na Colacor SC.
- `venda_bloqueio_credito_log` tem **0 linhas** no histórico inteiro, e `credito_decisao_pedido`, `credito_limite` e `credito_solicitacao` também estão em 0. Os blocos de limites, reservas, sombra, fila e gate v2 aparecem como "sem dado ainda".
- Pedidos criados no app são poucos: 27 em 365 d, quase todos de abril. O bloco de liberados já tem sinal real (o PV 10710 tem título ATRASADO sem baixa), mas o denominador ainda é pequeno.

## Pendências
- **Sombra (PR 5, #4192):** a sombra NÃO grava em `credito_decisao_pedido` (P0 do Codex: não tocar o gate efetivo); o estado atual por PV fica em `public.credito_sombra_pv_atual` (faixa, motivo, …). O bloco já está **plugado por SQL dinâmico**: sem a view → "PR 5 não aplicado"; com ela → distribuição faixa × motivo; forma diferente (coluna/permissão) → só o bloco degrada para "sem dado" + motivo, o painel segue. Quando o PR 5 for aplicado, o bloco acende sozinho — sem follow-up. Distribuição só de `NOT carga_inicial` (orientação do dono do PR 5) + **concordância gate v2 × piso atual** (`faixa` × `(piso->>'bloqueado')::boolean`; piso sem a chave = NULL, não "liberou").
- ~~**Concordância IA × regra**~~ → **feito em 2026-11-26** (seção abaixo).
- **Sombra em prod (2026-11-26):** a view existe; 100 decisões, todas `carga_inicial` → o bloco mostra 0 PVs (zero medido) até chegarem pedidos.

Prova: `db/test-credito-painel-leitura.sh` roda em PG17 com as migrations reais do PR 1/2, nos dois locales. Tem 9 sabotagens, controle verde e restauração verde na mesma invocação.

## Concordância IA × regra ao vivo (2026-11-26, migration `20261126180000`)

A 5b (#4214) entregou o backtest como SQL re-rodável (`db/backtest-credito-ia-regra.sql`) e o PR 4 gravou propostas da IA em prod (501 `pendente`). A migration leva para a RPC as seções **risco da IA**, **IA × piso de hoje** e **prospectivo**; o resto do corpo é byte a byte o de `20261125120000`.

- **IA** = proposta mais recente do grupo, fora a redução automática (`aplicada_auto_reducao`). `ia_restringe` = limite 0 ou risco alto/sem evidência. Prospectivo = 1ª proposta (coorte fixa).
- **Safra** = CR de venda (1.01.*) com vencimento em (hoje − período, hoje − 15]. Em dia = baixa ≤ venc + 5; "> 15 d" = ainda aberto ou baixa > venc + 15. Sem desfecho sai da conta e é contado.
- **Concordância com o piso** = grupos em que a IA restringe e o piso de hoje (`ficha.piso_estado`) bloqueia, ou ambos liberam. Ficha sem piso = fora da comparação, contada; sem comparável, % = null.
- **In-sample:** a ficha já viu essas baixas — é coerência, não predição. O out-of-time é o prospectivo, que começa vazio.
- Diferença do arquivo da 5b: o grupo vem da função canônica `credito_grupo_raiz` (não da réplica do psql-ro) e o piso é o de **hoje** da ficha (a reconstrução em T fica só no arquivo).
- **Guarda de drift:** a migration aborta se o corpo em prod não for o de `20261125120000` (md5 `afae4546…`) nem já o novo.

Prova: o mesmo harness, agora aplicando a cadeia base + nova. 64 asserts no controle e 21 sabotagens vermelhas, nos dois locales. A sabotagem do REVOKE da migration nova ficava **verde**: o `CREATE OR REPLACE` preserva o ACL da base, então o REVOKE é redundante por desenho. Ela foi trocada por um GRANT a mais, que a postcondição recusa.

**Aplicado em prod (2026-11-26):** `db:aplicar` a partir da main (`799104c8f`, #4233), tentativa **#1488** `aplicada`, com o mesmo sha256 do ensaio (`3ef7439b…`). A guarda de drift passou. 2ª testemunha pelo psql-ro: md5 do corpo em prod = md5 do repo (`1df6581f…`), marca `painel-concordancia-ia-v2` presente, SECURITY DEFINER, STABLE, `search_path=public`, ACL `{postgres, authenticated}` (anon ✗, service_role ✗). Falta o Publish para a tela nova aparecer.

## Nome do grupo pela fonte certa (2026-11-26, migration `20261127100000`)

Conferindo a tela em prod depois do Publish, a exposição mostrava os grupos **sem nome**. O PR 8 lia `fin_contas_receber.nome_cliente`, que vem **vazio do sync em 1.208/1.208 títulos abertos** (psql-ro). A fonte nova é `profiles` da **raiz** do grupo (`razao_social`, senão `name`), o mesmo COALESCE das RPCs de crédito; os 16.107 donos do mapa têm nome. Nos bloqueios recentes, o nome é o do dono do par, e par com 2 donos fica `null` (não adivinha).

**Lição:** coluna de texto "nome" em espelho do Omie pode existir e vir sempre `''`. `count(col)` conta string vazia; meça `count(*) FILTER (WHERE col <> '')` antes de escolher a fonte.

**Aplicado em prod (2026-11-26):** `db:aplicar` a partir da main (`64e9f65e0`, que contém o #4249), tentativa **#1514** `aplicada`, sha256 `f0238527…`. 2ª testemunha pelo psql-ro: md5 do corpo em prod = md5 do repo (`c16e8f1b…`), marca `painel-nome-grupo-v3` presente, SECURITY DEFINER, `search_path=public`, ACL `{postgres, authenticated}` (anon ✗, service_role ✗). O nome chega pela RPC com o front atual; o Publish só troca o texto do fallback.
