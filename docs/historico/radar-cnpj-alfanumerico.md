# Radar: CNPJ alfanumérico de ponta a ponta (RFB, desde jul/2026)

> PR: #3175 (2026-10-19). Bloco seguinte ao #3169 (carga mensal automática + recruzamento diário). Origem: P0 do parecer Codex de desenho do #3169, fora daquele bloco.

## O problema

A Receita Federal emite **CNPJ alfanumérico** desde julho/2026: 12 posições `[0-9A-Z]` + 2 dígitos verificadores (DV por módulo 11 sobre o valor `ASCII − 48` de cada caractere — dígito vale o próprio valor, `A..Z` valem 17..42; pesos `5,4,3,2,9,8,7,6,5,4,3,2` e `6,5,4,3,2,9,8,7,6,5,4,3,2`; resto < 2 → 0, senão 11 − resto). Exemplo oficial: `12.ABC.345/01DE-35`. Para CNPJ só-numérico a regra coincide com a clássica.

O Radar inteiro assumia `^[0-9]{14}$`, em quatro camadas que não se cobriam:

| Camada | Antes | Efeito com CNPJ alfanumérico |
|---|---|---|
| `montarCnpj` (`src/lib/radar/normalizar.ts`, usado por `scripts/radar/carga.ts`) | `^\d{1,8}$` etc. | linha do dump descartada com `continue` mudo |
| edge `radar-ingest` action `chunk` | `CNPJ_RE = /^\d{14}$/` + `console.warn` | linha descartada em silêncio (contador agregado, sem motivo) |
| CHECK `radar_empresas.cnpj` | `~ '^[0-9]{14}$'` | insert rejeitado (nunca chegaria — as camadas acima já descartam) |
| `radar_recruzar_ja_cliente()` | `regexp_replace(doc,'[^0-9]','','g')` + `length = 14` | cliente alfanumérico **nunca** vira `ja_cliente` |

## Medido em prod ANTES de escrever (psql-ro, 2026-10-19)

| Fonte | documentos | com letra | 14 dígitos |
|---|---|---|---|
| `profiles.document` | 5.668 | **0** | 4.976 |
| `omie_clientes_nao_vinculados.cnpj_cpf` | 10.164 | **0** | 10.085 |
| `radar_empresas.cnpj` | 526.176 | **0** | 526.176 |

E **0 de 526.176** CNPJs do radar falham o módulo 11 — validar DV também nos numéricos não descarta ninguém do acervo. Mudança **preventiva**: nenhum dado existente muda de estado.

⚠️ **O zero não prova ausência na origem** (achado ALTO do Codex): os escritores das duas fontes de cliente removem `\D` antes de gravar (`omie-analytics-sync` em `cnpj_cpf`; `omie-vendas-sync` e o import de `profiles.document`). Um cliente alfanumérico hoje chegaria ao banco **sem as letras** — e o recruzamento novo não recupera o que já foi apagado. Fica como follow-up (abaixo), com o recruzamento já preparado para o dia em que os escritores preservarem o documento.

## O que mudou

1. **`normalizar.ts`** (TDD): `CNPJ_RE = /^[0-9A-Z]{12}[0-9]{2}$/`, `dvCnpj`, `cnpjValido`; `montarCnpj` aceita `[0-9A-Z]` nos componentes básico/ordem, exige DV numérico e **valida o DV para todos** (fail-closed: minúscula, caractere fora do alfabeto ou DV errado → `null`). O oráculo externo dos testes é o exemplo oficial da RFB. Consumidores do módulo trocaram o regex local por `CNPJ_RE`: `lote-persistido` (parse do localStorage) e `formatarCnpj` (a máscara `00.000.000/0000-00` vale igual para letras).
2. **Edge `radar-ingest`** (`v1.0-sonda` → `v1.1-cnpj-alfanumerico`): módulo `cnpj.ts` próprio (Deno não importa `src/`) com teste Deno espelhando o TS; o `chunk` descarta **por motivo** (`cnpj_formato` → `cnpj_dv` → `cnae`) e devolve `descartadas_por_motivo` + `duplicadas_no_chunk` (antes duplicata intra-chunk se misturava a inválida). Fingerprint regravado.
3. **`carga.ts`** conta as rejeições locais por motivo e **soma o retorno dos chunks** (era ignorado), imprimindo `⚠️` antes do finalize quando há qualquer rejeição.
4. **Migration `20261019110000_radar_cnpj_alfanumerico.sql`** (envelope `BEGIN/COMMIT` para SQL Editor/MCP — os objetos são do `postgres`, fora do alcance do `db:aplicar`): CHECK de `radar_empresas.cnpj` recriado só se a definição viva divergir; CHECK novo em `radar_contatos.cnpj` (antes só a FK); `radar_recruzar_ja_cliente()` no molde **TRAVA → PRE (md5 `prosrc` de prod `27ccab8e…`) → CREATE → PÓS**, `REVOKE` nomeando roles + `GRANT EXECUTE TO service_role` explícito. O documento do cliente passa por **duas** normalizações: a antiga (só dígitos — acervo numérico intocado, `"CNPJ: 22.333.444/0001-81"` segue casando) e a nova (`btrim` + `upper` + remove **só** `.`, `-`, `/`). A nova **não apaga letra** e não trata espaço interno como separador: o contraexemplo do Codex `aeg 123.456.789-09` (CPF com anotação) **não** vira a chave `AEG12345678909` por acaso — precisão > recall.
5. **Prova PG17 `db/test-radar-cnpj-alfanumerico.sh`** (no `nucleo-ci.txt`, `23 falsificar=4`): a PRE exige o md5 de PROD do predecessor, então **repo ≠ prod fica vermelho no CI**, não na mão do founder. Sabotagens em espelho, após controle verde na mesma invocação, **uma camada por vez** — a régua de md5 da PRE/PÓS é neutralizada (literal → md5 vivo) nas sabotagens semânticas, senão todo mutante morreria na PÓS sem exercitar o assert funcional (achado 6 do Codex): F1 CHECK aceita minúscula → A1 vermelho; F2 sem `upper()` → "minúsculo com máscara não marca"; F3 caminho alnum vira só-dígitos → "alfanumérico não marca" (numérico segue marcando); F4 corpo sabotado **sem** neutralizar → a PÓS morde.
6. **Bloqueio explícito no cadastro Omie** (`cadastro-omie.ts`): CNPJ fora de `^[0-9]{14}$` falha na etapa `omie` **antes** de chamar a edge — `omie-vendas-sync` (`criar_cliente`) remove `\D` e trataria `12ABC34501DE35` como um CPF de 11 dígitos de **outra** pessoa (achado ALTO do Codex: "follow-up com botões operantes é o veto").

Custo medido do `DROP + ADD CHECK` em 526.176 linhas (PG17 local, mesma regex): **1,08 s** de `ACCESS EXCLUSIVE` — abaixo de qualquer timeout; `NOT VALID` + `VALIDATE` separado (sugestão Codex) não compensa a perda da garantia `convalidated` na PÓS.

## Estado em prod (2026-10-19)

- **Migration APLICADA** pelo envelope MCP (`postgres`), pré-voo colado 🟢 e validada por psql-ro em outra conexão após o COMMIT: `check_empresas_ok=t · check_contatos_ok=t · funcao_ok=t (md5 9163372c…) · acl_ok=t · ja_cliente_total=3001 (inalterado) · provolatile=v`. Evidência no comentário do PR.
- **Edge `radar-ingest` v1.1**: pendente até o deploy pelo chat do Lovable (`bun run pendencias:pacote radar-ingest` após o merge; sonda deve responder `v1.1-cnpj-alfanumerico`). Até lá a edge em prod (`v1.0-sonda`) descarta alfanumérico como hoje — sem regressão.
- **Codex de código**: rodou retroativo (seção abaixo); achados consertados no #3192.

## Codex retroativo de código (PR #3192, 2026-10-19)

A cota voltou e o parecer rodou (448 s, 143k tokens): **sem veto ALTO**; conferiu pesos, slices e zeros do DV contra cálculo independente em 20 mil bases, os hashes de predecessor/corpo e a agregação do contrato novo. Dois MÉDIOs e um BAIXO, consertados no #3192:

- **Anotação com HÍFEN virava chave** (`aeg-123.456.789-09` → `AEG12345678909`, DV válido por coincidência): a 1ª versão removia `.`/`-`/`/` em qualquer posição. Migration `20261019150000_radar_recruzar_mascara_exata.sql` (TRAVA→PRE md5 `9163372c…`→CREATE→PÓS): o caminho alnum só aceita documento **cru** (14 posições) ou com a **máscara nas posições exatas** `00.000.000/0000-00`, e só então remove os separadores. Caminho numérico intocado. Prova: seed `xyz-123.456.789-09` + lead `XYZ12345678909` (assert A2j) e sabotagem `sem_mascara_exata` (`25 falsificar=5`).
- **`carga.ts` com edge antiga**: resposta sem `descartadas_por_motivo` virava zero rejeições. Agora `descartadas` da edge < v1.1 entra como `nao_classificado` — ausente ≠ zero.
- **`--dry-run` escondia as rejeições locais**: o relatório local sai antes do retorno do dry-run.

Revisão independente **cumprida**; o rótulo `REVISÃO INDEPENDENTE PENDENTE` do #3175 cai com este PR. **Migration `20261019150000` APLICADA em prod** (envelope MCP, 2026-10-19) e validada por psql-ro: `funcao_ok=t (md5 3bb62946…) · acl_ok=t · ja_cliente_total=3001 (inalterado) · provolatile=v`.

## Follow-ups (não feitos aqui — cada um é um bloco)

- **Escritores que apagam letras** antes de persistir o documento: `omie-analytics-sync` (`cnpj_cpf: replace(/\D/g,'')`), `omie-vendas-sync` (`documentClean`, `criar_cliente`), import de `profiles.document`, `analyze-unified-order`. Sem isso o recruzamento alfanumérico é **inerte** para clientes vindos do Omie. Exige revisar os consumidores de `cnpj_cpf` que deduplicam por dígitos — domínio `sync.md`.
- ✅ **RPCs do Radar com guard numérico** — fechado na seção "Follow-ups fechados" abaixo (migration 20261019225545 + gate).
- ✅ **`criar_cliente` no Omie para alfanumérico** — fechado na seção "Follow-ups fechados" abaixo (evidência oficial + sonda medida; bloqueio da lib cai).

## Lições

- **Zero na tabela ≠ zero na origem** quando o escritor normaliza: medir a fonte certa é medir o que entra no `INSERT`, não o que sobrou dele.
- **Falsificação de corpo com PÓS por md5 é sempre vermelha** — e por isso não prova a semântica. Neutralize a régua de md5 nas sabotagens semânticas e deixe **uma** sabotagem para provar que a régua morde.
- **Normalizar apagando** (`[^0-9A-Z]`) transforma anotação em chave. Remova só o que é separador conhecido.

## Follow-ups fechados — guard alfanumérico nas 3 RPCs + `criar_cliente` (2026-10-20, PR #3215)

### (A) RPCs do Radar: `registrar_contato_radar` · `radar_atribuir_tarefa` · `radar_registrar_cadastro_omie`

- **O defeito:** o CHECK de `radar_empresas`/`radar_contatos` aceitava `^[0-9A-Z]{12}[0-9]{2}$` desde o #3175, mas as 3 RPCs barravam `p_cnpj` por `^[0-9]{14}$` → para um lead alfanumérico, contato, atribuição de tarefa e registro de cadastro no Omie falhavam **alto** (`cnpj inválido`). Medido em prod: 0 leads alfanuméricos ainda (mudança preventiva).
- **Migration `20261019225545_radar_rpcs_cnpj_alfanumerico.sql`** (envelope BEGIN/COMMIT, objetos do `postgres`): o corpo de cada função é o de **PROD** (`pg_get_functiondef` via psql-ro, 2026-10-19) com **só o guard trocado** para o mesmo regex do CHECK — minúscula, 13 posições e NULL seguem RAISE (fail-closed); o numérico antigo é subconjunto. Molde TRAVA → PRE → CREATE → PÓS; a PÓS exige, além do md5 "este", `SECURITY DEFINER` + `search_path=public` + `VOLATILE` e a **presença do guard novo no `prosrc`** (um corpo que perdeu a validação não passa). REVOKE/GRANT reemitidos nomeando `PUBLIC, anon` / `authenticated, service_role`.
- **Achado do pré-voo:** `registrar_contato_radar` em PROD (md5 `efdd73b6…`) ≠ repo `20260612130000` (md5 `41eb0fdd…`) — diff = **só comentários `--`** (alguém aplicou a função sem eles). A PRE aceita os dois md5 como predecessor; a prova registra (A0p1/A0p1b). Os outros dois batem byte a byte com o repo (`20260929001651` para a tarefa, `20260613190000` para o cadastro).
- **Gate `like-cru-em-migrations-gate`:** a âncora de `VIVOS_PERMITIDOS` para o LIKE do dedupe de `radar_atribuir_tarefa` passa a ser `p_cnpj !~ '^[0-9A-Z]{12}[0-9]{2}$'`; `CONHECIDOS` ganha o sítio da migration nova (baseline 23 → 24) e a entrada da `20260929001651` vira "definição antiga". Teste novo: um corpo vivo que **voltasse** ao guard numérico reprova (`PERMITIDO … a âncora sumiu`) — o gate continua barrando LIKE cru sem a validação a montante.
- **Prova PG17 `db/test-radar-rpcs-cnpj-alfanumerico.sh`** (nucleo-ci, 38 asserts, `falsificar=9`): predecessoras REAIS aplicadas com md5 = PROD; alfanumérico válido passa nas 3 e grava (contato, tarefa com o CNPJ na descrição + dedupe pelo LIKE, cadastro com código/status/contato); minúscula/13 posições/NULL → `cnpj inválido`; alfanumérico válido fora do radar cai no lookup (prova que o guard passou); numérico intocado; ACL nas 3; gate de gestor na frente do guard. Sabotagens (idioma `SABOTAGENS="nome:assert"`, uma por rodada, md5 neutralizado nas semânticas): `guard_numerico_{contato,tarefa,cadastro}` → A1a/A2a/A3a, `guard_aceita_minuscula` → A1c, `sem_search_path` → A0a (PÓS), `corpo_sabotado_md5` → A0a, `pre_sem_atributos` → A6a, `pre_sem_acl` → A6b, `trava_sem_volatilidade` → A6c. Curinga `%`/`_` em cada RPC → RAISE (A1h/A1i/A2f/A3f); não-gestor com CNPJ inválido → forbidden (A5b: o gate precede o guard).
- **Deploy:** aplicada via envelope MCP em 2026-10-20 11:56Z (1ª tentativa `ECONNRESET` sem efeito, provado por psql-ro; 2ª ok), validada por psql-ro: md5 "este" ×3, SECURITY DEFINER, `search_path=public`, VOLATILE, EXECUTE só `authenticated`/`service_role`, guard novo presente

### Codex (desenho `max` 493s · código `max` 428s, 2026-10-20) — achados e o que mudou

- **ALTO (os dois pareceres) — PRE só por md5 do corpo apaga ALTER/REVOKE concorrente:** `ALTER FUNCTION … SECURITY INVOKER` / `SET search_path` / `REVOKE EXECUTE` antes da TRAVA mantêm o `md5(prosrc)`; a PRE aceitava, o `CREATE OR REPLACE` + `GRANT` restauravam os atributos antigos e a PÓS aprovava. **Corrigido:** a TRAVA confere `provolatile = 'v'` ANTES do `ALTER … VOLATILE` (que a normalizaria), e a PRE, já sob a trava, exige `prosecdef`, `proconfig = {search_path=public}` e o ACL revisado (`has_function_privilege`: anon/PUBLIC sem, authenticated/service_role com). Provado em A6a/A6b/A6c (atributo mudado no predecessor → a migration ABORTA e o estado fica intacto, A6d) e falsificado (`pre_sem_atributos`, `pre_sem_acl`, `trava_sem_volatilidade`). Lição de prova: a 1ª versão de `pre_sem_acl` (`IF false AND a OR b OR NOT c`) deixava o ramo de `authenticated` vivo por precedência AND/OR — a falsificação pegou (suíte verde) e a sabotagem foi reescrita para apagar a condição inteira.
- **ALTO (desenho) — o lookup anti-duplicata não confere identidade:** `buscarClienteVendas` aceitava o 1º registro da página sem comparar o `cnpj_cpf` ao pedido; se o Omie casar o filtro parcialmente ou ignorar letras, devolveria OUTRO cliente e o lead sairia da fila com `created:false` e código alheio. **Corrigido na edge `omie-vendas-sync` v1.22** (`lookup-documento.ts` + `_test.ts`, 4 Deno): `criar_cliente` exige `normalizarDocumento(retornado) === docClean` (máscara/minúscula conferem; mutilado, outro doc ou vazio não) — divergência lança `OMIE_LOOKUP_DIVERGENTE` (a action falha, a lib marca etapa `omie`, o lead FICA na fila). O numérico do acervo passa igual (documento idêntico após normalização). Deploy da edge é camada à parte (`pendencias:deploy`).
- ✅ **FECHADO em 2026-10-21 (seção "Follow-up fechado — confirmação do servidor" abaixo).** **ALTO (preexistente, fora desta entrega) — `radar_registrar_cadastro_omie` aceita código nulo/inventado:** o gate prova autorização do gestor, não existência no ERP; a transição `ja_cliente` deveria depender de confirmação produzida pelo servidor (conta Omie + CNPJ + código). Registrado como follow-up, não atacado aqui (desenho de fluxo, não o guard).
- **ALTO (preexistente, #3180) — `documentoParaCadastro("ABC12345678909") → "12345678909"`:** letras ANTES do 1º dígito são tratadas como rótulo (`CPF: …`), por desenho do #3180; a lib nova barra esse caso para o Radar (`documentoCadastravelNoOmie`), mas outros chamadores da edge seguem expostos. Follow-up: gramática explícita de rótulo (`CPF:`/`CNPJ:`). **✅ Fechado em 2026-10-21** — ver "Follow-up fechado — gramática explícita de rótulo" no fim.
- **MÉDIO — `cliente:null` da sonda não distingue "Não existem registros" de resposta sem array/código:** aceito; a sonda prova "sem fault de validação", não a semântica do filtro — por isso a conferência de identidade acima é obrigatória, e a unicidade por documento no Omie é configurável (não medida). **MÉDIO — sabotagens faltantes:** curinga, não-gestor com CNPJ inválido e deriva de atributo entraram (acima); "falha na 3ª função → rollback integral" fica coberto por A6d (estado idêntico após 3 abortos). A checagem textual `position(guard IN prosrc)` da PÓS é redundante com o md5 — mantida como defesa em profundidade, sem assert próprio.

### (B) `criar_cliente` alfanumérico no Omie — bloqueio da lib cai (com evidência)

- **Evidência 1 — documentação oficial:** o cronograma do Omie ([CNPJ alfanumérico: cronograma de atualizações](https://ajuda.omie.com.br/pt-BR/articles/13941990-cnpj-alfanumerico-cronograma-de-atualizacoes), atualizado 30/07/2026) lista "10/04/2026: Possibilidade de preenchimento do CNPJ alfanumérico nos métodos da API: **IncluirCliente**, AlterarCliente, ConsultarRestricao, IncluirNotaEnt, AlterarNotaEnt, IncluirPedido e AlterarPedidoVenda" e "07/05/2026: ajuste de todos os campos e sub-campos de CNPJ do Módulo de Vendas e NF-e". A referência de `clientes_cadastro.cnpj_cpf` segue `string20` sem citar o formato. `ListarClientes`/`ConsultarCliente` **não** são citados.
- **Evidência 2 — medida (2026-10-20):** sonda **read-only** da action `buscar_cliente` (que é o lookup anti-duplicata do `criar_cliente`: `ListarClientes` com `clientesFiltro.cnpj_cpf`) com o exemplo oficial da RFB `12ABC34501DE35`, pelo caminho do cron (`net.http_post` + `x-cron-secret` do vault; `net._http_response` id 124059): **HTTP 200 `{"success":true,"cliente":null}`** — o filtro aceita letras sem fault de validação e não acha registro (esperado: o exemplo não é cliente). Transiente teria virado erro (`throwOnTransient`), então o `null` é o ramo "Não existem registros". **Nenhum cadastro foi feito** (nunca cadastrar lead real para testar).
- **Edge `omie-vendas-sync`:** já preservava letras desde a v1.20 (#3180, `documentoParaCadastro` em `_shared/cnpj-alfanumerico.ts`): o comentário do bloqueio na lib ("a edge removeria as letras") estava **desatualizado**. O diff da edge nesta entrega é só a conferência de identidade do lookup (Codex ALTO, acima) → **v1.22** (`sonda:bump` + `sonda:fingerprint --write`).
- **Deploy da edge v1.22 (2026-10-20 15:26Z, pela sessão via MCP):** `pendencias:deploy` acusava só `omie-vendas-sync` (DIVERGE_P1, ar v1.21); pacote `64cf7b9931b2` @ `20327ce79`, exit 0. O agente conferiu **29/29 sha256**, chamou `deploy_edge_functions` e fechou com `No files were edited.` (2,4 créditos; só **reportou** 2 TS2304 em `src/sw/releases.ts:133`). Sonda pelo relé (`db/2026-10-20-sonda-rele-omie-vendas-sync-v1.22.sql`, request 124428): **HTTP 200 `versao` v1.22, `fonte` `11b664bf…`** = o esperado da main → `pendencias:deploy` **exit 0, CONFERE**. **Sensor de edição deu `EDICAO_DETECTADA` — falso positivo:** a resposta trazia `edit_id`/`commit_sha` (`8c8b1204f`), mas os 2 commits do bot desde o envio (`774820a23`, `8c8b1204f`) tocam **só** `types.ts` (+4 linhas: `radar_ingest_state.avisado_em` e `radar_avisar_lote`, schema já em prod de outra sessão) e as tool calls do agente foram só `sha256sum -c`, o deploy e um `curl` 401. Nada revertido: reverter o `types.ts` desfaria tipo legítimo. A regra do sensor (`sinais.length > 0` ⇒ edição) não distingue o `commit_sha` da regeneração tolerada. **Deploy redundante na fila:** a sessão de deploy da leva do #3201 enviou a MESMA colagem às 15:28:19Z (`umsg_01m5cyv01redwrgra0dvspkfpx`), que ficou parada na fila pausada do Lovable; se destravada, vira 2º deploy idêntico — cancelar no editor.
- **Desfecho da mensagem redundante (medido via `get_message`):** a fila foi destravada e ela rodou às 17:11Z. O agente **abortou** — 28/29 hashes batiam, mas `_shared/sonda-fingerprints.ts` da `main` já tinha mudado desde o `20327ce79` do pacote. Sem deploy, `No files were edited.`, 2 créditos. O `commit_sha` da resposta (`d255802d0`) é de novo só a regeneração do `types.ts`. **O gate de sha256 da colagem segurou o deploy redundante sozinho.** A v1.22 seguiu CONFERE no ledger.
- **Publish do frontend (2026-10-20 20:38Z, pela sessão via MCP):** esperou o merge do #3220 e do #3223, cujas migrations já estavam em prod antes do merge e faziam o `deriva:corpo:prod` sair 1 (3 divergências de Radar). Com os dois na `main`: `deriva:corpo:prod` **exit 0** (392 identidades), `pendencias:deploy` **exit 0**, `latest_commit_sha` = `main` `bbe5e65da`. `deploy_project` com `name: "steu"` → bundle de entrada `index-CldBqbtr.js` → **`index-Cgxz7zng.js`** às 20:47Z, GET 200. Nenhum commit do bot depois. Bytes = disponibilidade, não adoção (PWA).
- **Lib `src/lib/radar/cadastro-omie.ts`:** o bloqueio `^[0-9]{14}$` vira `documentoCadastravelNoOmie` = numérico de 14 dígitos (como sempre, sem conferir DV — o Omie confere) **ou** CNPJ alfanumérico válido (`ehCnpjAlfanumerico`: formato RFB + DV mod-11). Letra fora disso (DV errado, minúscula, 13 posições, `123ABC45678909` que viraria CPF de outra pessoa após o `\D`) falha **alto** na etapa `omie`, antes da edge. Testes: alfanumérico válido vai à edge intacto e grava no Radar com as letras; 4 variantes inválidas barradas.
- **O que NÃO está medido:** `IncluirCliente` com um alfanumérico **real** (0 no acervo hoje). O sensor é o primeiro cadastro real — "quando medir" é query, não recado: `SELECT cnpj, omie_codigo_cliente, omie_cadastrado_em FROM radar_empresas WHERE cnpj ~ '[A-Z]' AND omie_codigo_cliente IS NOT NULL` (psql-ro). Se o Omie recusar, o erro volta como `FALHA_OMIE` na etapa `omie` e o lead **fica na fila** (precisão > recall).

### Lições

- **`$'` em string de substituição do JS é padrão especial** (insere o sufixo do match): o teste de falsificação do gate com `.replace(x, "… '^[0-9]{14}$'")` saía **INDETERMINADO** (código 2) em vez de reprovar (1) — e um `toBe(1)` pegou. Replace com função (`() => "…"`) quando o texto novo tem `$`.
- **Comentário `--` depois da linha engole a vírgula do VALUES**: marcador de md5 na migration vai em `/* … */` inline.
- **Apply manual perde comentários:** função em PROD pode diferir do repo só em `--` — pré-flight por md5 pega; a PRE aceita os dois md5 em vez de "corrigir" o repo.
- **Sonda read-only pelo caminho do cron** (`net.http_post` + segredo do vault) mede uma API de terceiro sem segredo no chat e sem cadastrar nada — serve quando a documentação cala sobre o método que o money-path chama de verdade (aqui o `ListarClientes` do lookup anti-duplicata).

## Follow-up fechado — gramática explícita de rótulo em `documentoParaCadastro` (2026-10-21)

**Achado (Codex ALTO, preexistente do #3180):** a regra "letra só é tolerada como RÓTULO antes do 1º dígito"
era heurística — qualquer letra antes do 1º dígito contava como rótulo, e `ABC12345678909` virava o CPF
`12345678909` de OUTRA pessoa no `IncluirCliente`. A lib do Radar já barrava (`documentoCadastravelNoOmie`);
os outros chamadores da edge, não.

**Chamadores mapeados.** `documentoParaCadastro`: só `omie-sync` (`criar_cliente_afiacao`) e
`omie-vendas-sync` (`criar_cliente`) — os dois chamam ANTES do lookup anti-duplicata, então a recusa barra
também o reaproveitamento. Importam o `_shared` sem chamar `documentoParaCadastro` (comportamento igual,
fingerprint muda): `omie-cliente`, `omie-analytics-sync`, `analyze-unified-order`, `omie-vendas-sync/lookup-documento.ts`.

**Regra nova (`_shared/cnpj-alfanumerico.ts`):** tira no máximo UM rótulo da gramática fechada
`^(CPF|CNPJ)(\s*:\s*|\s+)` (sem caixa); qualquer letra que sobre (`\p{L}`, inclusive acentuada) só passa
se o resto for CNPJ alfanumérico válido — senão lança `DOC_LETRA_FORA_DO_ROTULO`; rótulo que contradiz o
tamanho (CPF ≠ 11, CNPJ ≠ 14) lança `DOC_ROTULO_DIVERGENTE`; sem dígito lança `DOC_SEM_DIGITO` (todas com
"cadastro recusado"). Numérico com máscara e sem rótulo segue byte-idêntico. **Mudou de propósito:**
`documentoParaCadastro("aeg-123.456.789-09")` agora recusa (antes `12345678909`, "CPF anotado") — anotação não
é rótulo. `normalizarDocumento` NÃO mudou: segue chave de comparação (só-dígitos para o que não é alfanumérico
válido).

**Prova:** 17+ testes Deno casando a MARCA do ramo; falsificação com controle verde na mesma invocação, em
`LC_ALL=C` e `pt_BR.UTF-8`: 6 sabotagens (rótulo heurístico antigo · sem checagem de letra · letra só ASCII ·
sem rótulo×tamanho · sem vazio · rótulo case-sensitive) — todas vermelhas. A 1ª rodada achou um atalho
redundante (CNPJ válido inteiro antes do rótulo — nenhum CNPJ casa a gramática) e um caso que não cobria letra
só acentuada; os dois corrigidos.

**Codex de código (`gpt-6-astra` · max · 494s · 133.617 tokens) — 4 achados, todos corrigidos:**
- **ALTO — Unicode sumia no `\D`:** `ⒶⒺⒼ12345678909` (símbolo, fora de `\p{L}`), `００６12345678909` (fullwidth —
  `00612345678909` é CNPJ com DV certo) e `٠٠٦12345678909` viravam o CPF `12345678909`. **Corrigido:** alfabeto
  fechado no corpo ANTES de normalizar (`[0-9A-Za-z./ \t-]`) → `DOC_CARACTERE_FORA_DO_ALFABETO`.
- **ALTO — `toUpperCase()` fabrica posição:** `CNPJ: 12ßC34501DE33` (13 posições) → `12SSC34501DE33`, CNPJ válido.
  Mesmo alfabeto fecha.
- **MÉDIO — vendas consultava o texto cru:** `criar_cliente` chamava `buscarClienteVendas(docCriar)`;
  `CNPJ: AEG12345678909` consultava `12345678909` e cadastrava `AEG12345678909`. **Corrigido:** lookup com `docClean`.
- **ALTO condicionado (preexistente) — afiação reaproveitava sem conferir:** `criar_cliente_afiacao` aceitava o 1º
  registro do `ListarClientes`. **Corrigido:** confere `normalizarDocumento(existing.cnpj_cpf) === docClean`
  (espelho do `lookupDevolveuOMesmoDocumento` de vendas); divergência → `OMIE_LOOKUP_DIVERGENTE`, `success:false`.
- Falsificação refeita: 8 sabotagens (rótulo heurístico · sem letra · sem alfabeto · alfabeto com `\s` Unicode ·
  alfabeto aceitando qualquer não-letra · sem rótulo×tamanho · sem vazio · rótulo case-sensitive), todas
  vermelhas com controle verde, em `LC_ALL=C` e `pt_BR.UTF-8`. 5.668 profiles com documento, 0 fora do alfabeto.

**Edges:** `omie-sync` v1.7-rotulo-documento-explicito · `omie-vendas-sync` v1.23-rotulo-documento-explicito.
Sem pré-condição de banco, sem ordem entre edges.

**Lookups que dão o cliente do PEDIDO também fechados:** `omie-sync buscar_cliente_por_documento` (fora do
`try`, que lia falha como "não existe" → agora 500), o autosserviço de `omie-sync` por `profile.document`
(0 profiles com letra em prod, psql-ro 2026-10-21 — não trava ninguém) e `omie-vendas-sync buscar_cliente`
passam pela mesma gramática: com `normalizarDocumento`, `ABC12345678909` virava o código do cliente de OUTRA
pessoa no pedido. **Fica com `normalizarDocumento` de propósito:** comparação doc-Omie × doc-profile
(`docToUserMap`, `lookup-documento.ts`, `omie-cliente`, `omie-analytics-sync`, `analyze-unified-order`) — chave
dos DOIS lados, não identidade de entrada.

**Deploy — FEITO pela sessão (2026-10-21 11:39Z, PR #3289 mergeado 11:34Z em `5c0ec50`):** o ledger pôs
`omie-sync`/`omie-vendas-sync` em P1 e `omie-cliente`/`omie-analytics-sync`/`analyze-unified-order` em P2 (só
fonte). O pacote trouxe também `omie-sync-nfes-recebidas` (P1, de outra entrega), **tirada da leva**: o
`list_messages` mostrou outra sessão deployando-a às 11:27Z. Colagem do `pendencias:prompt` das 5 via MCP:
56/56 hashes, 5× **Active**, `No files were edited.`, 1,8 crédito. **1ª atestação pelo envelope**
(`db:aplicar`, ensaio + real): relé `deploy_sonda_disparar` para `omie-vendas-sync`/`omie-analytics-sync`
(tentativa #671) e `sonda:sql --so-disparo` para `omie-sync`/`omie-cliente`/`analyze-unified-order`
(#673, passo 2 no `psql-ro`: **3× DEPLOY CONFIRMADO**). `pendencias:deploy`: as 5 em **CONFERE**
(`omie-sync` v1.7, `omie-vendas-sync` v1.23). Sensor pós-envio: `EDICAO_DETECTADA` **só** pelo sinal
`edit_id`/`commit_sha`. Os 2 commits do bot (`aafdc432b`, `b74f4d162`) tocam apenas `types.ts` (+129, tabela
`venda_gerador_execucao` de outra migration), regenerado e tolerado, sem revert. Arquivos:
`db/2026-10-21-sonda-*-rotulo-documento*.sql`.
**Colisão:** o #3291 (confirmação server-side do cadastro) também subia `omie-vendas-sync` para v1.23 e ficou
`DIRTY` depois deste merge. Ele precisa ir a v1.24 sobre a v1.23 daqui, com redeploy próprio.

**Residual — ✅ fechado em 2026-10-21 (`omie-sync` v1.8, `omie-vendas-sync` v1.25):** `buscar_cliente_por_documento`
e `buscar_cliente` aceitavam o 1º registro do `ListarClientes` sem conferir o documento devolvido. Agora os dois
conferem com `lookupDevolveuOMesmoDocumento`, movido de `omie-vendas-sync/` para `_shared/lookup-documento.ts`
e usado pelas duas edges, a afiação inclusive (o inline saiu). Divergência → `OMIE_LOOKUP_DIVERGENTE`:
em vendas, a action falha; em `omie-sync`, o erro é lançado FORA do `try` que lia falha como "não existe" e
vira 500. No front, falha de lookup de código cai no caminho que já existia: código vazio, submit do pedido
fail-closed naquela conta, e `criar_cliente` conferindo de novo. Falsificação do helper: "sempre true" e "sem
guarda de vazio" ficam vermelhas, com controle verde. As duas guardas de vazio eram redundantes entre si: ficou
uma, e o caso dos dois lados vazios ganhou teste. **Codex: barrado pelo guard local de cota (exit 79, 91%,
janela reabre em 27/10) → Caminho B, REVISÃO INDEPENDENTE PENDENTE; Codex retroativo quando a cota voltar.**
**Deploy — FEITO pela sessão (PR #3311 mergeado em `3e757a7`):** o ledger pediu só as 2 edges (P1). O
`list_messages` não mostrou ninguém deployando-as. Colagem do `pendencias:prompt` via MCP: 34/34 hashes, 2×
**Active**, `No files were edited.`, 2,6 créditos. Sonda pelo envelope: relé para `omie-vendas-sync` (#683) e
`--so-disparo` para `omie-sync` (#685, passo 2 no psql-ro: DEPLOY CONFIRMADO). `pendencias:deploy`: **CONFERE**
para `omie-sync` v1.8-busca-confere-documento e `omie-vendas-sync` v1.25-busca-confere-documento.

## Follow-up fechado — `radar_registrar_cadastro_omie` exige confirmação do SERVIDOR (2026-10-21)

- **O defeito (Codex ALTO preexistente, acima):** a RPC marcava `ja_cliente = true` / `virou_cliente` com o `p_codigo_cliente` que o front mandasse — nulo (`COALESCE` com o antigo) ou inventado. O gate só provava que quem chama é gestor.
- **Medido em prod antes (psql-ro):** 0 leads com `omie_codigo_cliente`/`omie_cadastrado_em` (o fluxo nunca foi usado, então não há acervo a reclassificar). Fontes server-side existentes avaliadas e **rejeitadas**: `omie_clientes_nao_vinculados` (snapshot reescrito em lote pelo `omie-analytics-sync`; cliente recém-criado só aparece no próximo sync; multi-writer) e `omie_customer_account_map` (exige user/profile; prospect não tem). Nenhum ledger de confirmação existia → tabela nova justificada.
- **Desenho:** ledger append-only `omie_cliente_confirmacoes` (`account` só `oben`, `documento` só CNPJ no formato do Radar, `codigo_cliente ^[1-9][0-9]{0,18}$`, `origem` `incluir|lookup`, `confirmado_por`), **um escritor**: a edge `omie-vendas-sync` `criar_cliente` (service_role), depois do lookup que conferiu o documento (v1.22) **ou** do `IncluirCliente` que devolveu código. Código nulo (rate-limit) não confirma nada. A RPC exige a linha `(oben, p_cnpj, código)`; ausente → `RAISE 'RADAR_SEM_CONFIRMACAO_OMIE: …'` e o lead **fica na fila**. A nota do contato vem do ledger (houve `incluir` para o par?), não do `p_ja_existia` do front. Repetição com o mesmo código dentro da trava → `deduped`, sem 2º contato. Assinatura preservada (SW em cache ainda manda os 3 parâmetros).
- **Edge v1.24** (`confirmacao-cadastro.ts` + `_test.ts`): INSERT com prazo de 5 s (AbortController); erro/exceção/prazo → `confirmacao_registrada:false`, **sem derrubar a action** (o cliente já existe no Omie; o fluxo Colacor da mesma action não regride). `null` = nada a confirmar.
- **Front** (`cadastro-omie.ts`): a recusa `RADAR_SEM_CONFIRMACAO_OMIE:` vira `FalhaCadastro('omie')` **sem código** — o "Tentar de novo" volta pela edge (lookup grava a confirmação), nunca pelo atalho `codigoConhecido`, que recusaria em laço.
- **Migration `20261021120000_radar_cadastro_omie_confirmacao_servidor.sql`** (envelope BEGIN/COMMIT): TRAVA (volatilidade antes do ALTER) → PRE (md5 de PROD `46717b26…` ou este; SECURITY/search_path/ACL; **ledger preexistente na 1ª instalação aborta** — linhas de procedência desconhecida virariam prova) → CREATE TABLE + RLS + ACL → CREATE OR REPLACE → PÓS (md5 este, atributos, exigência no `prosrc`, dono igual ao da RPC, **forma exata** da tabela — colunas/tipos/NOT NULL, 5 constraints validadas, zero policy — e **ACL efetivo** por `aclexplode`). Os default privileges de prod dão `arwdDxtm` a anon/authenticated/service_role e `ar` aos `sandbox_exec*`: um `GRANT` mínimo por cima não os remove, então a migration revoga a ESCRITA de todo grantee que não é o dono (SELECT do `claude_ro` fica — a sentinela exige "0 objetos sem SELECT").
- **Prova PG17 `db/test-radar-cadastro-omie-confirmacao.sh`** (`nucleo-ci.txt`, `41 falsificar=11`): mundo com os default privileges de prod; predecessoras reais até a 20261019225545 (md5 = PROD). 11 sabotagens, uma camada por vez, cada uma vermelha no assert declarado. A sabotagem do guard de formato do código na RPC ficou **verde** (o CHECK do ledger já barra nulo/vazio/não numérico) → o guard saiu: camada redundante.
- **Ordem de deploy (Codex):** edge **antes** da migration (sem a tabela, o INSERT falha no prazo → `false`, inofensivo); depois a migration; Publish do front por último (a mudança do front só reclassifica o erro).
- **Codex:** desenho `max` 342s · 92.710 tokens — 0 CRÍTICO/ALTO, 4 MÉDIOs incorporados (REVOKE do service_role/defaults; não adotar tabela preexistente; prazo no INSERT; idempotência), mais owner e tabela qualificada.
- **Codex de código:** `max` 257s · 118.550 tokens — os 4 MÉDIOs do desenho **resolvidos**; 0 CRÍTICO/ALTO/MÉDIO novo; 1 BAIXO consertado: o `RadarOutcomeMenu` (oferta pós-sinal) caía no toast genérico sem ação para `RADAR_SEM_CONFIRMACAO_OMIE` → agora aviso com "Tentar de novo" pela edge (`retentativa`), teste no `RadarOutcomeMenu.oferta.test.tsx`.
- **Estado em prod (2026-10-21, PR #3291 → `f4eae81f3`):** as 3 camadas no ar, com evidência. **Edge** `omie-vendas-sync` v1.24-confirmacao-cadastro-servidor (a `main` já tinha a v1.23 do #3289): pacote `358487844f79` via MCP às 12:51:59Z, 30 sha256 conferidos contra `d670fb3f`, ledger **CONFERE**, sensor de edição **SEM_EDICAO**. **Migration** `20261021120000` aplicada pelo envelope MCP (2 tentativas anteriores com `ENOTFOUND`/`ECONNRESET` não chegaram a aplicar nada, conferido por psql-ro entre elas); 2ª testemunha psql-ro: md5 `b537f95a…`, SECURITY DEFINER + `search_path=public` + VOLATILE, dono `postgres`, ACL da RPC intacto, tabela com RLS, 0 policy, escrita só `service_role:INSERT` (`claude_ro`/`sandbox_exec*` só SELECT), `authz:claude-ro:prod` exit 0. **Front**: o build servido `c0b76360` (13:00Z, Publish de outra sessão) contém o merge. Sensor de uso: a 1ª linha do ledger — `SELECT count(*), max(confirmado_em) FROM omie_cliente_confirmacoes` (psql-ro); hoje 0.
- **Fora do escopo (registrado, não atacado):** `registrar_contato_radar(p_acao='virou_cliente')` segue mudando o **status** de prospecção sem confirmação do ERP — é marcação manual de funil, não `ja_cliente`; e a gramática de rótulo de `documentoParaCadastro` (`_shared/cnpj-alfanumerico.ts`) é outra sessão.

## Codex retroativo do #3311 (2026-10-27, `gpt-6-astra` · max · 3219s · 156.653 tokens)

A REVISÃO INDEPENDENTE PENDENTE do #3311 (Caminho B) foi feita. Resultado:

- **ALTO (confirmado e corrigido, `omie-sync` v1.9 / `omie-vendas-sync` v1.26):** o helper normalizava o documento
  DEVOLVIDO com `normalizarDocumento` (só-dígitos). Entrada válida `CPF: 123.456.789-09` com retorno simulado
  `{"codigo_cliente_omie":777,"cnpj_cpf":"123ABC45678909"}` → as duas actions respondiam 200 com `777`. A gramática
  estrita protegia só a ENTRADA. **Correção:** `lookupDevolveuOMesmoDocumento` passa o retorno por
  `documentoParaCadastro` (não-string ou recusa → `false`). Testes: retornos com letra, símbolo e dígito fullwidth não
  casam; retornos válidos (máscara, rótulo, alfanumérico minúsculo) seguem casando. Falsificação com controle verde
  em `LC_ALL=C` e `pt_BR.UTF-8`: só-dígitos, sem `typeof`, `catch → true` ficam vermelhos. A guarda `r.length > 0`
  ficou verde, porque `documentoParaCadastro` já lança sem dígito, e saiu.
- **Confirmado sem regressão:** o 500 fora do `try` preserva CORS e contrato; o consumidor (`getResult`) trata a
  divergência como falha e não chama criação; o caminho novo do helper passa no `deno check` e no `test:edges`.
- **Pré-existentes, fora deste PR (registrados):**
  - `useUnifiedOrder.ts:573` (fluxo IA, Oben) lê `omieResult.codigo_cliente`, mas a action devolve
    `omieResult.cliente.codigo_cliente`. Com isso, até um lookup Oben bem-sucedido vira código `0` e o pedido Oben
    fica bloqueado no submit (falha FECHADA, não código errado).
    **Corrigido (front, só Publish):** helper puro `codigoObenDoBuscarCliente`
    (`src/hooks/unifiedOrder/codigo-oben-busca.ts`) lê `cliente.codigo_cliente`; `error` do invoke (inclusive
    `OMIE_LOOKUP_DIVERGENTE`), `cliente: null`, código plano ou não inteiro positivo → `null`, e o submit segue
    fail-closed. O erro do invoke agora é logado (antes era descartado em silêncio: o `invoke` não lança).
    `codigo_vendedor` ficou `null` (como antes): no `criar_pedido` ele é advisory, porque a edge usa o
    `ident.codigo_vendedor` derivado do documento (`deriveOmieAccountIdentity`). Preencher não muda o PV e só
    mexeria na atribuição do `criar_perfil_local`, fora do escopo. Os outros consumidores conferem: `useCustomerSelection` lê
    `data.cliente.codigo_cliente` (colacor), e `criar_cliente` / `buscar_cliente_por_documento` são planos de fato.
    Teste: helper + amarração (hook usa o helper; edge devolve `{ success, cliente }`). Falsificação com controle
    verde: acesso antigo no helper, acesso antigo no hook e `error` ignorado ficam vermelhos.
  - `omie-sync buscar_cliente_por_documento` lê transitório (503) como `200 / codigo_cliente:null` (falsa ausência).
    O consumidor tenta `criar_cliente_afiacao`, que reconsulta e confere identidade. Duplicação não comprovada.


**Deploy da correção — FEITO pela sessão (PR #3359 mergeado 15:46Z em `75dbcc8`):** colagem do
`pendencias:prompt`, 34/34 hashes, 2× **Active**, `No files were edited.`, 2,6 créditos. Sonda pelo envelope:
relé `omie-vendas-sync` (#729) e `--so-disparo` `omie-sync` (#731, DEPLOY CONFIRMADO). `pendencias:deploy`:
**CONFERE** para `omie-sync` v1.9-retorno-documento-estrito e `omie-vendas-sync` v1.26-retorno-documento-estrito.
Sensor: SEM_EDICAO. **A revisão independente do #3311 está fechada.**

## Busca por documento da Afiação: só o EOF é ausência (2026-10-27, `omie-sync` v1.10)

Fecha o item pré-existente que o Codex retroativo do #3311 deixou: `buscar_cliente_por_documento` transformava
todo erro em `codigo_cliente: null`, então um 503 ou uma credencial recusada viravam "não existe".
`./busca-documento.ts` decide o desfecho das DUAS leituras de `ListarClientes` por documento da edge:

- EOF do Omie ("Não existem registros para a página", `classificarFaultstring` = `fim_de_pagina`) ou página
  vazia → ausência;
- resposta sem `clientes_cadastro` em lista (`{}`, `{"error":…}`, objeto) → `OMIE_RESPOSTA_MALFORMADA`
  (antes: "não existe");
- qualquer outro erro → relança (500 na busca, `success:false` no cadastro).

**Codex (`gpt-6-astra` · max · 209s · 100.979 tokens):** nenhum ALTO nem regressão. O 500 novo não induz
autocadastro: `getResult` marca a falha e o preflight do envio bloqueia o pedido sem código de Afiação. Dois
MÉDIOS pré-existentes, os dois reproduzidos e **corrigidos aqui**:

1. resposta malformada virava ausência;
2. a reconsulta do `criar_cliente_afiacao` recebia o EOF, caía no `catch` e devolvia `success:false`, então
   **cliente realmente novo nunca era cadastrado na Afiação**. Agora o EOF segue para o `IncluirCliente`.

**Prova:** 5 testes Deno do helper, com a chamada injetada, casando a marca do erro. Falsificação: 4
sabotagens vermelhas com controle verde em `LC_ALL=C` e `pt_BR.UTF-8` (sem checagem de lista, EOF engolindo
tudo, sem EOF, classe errada).

**BAIXO registrado:** não há teste de handler; o helper concentra a decisão para que restaurar o `catch`
antigo exija desfazer a chamada a ele.
