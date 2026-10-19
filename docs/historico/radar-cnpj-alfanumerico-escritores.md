# Radar: os ESCRITORES das fontes de cliente preservam o CNPJ alfanumérico (2026-10-19)

> Continuação do [radar-cnpj-alfanumerico.md](radar-cnpj-alfanumerico.md) (#3175). Lá o Radar passou a
> ACEITAR o CNPJ alfanumérico da RFB (jul/2026) de ponta a ponta — inclusive o `radar_recruzar_ja_cliente()`
> com uma chave `alnum` que não apaga letra. Aqui se fecha o achado ALTO do Codex naquele PR: **as fontes
> que o recruzar lê eram escritas por código que apagava as letras antes de gravar.**

## O achado (desenho, não bug de tabela)

O recruzar cruza `radar_empresas.cnpj` com `profiles.document ∪ omie_clientes_nao_vinculados.cnpj_cpf`.
Os dois escritores dessas colunas faziam `.replace(/\D/g, "")` antes do insert — `12ABC34501DE35` virava
`123450135` (9 dígitos) e nunca mais casava com nada: nem com o lead do Radar (14 posições), nem com o
`doc_to_user` da identidade Omie (exige ≥11 dígitos), nem consigo mesmo entre fontes.

**O zero medido na tabela não provava zero na origem.** Medido em prod via `psql-ro` (2026-10-19):

| fonte | len 11 | len 14 | outro | com letra |
| --- | ---: | ---: | ---: | ---: |
| `omie_clientes_nao_vinculados.cnpj_cpf` | 79 | 10.085 | 0 | 0 |
| `profiles.document` | 692 | 4.975 | 1 (len 18, máscara) | 0 |

Compatível com "ainda não chegou nenhum" **e** com "chegou e foi mutilado" — indistinguíveis pela tabela.
Só o escritor decide; por isso a correção é nele.

## O que mudou

**Helper compartilhado** `supabase/functions/_shared/cnpj-alfanumerico.ts` (espelho de `radar-ingest/cnpj.ts`
e `src/lib/radar/normalizar.ts`; o teste fixa o exemplo oficial 12.ABC.345/01DE-35 como oráculo):

- `normalizarDocumento(bruto)` — `alnum = trim + upper + remove [-./]`; se tem letra **e** é CNPJ válido
  (regex `^[0-9A-Z]{12}[0-9]{2}$` + DV mod-11 ASCII−48) → devolve `alnum`. **Qualquer outra coisa → o mesmo
  `.replace(/\D/g, "")` de sempre**, byte-idêntico: CPF, CNPJ numérico, com máscara, com rótulo "CPF:", DV
  numérico errado, lixo. O numérico não muda um byte — e o helper é o mesmo nos DOIS lados de toda
  comparação doc-Omie × doc-profile, para que o alfanumérico case consigo mesmo.
- `documentoParaCadastro(bruto)` — para `IncluirCliente` no Omie. O ramo `pessoa_fisica = len <= 11` dos
  chamadores cadastraria `12ABC34501DE36` (letra, DV errado) como "CPF" de 9 dígitos. Letra sem CNPJ
  alfanumérico válido e sem 11/14 dígitos → **lança** ("cadastro recusado"); numérico segue igual.
- Espelha o `upper()` do SQL (o `radar-ingest` do #3175 descarta minúscula no dump da RFB — ali é fonte
  oficial, caixa fixa; aqui é documento digitado por humano/ERP, e o recruzar já sobe a caixa).

**5 edges, bump de `VERSAO` em cada uma**, só nos `.replace(/\D/g,"")` de DOCUMENTO (CEP, CNAE e termo de
busca ficam como estão):

| edge | VERSAO | pontos |
| --- | --- | --- |
| `omie-analytics-sync` | v1.12 | **único escritor** de `cnpj_cpf` (L85) + os 3 lados de comparação Omie×profile (registrosOmieDoc, classifyClienteForSnapshot, fetchAllProfileDocs) |
| `omie-cliente` | v1.2 | **escritor de `profiles.document`** (criar_perfil_local, sync_all_clients) + gate 11/14 de `buscarClientePorDocumento` + maps por doc + filtro Omie + `consultarCNPJ` |
| `omie-vendas-sync` | v1.20 | lookups no Omie por documento, `docToUserMap`, `deriveOmieAccountIdentity`; `criar_cliente` → `documentoParaCadastro` |
| `omie-sync` | v1.5 | gate/doc de profile, lookup, `criar_cliente_afiacao` → `documentoParaCadastro` |
| `analyze-unified-order` | v1.8 | comparação `cDoc === rDoc` dos dois lados |

**Canária `doc_ambiguo_probe` bumpada** para `doc-ambiguo-mutilacao-alfanumerica-v2` (o gate `canaria:bump`
reprovou o `v1`: a tabela-verdade mudou e um bundle velho responderia `ok:true` mentindo). Ganhou os fixtures
`alfanumerico_mutilacao_de_outro` (velho: ∅) e `alfanumerico_sem_gemeo`; espelho em `omie-doc-ambiguo.test.ts`,
tabela de `deploy.md` §Canárias e `edge-money-path-invariants`.

**Prova de 2 pontas com o MESMO literal** (`12ABC34501DE35`):

- Deno `_shared/cnpj-alfanumerico_test.ts` (9 testes): o escritor emite esse byte para o exemplo oficial;
  o só-dígitos antigo emitia `123450135`; numérico é byte-idêntico em 13 casos.
- SQL PG17 `db/test-radar-recruzar-origem-omie.sh` (9 asserts, 2 sabotagens): semeia o byte MUTILADO em
  `omie_clientes_nao_vinculados` → recruzar marca 0 (**B1 = o bug**); semeia o PRESERVADO → marca 1 e o lead
  vira `ja_cliente` (B2); minúsculo com máscara no profile também marca, com a linha Omie removida antes
  (B2c — a 1ª versão deixava a linha e a sabotagem `sem_upper` ficava VERDE: cenário mascarado por semente
  anterior; a falsificação pegou); numérico segue marcando (B3). `--falsificar`: `alnum_so_digitos` → B2a
  vermelho; `sem_upper_nao_afeta_escritor` → B2c vermelho (e B2a verde: o escritor não depende do upper).
  ⚠️ Depende da migration `20261019110000` (#3175) estar na main — entra em `db/nucleo-ci.txt` junto.

## Codex (desenho + código, gpt-6-astra high, 199 s) — o que mudou por causa dele

- **ALTO (corrigido):** preservar letra de UM lado abre uma colisão com o lado que ainda mutila. O snapshot SQL
  `omie_sync_identity_snapshot` chaveia o profile por só-dígitos (`AEG12345678909` → `12345678909`, 11 dígitos,
  passa no `>=11`). Se na mesma conta Omie existem A (`AEG12345678909`, código 10) e B (`12345678909`, código 20),
  antes os dois tinham a MESMA chave mutilada → ambíguos → ninguém vinculava; depois as chaves divergem e
  **B casaria com o profile de A** (código 20 → user A). Fix: `docsComCodigoAmbiguoNoOmie` (bloco MIRROR,
  edge + `src/lib/omie/omie-doc-ambiguo.ts`) marca como ambíguo o doc numérico que é a mutilação de um
  alfanumérico presente no mesmo run — restaura o fail-closed que a preservação removia. Teste no espelho.
  O caso em que A NÃO está no Omie (só o profile é alfanumérico) é pré-existente ao PR e só fecha com a RPC
  SQL deixando de mutilar — follow-up 1 abaixo.
- **MÉDIO (corrigido):** `documentoParaCadastro` aceitava `123ABC45678909` (CNPJ inválido) porque sobravam 11
  dígitos → cadastraria o CPF `12345678909` de OUTRA pessoa. Regra nova: letra só é tolerada como RÓTULO antes
  do 1º dígito ("CPF: 123…"); letra depois do 1º dígito só passa se o todo for CNPJ alfanumérico válido.
- **MÉDIO (follow-up de front, antecipado na card):** `Profile.tsx` apaga letras ao salvar MESMO sem editar o
  documento (carrega, `.replace(/\D/g,'')`, grava) — destruiria o que a edge preservou. O espelho
  `src/lib/omie/cnpj-alfanumerico.ts` já existe para isso.
- **BAIXO (corrigido):** o espelho de teste `src/lib/clientes-nao-vinculados/snapshot.ts` seguia só-dígitos e
  os testes dele deixavam de cobrir o implantado — agora delega ao espelho.
- Confirmou: numérico byte-idêntico; CHECK `evidence_document_normalized` inalcançável por letra; Omie
  rejeitando letra não piora o lookup (vazio hoje também); sem ordem obrigatória de deploy.

## O que fica de FORA (follow-ups explícitos, não esquecimento)

1. **Identidade Omie por documento** — a RPC `omie_sync_identity_snapshot` monta `doc_to_user` com
   `regexp_replace(document,'\D')` + `length>=11`, e `omie_customer_account_map.evidence_document_normalized`
   tem CHECK `^[0-9]{11,}$`. O vínculo automático de um cliente alfanumérico já era impossível (os dois lados
   mutilavam; 9 < 11) e continua impossível, mas agora **honesto**: o doc preservado não está no mapa →
   `unlinked` → vai para `omie_clientes_nao_vinculados` COM letras (o objetivo deste PR). O write do
   `evidence_document_normalized` só acontece após `userByDoc.get(doc)` casar, e o mapa só tem dígitos ≥11 →
   o CHECK é inalcançável por doc com letra. Abrir o vínculo = migration (RPC + CHECK) — entrega própria.
2. **Front** — `Auth.tsx`/`Profile.tsx` gravam `profiles.document` com strip; `authSchemas.formatDocument`
   (máscara de input) apaga letra a cada tecla — ninguém consegue nem DIGITAR; gates `>=11` em
   `useCustomerSelection`/`useUnifiedOrder`. Precisa de um espelho do helper em `src/lib/` — PR de front.
3. **Grupos de clientes / Caça** — `cliente_grupo_documentos.documento` CHECK `^[0-9]+$` e as views
   `v_grupo_*`/`v_caca_*` casam por só-dígitos: alfanumérico não entra em grupo. Migration própria.
4. **Aceite do Omie** — não provamos que `ListarClientes clientesFiltro.cnpj_cpf` e `IncluirCliente` aceitam
   letra. Se o Omie exigir só-dígitos, o lookup devolve vazio — **como hoje** (9 dígitos também não acha
   ninguém); não piora. A 1ª atestação de deploy destas edges é o lugar de medir.
5. **Deploy — FEITO pela sessão (2026-10-19 14:46Z)**: pacote `4c48919bab24` (5 edges, 22 RPCs de
   pré-condição verdes, `origin/main@29d9a80c4`) colado verbatim via MCP do Lovable; 55/55 hashes conferidos,
   5× **Active**, `No files were edited.`, 2,7 créditos. Sensor pós-envio: `EDICAO_DETECTADA` **só** pelo
   sinal `edit_id`/`commit_sha` da resposta — o commit do bot (`d6813764c`) ficou na branch `lovable-sync-*`,
   toca apenas `src/integrations/supabase/types.ts` (+1, o regenerado tolerado) e há 0 commits do bot na
   `main` desde o envio. **1ª atestação pelo envelope** (`db:aplicar`, ensaio + real): relé
   `deploy_sonda_disparar` para `omie-analytics-sync`/`omie-vendas-sync` (tentativa #556) e disparo legado
   `sonda:sql --so-disparo` para `analyze-unified-order`/`omie-cliente`/`omie-sync` (tentativa #557, passo 2
   lido no `psql-ro`): **3× DEPLOY CONFIRMADO** (versão + fonte batendo) e `pendencias:deploy` mostra as 5
   em "✅ confere" (`visto há 2 min via sonda`). Sem ordem obrigatória entre elas (o cruzamento
   Omie×profile da `omie-analytics-sync` é intra-bundle). Arquivos: `db/2026-10-19-sonda-*-cnpj-alfanumerico-*.sql`.

## Lições

- **Zero na tabela ≠ zero na origem** quando o escritor normaliza: antes de "medir que não existe", leia o
  escritor. Irmão do "ausente ≠ zero" do money-path, na fronteira de escrita.
- **Preservar letra só é seguro com os dois lados da comparação no mesmo helper** — trocar um lado deixa o
  outro casando por acidente no valor mutilado (hoje `123450135 === 123450135`) e depois não casando mais.
- **Semente de cenário anterior mascara sabotagem**: a falsificação acusou um assert que ficava verde pelo
  motivo errado. Limpar o que o cenário anterior semeou faz parte do assert.
