# Clientes MEI com CPF em `profiles.name`: medição e mapa (2026-11-10)

Follow-up "Clientes MEI fora do Radar" de [radar-privacidade-pacote-j-2026-11-09.md](radar-privacidade-pacote-j-2026-11-09.md).
O pacote J mascarou o CPF do titular de MEI em `radar_empresas` (lead de prospecção). Este doc cobre o outro domínio:
clientes em `public.profiles`, que vêm do Omie. **Só medição e mapa. Nada foi implementado; a decisão é do founder.**

## Medição (prod, `psql-ro`, 2026-11-10)

Regex: `(?<![0-9])[0-9]{3}[ ./-]{0,3}[0-9]{3}[ ./-]{0,3}[0-9]{3}[ ./-]{0,3}[0-9]{2}(?![0-9])`. Só contagens e formas
(dígitos trocados por 9). Nenhum valor saiu do banco.

| Recorte | Resultado |
|---|---|
| `profiles` com CPF em `name` | **1.888** de 16.085 |
| `profiles.razao_social` com CPF | 0 (a coluna não tem escritor no repo) |
| Dígito verificador de CPF válido | 1.887 de 1.888. É CPF, não celular |
| Igual ao `profiles.document` | 1. Nas outras 1.887, `document` é o CNPJ (14 dígitos) do MEI |
| Papel / tipo | 100% `customer`, `customer_type = domestic`, `is_prospect = false` |
| Origem | 100% `prospect_source = omie_import`, criados em 2026 |
| `is_approved` | 0 aprovados. Hoje nenhum desses titulares entra no portal |
| `venda_items_history.cliente_razao_social` | **685** de 8.027 (cópia da NF, outro escritor) |
| Outras colunas de nome de cliente (`fin_contas_receber`, `cobranca_*`, `picking_tarefas`, `production_orders`, `omie_clientes_nao_vinculados`, `customer_contacts`, `venda_*_log`) | 0 |

Formas do CPF em `name`:

| Forma | Posição | Linhas |
|---|---|---|
| `99999999999` | fim do nome | 1.867 |
| `999.999.999-99` | fim do nome | 20 |
| `99999999999` | meio do nome | 1 |

## Quem escreve

- **Escritor principal:** edge `omie-cliente`, `linhaPerfilPlaceholder`
  (`supabase/functions/omie-cliente/perfil-placeholder.ts:42`). Grava `nome_fantasia || razao_social || "Cliente"` do
  Omie, sem normalizar. Só no INSERT do perfil, nos casos `sync_all_clients` e `criar_perfil_local`. O sync de
  cliente existente só repõe o telefone (`index.ts:1299`), então um backfill não é desfeito pelo sync.
- **Segundo vetor:** o cadastro do próprio cliente. `SignupForm.tsx:99` pré-preenche o nome com a `razao_social` do
  Omie, e `Auth.tsx:106` faz upsert. A tela `Profile.tsx` deixa o cliente regravar o próprio nome.
- **Nenhuma função SQL ou trigger** escreve `profiles.name`. Não existe máscara de CPF em `profiles` hoje.
- `venda_items_history.cliente_razao_social`: só a edge `omie-sync-vendas-items` (`dest.cRazao` da NF).

## Onde aparece

- **Staff (RLS: `master` ou `employee` leem todas as linhas):** cerca de 73 arquivos de `src` leem `profiles`
  (busca/Cmd-K, lista e ficha de cliente, seletor do pedido, separação, rota, dashboards, Farmer, fidelidade, inbox de
  WhatsApp), e cerca de 56 migrations citam `p.name` em RPC ou view. Nenhum `select('*')` em `profiles`. A RPC
  `raio_x_estoque_fatos` expõe a cópia de `venda_items_history` na tela Raio-X.
- **O próprio cliente:** só o próprio nome (`Profile.tsx`, saudação do dashboard). As views `selfservice_*` não
  projetam `name`. Não há caminho em que um cliente veja o nome de outro.
- **Para fora do app:** impressão de pedido e orçamento (`OrderPrintLayout.tsx`, `salesOrders/print.ts`), link
  `wa.me` "Cliente: {nome}" (`whatsappShare.ts`), push à vendedora (`20260610200000_push_vendedora.sql`), e-mail
  mensal ao próprio titular (`monthly-report`), **prompts de LLM** (`generate-tactical-plan`, `analyze-unified-order`,
  copiloto do Farmer), **MCP** (`mcp/index.ts:54`, que devolve `name, document, phone, email`).
- **Omie:** `buildOmieCustomer` manda `razao_social || name` como `razao_social`. O app nunca chama `AlterarCliente`;
  `criar_cliente` só chama `IncluirCliente` quando o documento NÃO existe no Omie, e `exigirRazaoFiscal` já barra a
  razão mascarada. Para estas 1.888 linhas, que vieram do Omie, o cadastro fiscal com CPF continua no próprio ERP.

## Opções levadas ao founder

1. **Mascarar só na exibição.** São cerca de 73 arquivos, 56 SQL, impressões, prompts de LLM e MCP. Cada leitor novo
   vaza de novo. É a opção cara e frágil.
2. **Gravar mascarado na entrada** (padrão do pacote J): trigger BEFORE em `profiles.name` e em
   `venda_items_history.cliente_razao_social` com `private.radar_razao_mascarada`, backfill das 1.888 + 685 linhas e
   tirar o CPF do pré-preenchimento do `SignupForm`. A cópia crua à parte é **opcional** aqui: diferente do Radar, a
   fonte (Omie) guarda a razão fiscal e o app nunca a regrava.
3. **Manter.** A base legal existe (contrato e obrigação fiscal), mas o CPF no nome não serve a nenhuma operação do
   app (`document` já guarda o CNPJ) e vai a prompts de LLM de terceiros, ao MCP e a links de WhatsApp. Isso pesa
   contra a minimização (LGPD art. 6º, III).

Antes de implementar a opção 2, conferir:

- Se algum código casa cliente por `name` = razão do Omie. O escritor casa por código e documento, mas os leitores não
  foram auditados para isso.
- Que a guarda `exigirRazaoFiscal` só reconhece a máscara no FIM. A linha com CPF no meio do nome escaparia dela.

**Decisão:** pendente com o founder (2026-11-10).

## Decisão e implementação (2026-11-10/11)

O founder escolheu a opção 2 (gravar mascarado). O PR `claude/clientes-mei-cpf-mascarado`, aberto como DRAFT, contém:

- a migration `20261113090000`, com triggers, backfill, PRE e PÓS;
- `_shared/razao-fiscal.ts`, com a guarda ampliada para qualquer posição e com separadores;
- a guarda nova no `criar_cliente_afiacao`;
- o pré-cadastro do `omie-cliente` sem o CPF;
- a prova `db/test-clientes-mei-cpf-mascarado.sh` (15 asserts; 7 de 7 sabotagens vermelhas em `C` e em `pt_BR`).

O Codex ficou indisponível (cota, rc=75). A revisão adversarial do Fable não pediu a cópia crua, mas achou bloqueios:

- **A1 (ALTO).** Com o perfil mascarado, o autocadastro numa conta sem código (1.115 MEI sem código `colacor`) recebe a recusa da guarda. O front engole o erro: só olha `res.data?.codigo_cliente`, e o `invoke` não rejeita. Assim o pedido trava com "provável falha temporária do Omie". **A migration não deve ser aplicada antes de corrigir isso.**
- **M1.** A busca ao vivo no Omie (`listar_clientes`, respostas da `omie-cliente`) ainda leva a razão crua à impressão e ao e-mail "Novo Pedido".
- **M2.** A PRE não confere se as edges novas já estão no ar.
- **M3.** `private.customer_metrics_mv.razao_social` só se renova no cron de 6 h.

### Correção dos achados (2026-11-11, decisão do founder: "a edge busca a razão")

- **A1:** no `IncluirCliente`, a razão mascarada vira a razão FISCAL do mesmo documento noutra conta Omie
  (`razaoFiscalParaCadastro` em `_shared/razao-fiscal.ts`).
  - A `omie-vendas-sync` consulta a outra conta, oben ↔ colacor, com o lookup estrito.
  - A `omie-sync` consulta a Oben e depois a Colacor; a `callOmieApi` ganhou a conta como parâmetro, com padrão
    Colacor SC.
  - Falha de leitura sobe, nunca vira "não existe". Sem conta com o documento → `RAZAO_MASCARADA`.
  - A guarda saiu de antes do lookup na `omie-vendas-sync` (corrige o B2).
  - Resíduo: nesse último caso o front ainda engole o erro. Pela medição, nenhum dos 1.888 está nele, porque todos
    têm código em alguma conta.
- **M2:** a PRE exige `omie-sync v1.11` e `omie-vendas-sync v1.34` em `deploy_atestacoes`.
- **M3:** a migration chama `refresh_customer_metrics()` depois do `COMMIT`.
- **Prova:** 18 asserts; `--falsificar` dá 9 de 9 sabotagens vermelhas em `C` e em `pt_BR`.
- **Fica para depois:** M1 (a razão crua da busca ao vivo no Omie ainda chega à impressão e ao e-mail do pedido) e
  B5 (`fin_movimentacoes.descricao`).


### Desfecho (2026-11-11, decisão do founder: "Seguir com E+F")

- **F, o front** ([#3812](https://github.com/LucasSardenbergL/afiacao/pull/3812), mergeado às 12:37Z): o autocadastro
  não engole mais o erro. O `supabase.functions.invoke` não rejeita em erro de edge: a `omie-vendas-sync` devolve
  500 `{error}` e a `omie-sync`, 200 `{success:false}`.
  - `desfechoAutoCadastro` classifica a resposta e o hook mostra o motivo real num `toast.error`, só se a seleção
    ainda for a corrente.
  - Com `RAZAO_MASCARADA`, o vendedor é orientado a selecionar o cliente pela busca (que consulta o Omie) ou a
    cadastrá-lo no Omie com a razão completa.
  - 20 testes, 6 sabotagens vermelhas.
  - Codex: "sem achados de regressão money-path". O MÉDIO foi corrigido: com `OMIE_LOOKUP_AMBIGUO` o cliente já
    existe, então o texto diz "até o app confirmar um código válido", não "até o cadastro existir".
- **E, as edges:** pacote `6090e6405577`, de `origin/main@191faa11`, enviado pelo MCP às 11:01:43Z. O agente do Lovable
  conferiu 45/45 hashes, deixou as 3 funções Active e respondeu `No files were edited.`.
  - O sensor deu `EDICAO_DETECTADA` só pelo `edit_id`. O `get_diff` mostra apenas o `types.ts` regenerado, que é
    tolerado (`db0339c0e`), então não houve revert.
  - A 1ª atestação foi pelo envelope:
    - `db:aplicar` #1070, disparo direto de `omie-cliente` e `omie-sync`: 2× DEPLOY CONFIRMADO pelo `psql-ro`;
    - #1072, relé `deploy_sonda_disparar` para a `omie-vendas-sync`.
  - O colhedor gravou as 3 em `deploy_atestacoes` (11:33–11:34Z) e o `pendencias:deploy` saiu 0.
  - Arquivos: `db/2026-11-11-sonda-*-razao-fiscal-*.sql`.
- **Migration `20261113090000`:** o founder colou no SQL Editor depois das atestações. Validação pelo `psql-ro`:
  - **0** CPF em `profiles.name` e **0** em `venda_items_history.cliente_razao_social`;
  - os 2 triggers ligados;
  - 1.888 e 687 linhas mascaradas;
  - nenhuma linha de prova vazou;
  - as funções de trigger não são executáveis por `anon`/`authenticated`.
- **Publish do #3812:** o pré-requisito está verde (`pendencias:deploy` 0, `deriva:corpo:prod` 0, workspace em
  `5a0e0f1af` ⊇ #3812). O `deploy_project` pela sessão foi recusado pelo classificador de permissão do modo
  automático (deploy de produção), então o Publish ficou com o founder. Antes dele, o bundle era
  `index-CYAPg7i9.js`.
- **Segue em aberto:** M1 (a razão crua da busca ao vivo no Omie chega à impressão do pedido e ao e-mail
  "Novo Pedido") e B5 (`fin_movimentacoes.descricao`).
