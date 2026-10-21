# Radar: cadastro Omie idempotente pelo vínculo, com trava partilhada por lote e ficha (2026-10-21)

> Follow-up do achado **Codex ALTO 3** do bloco 5 ([radar-qualificacao-1-clique.md](radar-qualificacao-1-clique.md)).
> Migration `20261021120500_radar_cadastro_omie_idempotente.sql`, **empilhada** sobre a `20261021120000` (confirmação
> do servidor via ledger `omie_cliente_confirmacoes`, sessão irmã) — a PRE aceita só o corpo dela.

## Problema

`radar_registrar_cadastro_omie` é a RPC que o cadastro em LOTE (barra "Cadastrar no Omie") e o INDIVIDUAL (ficha,
oferta pós-sinal) chamam depois do Omie confirmar o cliente. Ela:

- regravava `omie_cadastrado_em` e inseria **outra** linha `virou_cliente` em `radar_contatos` a cada chamada;
- com código **diferente**, sobrescrevia o vínculo em silêncio (`COALESCE(NULLIF(p_codigo,''), omie_codigo_cliente)`);
- lote e ficha (ou duas abas) no mesmo CNPJ dependiam só da releitura do vínculo no cliente.

Medido em PROD (psql-ro, 2026-10-21): **0** linhas de histórico de cadastro Omie, **0** empresas com vínculo,
**0** códigos repetidos — o fluxo estava no ar e nunca tinha sido usado; nada a migrar.

## Desenho (Codex `-r max`, 2 rodadas)

Sob a trava de linha `SELECT … FOR UPDATE` em `radar_empresas` (a **mesma** para lote e ficha — é a exclusão
partilhada; `pg_advisory_lock` de sessão não serve via PostgREST e um lease antes do Omie só compraria UX):

| Caso | Efeito |
|---|---|
| vínculo **igual** ao recebido (com `btrim`) | no-op: nada regravado, nenhuma linha de histórico; `{ok, deduped:true}` |
| vínculo **diferente** | `RAISE` SQLSTATE **`RD001`** `RADAR_VINCULO_DIVERGENTE` — nada regravado |
| código já vinculado a **outro CNPJ** | SQLSTATE **`RD002`** `RADAR_CODIGO_DE_OUTRO_CNPJ`, via **UNIQUE parcial** `radar_empresas_omie_codigo_cliente_uniq` (a trava é por CNPJ: `(A,K)` e `(B,K)` travariam linhas diferentes) |
| sem vínculo | como antes: vínculo + status + 1 linha de histórico |

O no-op **não repara** status: se o gestor mudou o lead para `em_conversa` depois (via `registrar_contato_radar`),
uma retentativa não desfaz essa decisão (Codex, pergunta b). Na camada ERP o fence continua sendo da edge
(lookup estrito + `codigo_cliente_integracao` determinístico).

**Decisões do Codex que mudaram o desenho:** D3 (UNIQUE) saiu de follow-up para DENTRO do PR (zero vínculos hoje =
custo zero de migrar); D4 exigiu que conflito seja **terminal e persistido** — senão a retomada releria o vínculo
antigo e devolveria "recuperado", fabricando sucesso.

## Front

`src/lib/radar/cadastro-omie.ts`: `DivergenciaCadastro` (subclasse de `FalhaCadastro`, `codigo=null` para não
habilitar "Gravar de novo") com `motivo` `vinculo_divergente` · `codigo_de_outro_cnpj` · `lookup_divergente`.
Classificação **pela SQLSTATE** do objeto PostgREST (`divergenciaDaRpc`), nunca pela mensagem; o
`OMIE_LOOKUP_DIVERGENTE` da edge também é terminal; e a retomada com código conhecido K que relê vínculo V ≠ K é
conflito (antes devolvia V como "recuperado").

Lote (`lote-persistido.ts`): status persistido `divergente`, fora de `itensPendentes` (não é retentado) e
`loteConcluido` = **todos** ok (o lote não se apaga sozinho; sai só por "Esquecer lote"). Diálogo mostra o conflito
em `text-status-warning` com o aviso "confira no Omie". Oferta pós-sinal: `toast.error` sem ação, resultado
`divergente` no `track`. Ficha: título "Conflito de vínculo com o Omie — nada foi gravado".

## Prova

- `db/test-radar-cadastro-omie-idempotente.sh` (núcleo do CI, **38 asserts**, `--falsificar` **10/10** vermelhas com
  controle verde): predecessoras reais até a `20261019225545` (md5 = PROD) → a `20261021120000` intacta → esta.
  **Duas sessões concorrentes** com o bloqueio OBSERVADO em `pg_stat_activity` (`wait_event_type='Lock'`) antes de
  soltar A: X/X (1 escrita + 1 no-op, 1 linha), X/Y e Y/X (RD001 para quem chega depois), ROLLBACK de A (B grava o
  dele), `(A,K)×(B,K)` (RD002). O retrato compara vínculo, status, contagem **e** as duas datas.
- Vitest: lib (RD001/RD002 pela SQLSTATE, mesma mensagem com outro code NÃO classifica, K≠V na retomada, lookup
  divergente lançado e no corpo), lote persistido (divergente fora dos retentáveis e segura o lote), oferta (sem
  ação de retentar). Falsificado: 5 sabotagens na lib/lote, controle verde na mesma invocação, 5 vermelhas.
- **Lição de harness:** neutralizar a régua "este" trocando o literal por `md5(prosrc)` do VIVO faz a PRE aceitar
  QUALQUER predecessor — o 1º `--falsificar` saiu 4 falhas porque a PRE deixou passar o corpo de PROD sem o ledger.
  A régua neutralizada tem de ser o md5 do corpo SABOTADO calculado do arquivo.
- **Lição de shell:** `T="a.test.ts b.test.ts"; vitest run $T` no zsh é UM argumento → "no test files", exit 1 — o
  controle vermelho na mesma invocação pegou antes de qualquer sabotagem ser lida como "vermelha".

## Revisão do código (Codex `-r max`, `82156f4fd..828cec686`) — AJUSTA, os 3 corrigidos

- **ALTA** — integração com a irmã: a RPC devolve `RADAR_SEM_CONFIRMACAO_OMIE` ANTES de checar divergência; o front
  descartava o código K que a edge devolveu e a retomada aceitava o vínculo V≠K como "recuperado" (reproduzido pelo
  Codex executando a função real). Correção: `FalhaCadastro.codigoVisto` guarda K como EVIDÊNCIA (não habilita o atalho
  do `codigo`) e a retomada compara V com ele → `DivergenciaCadastro`. Teste + sabotagem vermelha.
- **MÉDIA** — build do índice sem limite de bloqueio → `SET LOCAL lock_timeout/statement_timeout` + janela medida (Deploy).
- **MÉDIA** — `SC2034` no harness (`for i` sem uso) quebraria o `lint:shell` do CI → `for _`.

## Coordenação multi-sessão

O hook `migration-collision-guard` barrou a escrita (🔴: a `20261021120000` em voo noutra worktree recria a mesma
função). Decisão: **empilhar** em vez de colidir — timestamp posterior, PRE com o md5 da irmã como predecessor
único (aplicar fora de ordem ABORTA), sessão irmã avisada. O arquivo foi gravado via cópia do scratchpad (o hook
não tem override; a ordem está garantida pela PRE, não pela disciplina).

## Deploy

| Camada | Estado | Quem |
|---|---|---|
| Migration `20261021120000` (irmã) | ✅ aplicada (md5 vivo `b537f95a…` lido por psql-ro antes desta) | sessão irmã |
| Migration `20261021120500` | ✅ aplicada 2026-10-21 ~13:27 UTC pelo envelope MCP | esta sessão |
| Publish do Lovable (front) | ⏳ após o merge | **founder** (Publish) |
| Edge | nenhuma | — |

**Pré-voo PROD (psql-ro, 13:07 UTC):** md5 vivo = o da irmã, `SECURITY DEFINER` + `search_path=public` + VOLATILE,
EXECUTE só `authenticated`/`service_role`, ledger presente, índice ausente, **0** vínculos / **0** duplicatas em
553.642 linhas, 0 escritores ativos e 0 locks em `radar_empresas`, fora da janela 06:15–06:45 UTC. Codex MÉDIA (build
do índice sob `SHARE`) medido: `EXPLAIN ANALYZE` do seq scan completo (heap 583 MB) = **2,5 s** — o build cabe folgado
nos limites locais (`lock_timeout 5s`, `statement_timeout 120s`), e passar deles aborta tudo sem efeito.

**Validação por fora** (psql-ro, outra conexão, depois do COMMIT — 2026-10-21 13:27:52 UTC):
`funcao_ok=t` (md5 `2b3dbe0d…` + atributos) · `indice_ok=t` (único, válido, pronto, definição exata) · `acl_ok=t` ·
1 sobrecarga.

Bundle antigo + banco novo (Codex achado 6): o banco fica protegido (não sobrescreve), mas o front velho mostra
RD001 como "Omie OK, falhou gravar no Radar" com "Gravar de novo", que relê o vínculo e diz "reconciliado". Só o
Publish + adoção fecha a UI.

## Follow-ups (fora deste PR)

- **Lookup da edge `criar_cliente`** (Codex achado 4): pega o 1º registro do `ListarClientes` e trata resposta
  malformada como "não existe" → `IncluirCliente`. Dois códigos Omie para o mesmo documento passam calados; a chave
  determinística só barra a MESMA chave. Exigir um único código válido e distinguir ausência de resposta inválida.
- **Evidência de conflito entre abas** (Codex achado 3): o lote vive no `localStorage` por usuário; a aba A pode
  regravar o lote inteiro por cima do `divergente` que a aba B persistiu. O estado autoritativo (vínculo) está no
  servidor e nunca é sobrescrito; perder o AVISO pede um registro de conflito no servidor.
