# Helper TS `normalizarDocumento` adota a MÁSCARA EXATA do SQL — follow-up 3 do #3180 (2026-10-19)

Branch `claude/intelligent-engelbart-8d7677`. Sem migration: só TS (helper da edge, espelho em `src/`, testes, `VERSAO` de 5 edges, fingerprints).

## O buraco que fechou

O Codex retroativo do #3175 (fechado no PR #3192) mostrou que remover os separadores `[-./]` de **qualquer posição**
transforma `aeg-123.456.789-09` — um CPF com anotação na frente — em `AEG12345678909`, que é um CNPJ alfanumérico
com DV **válido por coincidência**. O #3192 apertou `radar_recruzar_ja_cliente()` (migration 20261019150000) e o #3195
adotou a mesma regra em `public.normalizar_documento()` (20261019140000): o caminho alfanumérico só aceita o documento
**CRU** (`^[0-9A-Z]{12}[0-9]{2}$`) ou com a máscara nas **posições exatas**
(`^[0-9A-Z]{2}[.][0-9A-Z]{3}[.][0-9A-Z]{3}/[0-9A-Z]{4}-[0-9]{2}$`), após `btrim+upper`, e só então remove os separadores.

O helper TS `supabase/functions/_shared/cnpj-alfanumerico.ts` (e o espelho `src/lib/omie/cnpj-alfanumerico.ts`) ficou
com a regra antiga. A chave SQL mais estrita que o escritor é **segura para vínculos** (o escritor só consulta
`doc_to_user`), mas os 5 escritores do #3180 (`omie-analytics-sync`, `omie-cliente`, `omie-vendas-sync`, `omie-sync`,
`analyze-unified-order`) podiam gravar `omie_clientes_nao_vinculados.cnpj_cpf` **inflado** (`AEG12345678909` em vez do
CPF `12345678909`) — e o front (`Auth`/`SignupForm`/`Profile` via o espelho) aceitava `12ABC.34501DE-35` como válido.

## O que mudou

- `normalizarDocumento`: `trim+upper` → só se o todo casa `CNPJ_RE` **ou** o novo `CNPJ_MASCARA_RE` remove `[-./]`; e
  ainda exige letra + DV (`ehCnpjAlfanumerico`). Qualquer outra forma → só-dígitos **byte-idêntico** ao `.replace(/\D/g,'')`.
- `CNPJ_MASCARA_RE` exportado nos dois arquivos, com o **mesmo literal** das duas migrations.
- `documentoParaCadastro` herda a regra (CPF anotado cadastra como CPF; `12ABC.34501DE-35` recusa com a marca do ramo).

| entrada | antes | agora | SQL (`normalizar_documento`) |
|---|---|---|---|
| `aeg-123.456.789-09` | `AEG12345678909` | `12345678909` | `12345678909` |
| `12ABC.34501DE-35` | `12ABC34501DE35` | `123450135` | `123450135` |
| `12.ABC.345/01DE-35` | `12ABC34501DE35` | `12ABC34501DE35` | `12ABC34501DE35` |
| `12ABC34501DE35` | idem | idem | idem |
| `12-ABC-345-01DE-35` | `12ABC34501DE35` | `123450135` | `123450135` |

## Prova

- `cnpj-alfanumerico_test.ts` (Deno, 11 testes) e `cnpj-alfanumerico.test.ts` (vitest): casos novos **vermelhos antes**
  (`Received: "AEG12345678909"`) e verdes depois; o caso `ehCnpjAlfanumerico("AEG12345678909") === true` fica no teste
  para provar que a coincidência de DV é real, não hipotética.
- Paridade helper↔espelho: `diff` dos dois arquivos sem cabeçalho e ignorando aspas só difere no bloco
  `documentoParaCadastro`, que já era exclusivo da edge.
- Gates: `test:edges` 2027 ok · `edges:typecheck` 0 crash · `edges:sintaxe` 320 módulos · `sonda:bump` ✓ (5 edges
  `-cnpj-mascara-exata`) · `sonda:fingerprint` ✓ · 22 vitests de forma (740) · `typecheck:app` · eslint.

## Deploy

As 5 edges precisam de deploy manual (Lovable) — `bun run pendencias:deploy` decide a fila pelo `(versao, fonte)`.
Até lá, o `cnpj_cpf` inflado só pode nascer de um documento Omie com letras E separador fora da máscara (raro);
o recruzar SQL já não o aceita como chave desde o #3192.

## Lição

Quando um contrato vive em DOIS lugares (SQL e TS), apertar um e esquecer o outro deixa o lado frouxo **gravando** o que
o lado estrito não lê. Corrigir o SQL pelo Codex sem revisitar o helper TS que o espelha foi o furo; a regra de
`radar-cnpj-alfanumerico-escritores.md` ("mantenha os espelhos iguais") vale também para o **espelho SQL**.
