# Doc-ambíguo Omie: o laço de "mutilação" sai — mutilação não é ambiguidade (follow-up 3 do #3180, 2026-10-19)

Branch `claude/compassionate-gagarin-57eb11`. Edge `omie-analytics-sync` `v1.12-cnpj-alfanumerico` → **`v1.14-mutilacao-nao-e-ambiguidade`**
(o `v1.13-cnpj-mascara-exata` é do #3199, mesma tarde). Canária `doc_ambiguo_probe`:
`doc-ambiguo-mutilacao-alfanumerica-v2` → **`doc-ambiguo-mutilacao-nao-e-ambiguidade-v3`**. Nenhuma migration.

## Por que o laço nasceu — e por que virou falso-positivo

O [#3180](radar-cnpj-alfanumerico-escritores.md) fez os escritores preservarem a letra do CNPJ alfanumérico, mas o
snapshot SQL (`omie_sync_identity_snapshot`) ainda chaveava o profile por `regexp_replace(document, '\D', '', 'g')`.
Logo um profile `AEG12345678909` virava a chave `12345678909` e o cliente Omie **numérico** `12345678909` (outra
pessoa) casaria com ele. O Codex (ALTO) pediu um fail-closed na edge: `docsComCodigoAmbiguoNoOmie` ganhou um 2º laço
que, para cada doc com letra, marcava como **ambíguo** o doc só-dígitos igual à sua mutilação, se ele existisse no
mesmo run. Fail-closed correto **enquanto** o snapshot mutilava.

O [#3195](omie-identidade-cnpj-alfanumerico.md) corrigiu a causa: o snapshot chaveia por `normalizar_documento()`
(letras preservadas) e o CHECK da evidência aceita alfanumérico. A migration `20261019140000` está **aplicada e
atestada em prod** (2ª testemunha psql-ro, 2026-10-19). O laço foi mantido no #3195 de propósito — edge e migration
sobem por caminhos manuais independentes (`deploy.md`), e com a migration ausente o laço era a única defesa.

Com a migration no ar, o laço inverteu de sinal: `AEG12345678909` e `12345678909` são **chaves distintas de donos
distintos** no `doc_to_user`. Marcar o numérico como ambíguo **tira o vínculo do dono certo** — isso não é "só
perder recall": o registro numérico legítimo cai em `nao_vinculados` sem motivo. Precisão > recall continua a
regra; aqui é a REMOÇÃO do laço que devolve precisão.

## O que mudou

- `src/lib/omie/omie-doc-ambiguo.ts` e o espelho `// MIRROR-START omie doc-ambiguo` em
  `supabase/functions/omie-analytics-sync/index.ts`: o laço `for (const doc of codigosPorDoc.keys()) { if
  (!/[A-Z]/.test(doc)) … mutilado … }` sai; fica um comentário dizendo **por que não há laço** (migration
  20261019140000) — o próximo a "restaurar o fail-closed" lê a pré-condição antes. Paridade textual src×edge
  continua no `edge-money-path-invariants.test.ts`.
- `omie-doc-ambiguo.test.ts`: o caso `alfanumerico_mutilacao_de_outro` passa a esperar **∅** (era
  `{'12345678909'}`); o `it` nomeia o pós-#3195. Os 9 fixtures continuam espelhados verbatim com a canária.
- Canária `doc_ambiguo_probe`: mesmo caso → `expected: []`; contrato **v3** nomeia a fatia ("mutilação não é
  ambiguidade: snapshot preserva letras"). Um bundle v2 no ar responde `["12345678909"]` nesse caso → `ok:false`,
  e o contrato velho na resposta denuncia o deploy não feito. Tabela de canárias do `deploy.md` atualizada.
- `versao.ts` v1.14 registra a **pré-condição de banco** (migration aplicada) — deploy desta edge antes dela
  reabriria o buraco do Codex ALTO. Hoje a ordem já está satisfeita.

## Prova

- Gates locais: `canaria:bump` ✓ (superfície mudou → contrato bumpou) · `sonda:bump` ✓ · `sonda:fingerprint --write`
  (1 linha) · `edges:sintaxe` ✓ · vitest dos 2 arquivos (360 testes) ✓ · `test:edges` (`--no-remote`) e
  `edges:typecheck` — ver o corpo do PR.
- **Falsificação:** restaurar o laço só no helper de `src/` → o teste do caso `alfanumerico_mutilacao_de_outro`
  fica VERMELHO (∅ esperado, `{'12345678909'}` produzido) **e** a paridade src×edge fica vermelha. Restaurar nos
  dois → só o teste do caso. Ou seja, o teste discrimina o laço, não só a paridade.

## Deploy (fora do merge — `deploy.md`)

Edge `omie-analytics-sync`: quem decide é `bun run pendencias:deploy`; 1ª atestação com sonda
(`{"probe":true}` → `v1.14-mutilacao-nao-e-ambiguidade` + `fonte` do fingerprint) e canária
(`doc_ambiguo_probe` → `data.contrato = doc-ambiguo-mutilacao-nao-e-ambiguidade-v3`, `data.ok = true`).
Pré-condição de banco já satisfeita (migration 20261019140000 atestada em 2026-10-19).

## Lição

**Fail-closed de TRANSIÇÃO tem prazo de validade escrito na pré-condição.** Um guard que compensa um defeito de outra
camada deve nomear o defeito (migration/edge ausente) no comentário e no `versao.ts`; quando a outra camada sobe, o
guard **muda de sinal** — deixa de proteger e passa a tirar vínculo do dono certo. A remoção é entrega própria, com
canária bumpada: a canária é o que distingue "a edge nova subiu" de "o laço ainda está no ar".
