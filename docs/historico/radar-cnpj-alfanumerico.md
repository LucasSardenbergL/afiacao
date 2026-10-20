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
- **ALTO (preexistente, fora desta entrega) — `radar_registrar_cadastro_omie` aceita código nulo/inventado:** o gate prova autorização do gestor, não existência no ERP; a transição `ja_cliente` deveria depender de confirmação produzida pelo servidor (conta Omie + CNPJ + código). Registrado como follow-up, não atacado aqui (desenho de fluxo, não o guard).
- **ALTO (preexistente, #3180) — `documentoParaCadastro("ABC12345678909") → "12345678909"`:** letras ANTES do 1º dígito são tratadas como rótulo (`CPF: …`), por desenho do #3180; a lib nova barra esse caso para o Radar (`documentoCadastravelNoOmie`), mas outros chamadores da edge seguem expostos. Follow-up: gramática explícita de rótulo (`CPF:`/`CNPJ:`).
- **MÉDIO — `cliente:null` da sonda não distingue "Não existem registros" de resposta sem array/código:** aceito; a sonda prova "sem fault de validação", não a semântica do filtro — por isso a conferência de identidade acima é obrigatória, e a unicidade por documento no Omie é configurável (não medida). **MÉDIO — sabotagens faltantes:** curinga, não-gestor com CNPJ inválido e deriva de atributo entraram (acima); "falha na 3ª função → rollback integral" fica coberto por A6d (estado idêntico após 3 abortos). A checagem textual `position(guard IN prosrc)` da PÓS é redundante com o md5 — mantida como defesa em profundidade, sem assert próprio.

### (B) `criar_cliente` alfanumérico no Omie — bloqueio da lib cai (com evidência)

- **Evidência 1 — documentação oficial:** o cronograma do Omie ([CNPJ alfanumérico: cronograma de atualizações](https://ajuda.omie.com.br/pt-BR/articles/13941990-cnpj-alfanumerico-cronograma-de-atualizacoes), atualizado 30/07/2026) lista "10/04/2026: Possibilidade de preenchimento do CNPJ alfanumérico nos métodos da API: **IncluirCliente**, AlterarCliente, ConsultarRestricao, IncluirNotaEnt, AlterarNotaEnt, IncluirPedido e AlterarPedidoVenda" e "07/05/2026: ajuste de todos os campos e sub-campos de CNPJ do Módulo de Vendas e NF-e". A referência de `clientes_cadastro.cnpj_cpf` segue `string20` sem citar o formato. `ListarClientes`/`ConsultarCliente` **não** são citados.
- **Evidência 2 — medida (2026-10-20):** sonda **read-only** da action `buscar_cliente` (que é o lookup anti-duplicata do `criar_cliente`: `ListarClientes` com `clientesFiltro.cnpj_cpf`) com o exemplo oficial da RFB `12ABC34501DE35`, pelo caminho do cron (`net.http_post` + `x-cron-secret` do vault; `net._http_response` id 124059): **HTTP 200 `{"success":true,"cliente":null}`** — o filtro aceita letras sem fault de validação e não acha registro (esperado: o exemplo não é cliente). Transiente teria virado erro (`throwOnTransient`), então o `null` é o ramo "Não existem registros". **Nenhum cadastro foi feito** (nunca cadastrar lead real para testar).
- **Edge `omie-vendas-sync`:** já preservava letras desde a v1.20 (#3180, `documentoParaCadastro` em `_shared/cnpj-alfanumerico.ts`): o comentário do bloqueio na lib ("a edge removeria as letras") estava **desatualizado**. O diff da edge nesta entrega é só a conferência de identidade do lookup (Codex ALTO, acima) → **v1.22** (`sonda:bump` + `sonda:fingerprint --write`).
- **Deploy da edge v1.22 (2026-10-20 15:26Z, pela sessão via MCP):** `pendencias:deploy` acusava só `omie-vendas-sync` (DIVERGE_P1, ar v1.21); pacote `64cf7b9931b2` @ `20327ce79`, exit 0. O agente conferiu **29/29 sha256**, chamou `deploy_edge_functions` e fechou com `No files were edited.` (2,4 créditos; só **reportou** 2 TS2304 em `src/sw/releases.ts:133`). Sonda pelo relé (`db/2026-10-20-sonda-rele-omie-vendas-sync-v1.22.sql`, request 124428): **HTTP 200 `versao` v1.22, `fonte` `11b664bf…`** = o esperado da main → `pendencias:deploy` **exit 0, CONFERE**. **Sensor de edição deu `EDICAO_DETECTADA` — falso positivo:** a resposta trazia `edit_id`/`commit_sha` (`8c8b1204f`), mas os 2 commits do bot desde o envio (`774820a23`, `8c8b1204f`) tocam **só** `types.ts` (+4 linhas: `radar_ingest_state.avisado_em` e `radar_avisar_lote`, schema já em prod de outra sessão) e as tool calls do agente foram só `sha256sum -c`, o deploy e um `curl` 401. Nada revertido: reverter o `types.ts` desfaria tipo legítimo. A regra do sensor (`sinais.length > 0` ⇒ edição) não distingue o `commit_sha` da regeneração tolerada. **Deploy redundante na fila:** a sessão de deploy da leva do #3201 enviou a MESMA colagem às 15:28:19Z (`umsg_01m5cyv01redwrgra0dvspkfpx`), que ficou parada na fila pausada do Lovable; se destravada, vira 2º deploy idêntico — cancelar no editor.
- **Lib `src/lib/radar/cadastro-omie.ts`:** o bloqueio `^[0-9]{14}$` vira `documentoCadastravelNoOmie` = numérico de 14 dígitos (como sempre, sem conferir DV — o Omie confere) **ou** CNPJ alfanumérico válido (`ehCnpjAlfanumerico`: formato RFB + DV mod-11). Letra fora disso (DV errado, minúscula, 13 posições, `123ABC45678909` que viraria CPF de outra pessoa após o `\D`) falha **alto** na etapa `omie`, antes da edge. Testes: alfanumérico válido vai à edge intacto e grava no Radar com as letras; 4 variantes inválidas barradas.
- **O que NÃO está medido:** `IncluirCliente` com um alfanumérico **real** (0 no acervo hoje). O sensor é o primeiro cadastro real — "quando medir" é query, não recado: `SELECT cnpj, omie_codigo_cliente, omie_cadastrado_em FROM radar_empresas WHERE cnpj ~ '[A-Z]' AND omie_codigo_cliente IS NOT NULL` (psql-ro). Se o Omie recusar, o erro volta como `FALHA_OMIE` na etapa `omie` e o lead **fica na fila** (precisão > recall).

### Lições

- **`$'` em string de substituição do JS é padrão especial** (insere o sufixo do match): o teste de falsificação do gate com `.replace(x, "… '^[0-9]{14}$'")` saía **INDETERMINADO** (código 2) em vez de reprovar (1) — e um `toBe(1)` pegou. Replace com função (`() => "…"`) quando o texto novo tem `$`.
- **Comentário `--` depois da linha engole a vírgula do VALUES**: marcador de md5 na migration vai em `/* … */` inline.
- **Apply manual perde comentários:** função em PROD pode diferir do repo só em `--` — pré-flight por md5 pega; a PRE aceita os dois md5 em vez de "corrigir" o repo.
- **Sonda read-only pelo caminho do cron** (`net.http_post` + segredo do vault) mede uma API de terceiro sem segredo no chat e sem cadastrar nada — serve quando a documentação cala sobre o método que o money-path chama de verdade (aqui o `ListarClientes` do lookup anti-duplicata).
