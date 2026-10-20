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
- `CNPJ_MASCARA_RE` (constante interna — exportar sem consumidor reprova o `knip`) nos dois arquivos, com o **mesmo literal** das duas migrations.
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

## Deploy (medido 2026-10-20)

PR #3199 mergeado em `36a401d1f`. O ledger (`pendencias:deploy`) listou as 5 edges em `DIVERGE_P1` junto com
`fin-cashflow-engine` (#3191); o `pendencias:pacote` saiu exit 0 (pré-condição de banco ok, 6 edges numa colagem).
**Duas sessões colaram o mesmo pacote com 1 min de diferença** (01:42 e 01:43 UTC): a 1ª deployou as 6; a 2ª (esta)
recebeu do agente "3 de 60 hashes diferem" — a `main` já tinha andado (#3201 bumpou `omie-analytics-sync` para
`v1.14`) — e, como manda o pacote, ele **não publicou nada**. Resultado honesto nos dois lados: ninguém deployou
subconjunto nem bundle fora da `main`. Sonda 4 min depois: as 5 edges servem `-cnpj-mascara-exata` (`CONFERE`);
`omie-analytics-sync` ficou pendente de novo pelo `v1.14` do #3201, não por esta entrega.

Custo do 2º envio: 2,9 créditos e **edições não pedidas** pelo bot (`lovable-sensor-edicao` → `EDICAO_DETECTADA`):
`types.ts` ganhou as 4 RPCs que já existem em prod (tolerado) e `supabase/functions/mcp/index.ts` levou um bump de
`@supabase/supabase-js` 2.95.3 → 2.117.0 apesar do "No files were edited.". Esse **não** se reverte: o
`mcp/index.ts` é AUTO-GENERATED pelo plugin Vite `@lovable.dev/mcp-js` a partir de `src/lib/mcp/` (import sem
versão → faixa do `package.json`, `^2.117.0` desde o #3198), então o bot só regenerou. O revert (#3206) foi
fechado; o que quebrava era o lock do `edges:typecheck`, regravado no #3207 (este diário foi junto). Lição: **antes de colar o pacote, confira o ledger colado** — `visto há N min via sonda` com a `versao` da
main já diz que outra sessão colou; a pista de sessão-irmã é fraca, a sonda é a prova.
E a 2ª lição, do #3206: **`EDICAO_DETECTADA` em arquivo GERADO é falso positivo do sensor**, que hoje só tolera
`types.ts` — antes de reverter commit do bot, pergunte "quem gera este arquivo?" (`git grep` do caminho em
`vite.config.ts`/plugins); saída de gerador se corrige na FONTE (`src/lib/mcp/`, `package.json`), nunca no artefato.
Incidente para o sensor passar a tolerar `supabase/functions/mcp/index.ts`: #3206.

## Lição

Quando um contrato vive em DOIS lugares (SQL e TS), apertar um e esquecer o outro deixa o lado frouxo **gravando** o que
o lado estrito não lê. Corrigir o SQL pelo Codex sem revisitar o helper TS que o espelha foi o furo; a regra de
`radar-cnpj-alfanumerico-escritores.md` ("mantenha os espelhos iguais") vale também para o **espelho SQL**.
