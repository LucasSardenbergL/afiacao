# Front deixa de mutilar CNPJ alfanumérico (Profile · Auth/Signup · máscara · gates dos hooks de pedido)

> Follow-up 2 de [radar-cnpj-alfanumerico-escritores.md](radar-cnpj-alfanumerico-escritores.md) (#3180), que por sua vez
> fechou o achado ALTO do Codex no [radar-cnpj-alfanumerico.md](radar-cnpj-alfanumerico.md) (#3175). Banco e edges já
> aceitavam e PRESERVAVAM o CNPJ alfanumérico da RFB (jul/2026: 12 × `[0-9A-Z]` + 2 DVs mod-11); o front ainda
> destruía — e, pior, destruía **sem o usuário mexer no campo**.

## O achado (4 pontos, 1 deles destrutivo em silêncio)

1. **`Profile.tsx` regravava `profiles.document` em TODO salvar** — carregava o valor do banco, fazia
   `.replace(/\D/g, '')` e mandava no `update`, mesmo quando o usuário só trocou o telefone. Um cliente com
   `12ABC34501DE35` preservado pela edge (#3180) perderia as letras na primeira edição de qualquer outro campo:
   `12ABC34501DE35` → `123450135` (9 dígitos, documento de ninguém). Sem toast, sem log.
2. **`authSchemas.formatDocument` (máscara de input do signup) apagava letra a cada tecla** — ninguém conseguia nem
   DIGITAR um CNPJ alfanumérico; o que chegava ao `documentSchema` já era só-dígitos.
3. **`Auth.tsx` gravava o signup com strip** (`formData.document.replace(/\D/g, '')`); `SignupForm.tsx` consultava
   duplicidade em `profiles` e decidia PF/PJ ("Razão Social" + "Nome Fantasia") pela **contagem de dígitos**.
4. **Gates `docClean.length >= 11` em `useCustomerSelection`/`useUnifiedOrder`** casavam `profiles.document` por
   só-dígitos: o alfanumérico tem 14 chars mas 9 dígitos → nunca casava → o pedido caía no `criar_perfil_local`
   (perfil duplicado) em vez de achar o cliente já cadastrado.

## O que mudou (PR deste doc)

- **Helper novo `src/lib/omie/documento-cliente.ts`** (módulo `plataforma`, importável por todos), tudo derivado de
  `normalizarDocumento` do espelho [`cnpj-alfanumerico.ts`](../../src/lib/omie/cnpj-alfanumerico.ts) — que fica
  **intocado**, porque é espelho byte-a-byte do `_shared/` da edge:
  - `chaveDocumentoParaBusca(doc)` — a chave que casa `profiles.document`; `>= 11` sobre o **normalizado** (o
    alfanumérico válido tem 14 chars, passa; o inválido vira dígitos e cai como antes). Era o `>= 11` sobre dígitos.
  - `documentoEditadoParaGravar(editado, original)` — `undefined` quando o campo **não foi editado** (não entra no
    `update`), senão normalizado ou `null` se esvaziado.
  - `ehDocumentoPessoaJuridica(doc)` — o `> 11` do rótulo do signup, sobre o normalizado.
- **`Profile.tsx`** guarda `documentoOriginal` ao entrar em edição e só põe `document` no `update` quando
  `editDocument !== original`. Efeito colateral deliberado: um documento numérico guardado COM máscara também deixa
  de ser "normalizado de graça" ao salvar outro campo — regravar o que não se editou era o bug, não a feature.
- **`authSchemas`**: `formatDocument` só entra no ramo alfanumérico se há LETRA na entrada (upper + máscara de CNPJ
  `XX.XXX.XXX/XXXX-DD`, DVs só dígitos, 14 chars no máximo); **sem letra, é o código antigo, byte-idêntico** — o teste
  carrega uma CÓPIA do `formatDocument` anterior como oráculo e compara tecla a tecla CPF/CNPJ com e sem pontuação.
  `documentSchema` ganhou um `refine`: letra ⇒ `ehCnpjAlfanumerico(normalizarDocumento(v))`, mensagem própria
  "CNPJ alfanumérico inválido"; numérico segue `min(11)/max(18)` sem DV, como sempre. `123ABC45678909` (sobram 11
  dígitos) é **rejeitado**, não vira o CPF de outra pessoa — o mesmo MÉDIO que o Codex pegou no `documentoParaCadastro`.
- **`Auth.tsx`/`SignupForm.tsx`/hooks**: trocas 1:1 pelos helpers acima (diff de ~20 linhas de produto).
- **Testes (vitest, `bun run test`)**: `documento-cliente.test.ts` e `authSchemas.test.ts` (comportamento: numérico
  inalterado × alfanumérico preservado × inválido fail-closed, oráculo RFB `12.ABC.345/01DE-35`) +
  `src/__tests__/documento-alfanumerico-front.test.ts` (guard textual: cada um dos 5 arquivos importa e CHAMA o helper,
  e o `.replace(/\D/g, '')` sobre documento / o `docClean.length >= 11` não voltaram). Vermelho observado antes do
  código (17 falhas + módulo inexistente), verde depois.

## O que fica de FORA (follow-ups explícitos, mapeados pelo subagente — não esquecimento)

- **Grupos de clientes / Caça**: `useClienteGrupos.normalizarDocumento` + `documentoValido` (11 ou 14 dígitos) e
  `AddDocumentoDialog` espelham o CHECK SQL `^[0-9]+$` de `cliente_grupo_documentos` — mexer no front sem a migration
  só troca a mensagem de erro de lugar. É o follow-up 3 do #3180 (migration própria).
- **Classificação PF/PJ por `length === 14`** em `Customer360.tsx` e `useCustomerDashboard.ts` (alfanumérico vira "PF"
  na exibição; não grava nada). Trivial com `chaveDocumentoParaBusca(...)?.length === 14`, mas é exibição — fora do
  recorte "parar de destruir".
- **Outros lookups por só-dígitos**: `useUtiContas.normDoc`, `useSalesOnlyRestriction` (chave de restrição por CPF —
  CPF nunca tem letra, inócuo), `AdminApprovals.tryLinkOmie`, `orcamento-entidade-helpers.cnpjValido` (homônimo do
  helper novo, rejeita alfanumérico), `IntelligenceUtiTab` (busca). `useBuscaClienteOmie` e `FarmerCalls` já fazem
  `OR` com o documento CRU — casam o alfanumérico mesmo mutilando a cópia.
- **Trade-off aceito na máscara**: colar `CPF: 123.456.789-09` (rótulo com letras) antes "funcionava" porque o strip
  comia o rótulo; agora cai no ramo alfanumérico e o schema rejeita com mensagem clara. Precisão > recall: a RFB
  permite letra em QUALQUER uma das 12 posições, então "letra antes do 1º dígito é rótulo" não é heurística segura
  no input (na edge é, porque lá o dado já veio do Omie).
- **Deploy**: é front → **Publish do Lovable** (camada manual, merge ≠ produção — `deploy.md`). Sem edge, sem
  migration. Verificação pós-Publish: abrir `/auth`, digitar `12abc34501de35` no passo do documento e ver a máscara
  `12.ABC.345/01DE-35` ficar (antes: sumia a cada letra).

## Resíduos fechados em #PR_RESIDUOS (classificação/busca por CONTAGEM DE DÍGITOS)

Os pontos listados acima como "fora" que ainda classificavam ou buscavam documento por `replace(/\D/g,'').length`
— e por isso tratavam um CNPJ alfanumérico VÁLIDO como PF ou não o encontravam. Tudo sobre o mesmo
`normalizarDocumento` (espelho intocado); numérico byte-idêntico; inválido = comportamento antigo (fail-closed).

| Ponto | Antes | Agora |
|---|---|---|
| `Customer360.isPj` · `useCustomerDashboard.displayName` | `length === 14` (alnum = PF, perdia a razão social) | `ehCnpjDocumento` (helper novo em `documento-cliente.ts`); `displayName` virou `nomeExibicaoCliente` exportado e testado |
| `useUtiContas.normDoc` | `>= 11` dígitos → alnum sem chave → inadimplência `null` | `chaveDocumentoParaBusca` — título Omie ↔ perfil casam com as letras |
| `AdminApprovals.tryLinkOmie` | strip → 9 dígitos → `not_found` no `buscar_por_documento` | `documentoParaBuscarNoOmie` (helper novo); vazio → `no_data` como antes |
| `orcamento-entidade-helpers.cnpjValido` | rejeitava alnum → entidade agregada pelo NOME (`sem_id: true`) | `normalizarDocumento`; válido agrega na chave com letras. **Money-path** (drill de variância do orçamento, só a CHAVE de agregação muda, nunca o valor): teste RED antes do código = falsificação (`money-path.md`) |
| `FarmerCalls` · `useBuscaClienteOmie` | `OR(strip, cru)` — o cru mascarado não casa o `profiles.document` normalizado | `OR(normalizarDocumento, cru)` (1 linha cada) |

**Fica de fora (ainda):** grupos de clientes/Caça (CHECK SQL `^[0-9]+$`, follow-up 3 do #3180) e `IntelligenceUtiTab`
(busca por texto, não classifica). Deploy: front → **Publish do Lovable**; verificação: abrir o 360 de um cliente com
CNPJ alfanumérico e ver o herói de PJ (razão social), não o de PF.

## Lições

- **"Carrega → normaliza → grava de volta" é um escritor silencioso.** O formulário de perfil gravava um campo que
  o usuário não tocou, e o `.replace` que parecia higiene era destruição de dado que outro writer (edge) tinha acabado
  de preservar. Teste de regressão barato: o helper devolve `undefined` para "não editado" e o `update` só inclui a
  coluna quando há valor — o campo intocado **não aparece no payload**.
- **"Byte-idêntico para o legado" prova-se com o legado dentro do teste.** Em vez de enumerar casos de CPF/CNPJ à mão,
  o teste carrega uma cópia literal da função antiga e compara a nova contra ela para toda entrada SEM letra, tecla a
  tecla. Quem "melhorar" a máscara numérica no futuro quebra o oráculo de propósito, e o diff mostra que a decisão
  foi consciente.
- **Contagem de dígitos não é comprimento de documento.** Todo `replace(/\D/g,'').length >= N` sobre CPF/CNPJ é um
  gate que o alfanumérico atravessa só se N couber nos dígitos que sobraram — e 12 posições com 5 letras sobram 9. O
  helper centraliza a conta sobre o NORMALIZADO; o grep do guard textual é a sonda para o padrão não voltar.
