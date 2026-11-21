# F1 — Extrato bancário independente (Itaú Oben) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Responda e escreva SEMPRE em pt-BR.

**Goal:** importar o extrato do Itaú (arquivo do Bankline) para o app, validar em centavos e mostrar, por conta e por dia, o que o banco registrou ao lado do que o Omie registrou, sem escrever nada no Omie.

**Architecture:**
- O front sobe o arquivo num bucket privado.
- A edge `banco-extrato-importar` baixa o arquivo, faz o parse com um helper TS puro (espelhado byte a byte entre `src/` e `_shared/`, com teste de paridade) e entrega o resultado à RPC SQL `banco_extrato_registrar`.
- A RPC decide tudo numa transação, sob advisory lock por conta: conta compatível, fechamento, continuidade, sobreposição e idempotência.
- A tela lê um resumo por dia via RPC. Não lê linhas cruas, por causa da capa de 1000 linhas do PostgREST.

**Tech Stack:** Postgres 17 (Supabase/Lovable Cloud), Deno edge, React 18 + TS strict, react-query, shadcn/ui, vitest, `deno test --no-remote`.

**Spec:** `docs/superpowers/specs/2026-11-20-integracao-bancaria-itau-design.md` (v2, aprovada em 2026-11-20). Seções: §4 F1, §4b, §4c, §5, §7, §7b.4.

## Global Constraints

- Valores em **centavos inteiros** (`bigint` no SQL, `number` inteiro no TS). Ausente ≠ zero: o que falta vira `null` ou "indisponível", nunca `0`.
- **Fecha em centavos ou recusa o arquivo inteiro.** Import parcial não existe.
- **Uma conta bancária real = N `omie_ncodcc`** (a principal + a "Pix Itaú"). Idempotência e cobertura são pela conta **bancária**.
- **Nenhum número de agência ou conta em arquivo versionado**, nem em fixture, migration, teste ou doc. Fixtures usam agência `0000` e conta `000000`. O arquivo real do Bankline **nunca** entra no repo; fica no scratchpad.
- Tabela nova **sempre** com RLS. Leitura por `public.fin_user_can_access(company)`. Escrita só por RPC `SECURITY DEFINER` com `REVOKE` de `PUBLIC` **e** `anon` (e `authenticated` quando a chamada é só da edge), conferido por `has_function_privilege`.
- **Migration:** um arquivo novo `supabase/migrations/<date -u +%Y%m%d%H%M%S>_banco_extrato_f1.sql`, posterior à última da main no momento da criação. Usar o molde TRAVA → PRE → CREATE → POS (`20261031191715_data_health_saldo_bancario_conta_a_conta.sql`). Idempotente, sem `BEGIN/COMMIT`, com postcondição `DO $post$ … RAISE EXCEPTION`. Nunca editar migration já commitada.
- **Prova PG17** obrigatória (skill `prove-sql-money-path`) em `db/test-banco-extrato-f1.sh`, registrada em `db/nucleo-ci.txt`. Falsificar uma camada por vez, com controle verde na mesma invocação, nos dois locales (`LC_ALL=C` e `pt_BR.UTF-8`). Commitar antes de falsificar.
- `CREATE OR REPLACE` de função existente (`analytics_ledger_registrar`): pré-flight de `pg_get_functiondef` em prod e trava md5 do predecessor.
- Edge nova: `versao.ts` com `VERSAO`/`EFEITO`/sonda, `sonda:nova`, `sonda:bump`, `sonda:fingerprint -- --write`, `test:edges`, `edges:typecheck`, `edges:sintaxe`.
- Arquivo novo em `src/` com dono em `src/lib/modulos/manifesto.ts`, módulo `financeiro`. Os testes entram listados em `testes[]`.
- Rota nova fora de `/financeiro/conciliacao` (congelada até 2027-01-10): `/financeiro/extrato-bancario`.
- Toast só `sonner`. Status colors `text-status-*`. Skeleton `<PageSkeleton>`. Empty `<EmptyState tone="operational">`. Filtros em `useUrlState`. Ação de importar com `useMutationComRegistro`.
- Fora do escopo da F1: qualquer escrita no Omie, conciliação, BB/Omie.CASH/Justa (F1b) e API Itaú (F4).

## Decisões do builder (calls minhas, a conferir na revisão)

1. **Um formato por conta.** O primeiro arquivo aceito fixa `formato` em `banco_conta`. Arquivo de outro formato vai para `pendente_revisao` com `formato_diferente`. Motivo: a descrição do OFX e a do CNAB diferem, e a chave sem id bancário depende dela.
2. **Estratégia de chave por conta, decidida por medição** (Task 0), fixada em `banco_conta.estrategia_chave` no primeiro aceite:
   - `id_bancario`: usada se o FITID/nº de lançamento for estável entre exportações sobrepostas. Chave = `id:${idBancario}`.
   - `tupla` (fallback): chave = `data|sentido|valor|documento|ordinal`, com ordinal 1..n entre linhas de mesmo `(data, sentido, valor, documento)`. A **descrição fica fora da chave** porque o histórico textual pode mudar entre exportações. A descrição gravada é a do primeiro arquivo.
3. **Arquivo que inclui o dia corrente** (America/Sao_Paulo) é recusado (`periodo_inclui_dia_corrente`), porque o dia ainda está aberto e depois viraria sobreposição divergente.
4. **Arquivo sem saldo inicial explícito** (OFX costuma trazer só o `LEDGERBAL`) é aceito se ancorado:
   - por continuidade a um arquivo aceito;
   - ou por uma **âncora de saldo** em `banco_conta_ancora` (conta, data, saldo ao fim do dia, `origem` `cnab`/`manual`, quem registrou). A âncora manual é digitada pelo financeiro a partir do Bankline e aparece marcada como "manual" na tela.

   Sem nenhuma das duas → `pendente_revisao` / `sem_saldo_inicial`. **Recomendação ao founder: exportar CNAB 240**, que traz saldo inicial e final.
5. **O lado Omie tem duas partes:**
   - **movimento por dia** (critério "o livro bate" = movimentação pós-corte, spec §7), que só aparece com a regra calibrada (Task 9);
   - **saldo Omie datado**, que começa a ser fotografado diariamente pela Task 9b (`fin_saldo_conta_diario`). Antes da 1ª foto, o saldo é `NULL`. A **diferença do corte** (saldo Itaú − Σ saldos Omie das N contas na data de corte) aparece à parte e é `NULL` se faltar qualquer parcela.

## Review Focus

(revisado com o challenge Codex do plano, 2026-11-20)

1. **Arquivo de outra conta ou outra empresa** (a conta fecha perfeitamente): recusar com `conta_divergente`, sem gravar nenhuma linha. Teste na Task 2.
2. **Mesmo período exportado de novo com um lançamento a mais num dia já importado:** o arquivo inteiro vai para `pendente_revisao` com `sobreposicao_divergente`, e nenhuma linha nova entra. Teste na Task 2.
3. **Duas tarifas idênticas no mesmo dia, e o arquivo reexportado com a ordem trocada:** continuam sendo 2 linhas, e a reimportação acrescenta 0. Testes nas Tasks 3 e 2.
4. **OFX em windows-1252 com acento na descrição e valor negativo `-1234.56`:** decodificar latin1 corretamente, sentido `D` e valor `123456`. Teste na Task 4.
5. **Dois uploads simultâneos do mesmo arquivo:** um registra, o outro devolve `ja_importado` com o mesmo `arquivo_id`, e zero duplicatas. Teste na Task 2, com duas sessões psql.
6. **Importação fora de ordem** (dias 1 e 3 aceitos, depois o dia 2): o dia 2 precisa fechar com as **duas** fronteiras. Teste na Task 2.
7. **Arquivo recusado por dia corrente e reenviado amanhã** (mesmo hash): é reavaliado, não fica preso em `ja_importado`. Teste na Task 2.

---

### Task 0: Medir o arquivo real (pré-requisito das Tasks 2–5)

- [ ] **Step 1:** pedir ao founder o extrato da Oben exportado **duas vezes com sobreposição** (ex.: 01–15 e 10–30 do mesmo mês), no formato que o Bankline oferecer (de preferência CNAB 240, e OFX também se houver). Guardar no scratchpad, **nunca** no repo.
- [ ] **Step 2:** por inspeção (script local não versionado), registrar no PR **só agregados**:
  - formato e encoding;
  - se traz saldo inicial;
  - se o id bancário existe e se é estável nos dias em comum (nº de ids iguais ÷ linhas em comum);
  - se a descrição muda entre as exportações;
  - se há lançamento não efetivado.
- [ ] **Step 3:** decidir `estrategia_chave` (`id_bancario` se a estabilidade for 100%, senão `tupla`) e qual parser vem primeiro. Anotar a decisão no PR.

### Task 1: Esquema, RLS, bucket e cadastro da conta bancária

**Files:**
- Create: `supabase/migrations/<ts>_banco_extrato_f1.sql`
- Create: `db/test-banco-extrato-f1.sh` (a partir de `.claude/skills/prove-sql-money-path/references/harness-template.sh`)
- Modify: `db/nucleo-ci.txt` (acrescentar a prova)

**Interfaces:**
- Produces (tabelas, todas com `company text not null` e RLS `USING (public.fin_user_can_access(company))` para SELECT; sem policy de INSERT/UPDATE/DELETE para `authenticated`):
  - `banco_conta` (`id uuid pk`, `company`, `banco_codigo text` (ex. `'341'`), `agencia_digitos text not null`, `conta_digitos text not null` (só dígitos, com DV), `descricao text`, `formato text null check in ('ofx','cnab240')`, `estrategia_chave text null check in ('id_bancario','tupla')`, `ativo bool`, `UNIQUE(banco_codigo, agencia_digitos, conta_digitos)`). A conta é única no país, não só na empresa.
  - `banco_conta_ancora` (`id uuid pk`, `company`, `banco_conta_id fk`, `data date`, `saldo_final_dia_centavos bigint`, `origem text check in ('cnab','manual')`, `registrado_por uuid`, `registrado_em timestamptz`, `UNIQUE(banco_conta_id, data, origem)`). Escrita só pela RPC `banco_conta_registrar_ancora(p_banco_conta_id, p_data, p_saldo_centavos)`, `SECURITY DEFINER`, com `fin_user_can_access`.
  - `banco_conta_omie` (`banco_conta_id uuid fk`, `company`, `omie_ncodcc bigint`, `PRIMARY KEY(banco_conta_id, omie_ncodcc)`, `UNIQUE(company, omie_ncodcc)`). Uma conta Omie pertence a no máximo uma conta bancária.
  - `banco_extrato_arquivo` (`id uuid pk`, `company`, `banco_conta_id fk`, `formato`, `storage_path text`, `sha256 text`, `periodo_inicio date`, `periodo_fim date`, `saldo_inicial_centavos bigint null`, `saldo_final_centavos bigint`, `qtd_linhas int`, `qtd_linhas_novas int`, `status text check in ('aceito','pendente_revisao','recusado')`, `motivo text null`, `detalhe text null`, `enviado_por uuid`, `enviado_em timestamptz default now()`, `conferido_por uuid null`, `conferido_em timestamptz null`, `UNIQUE(banco_conta_id, sha256)`).
  - `banco_extrato_linha` (`id uuid pk`, `company`, `banco_conta_id fk`, `arquivo_id fk`, `data date`, `sentido char(1) check in ('C','D')`, `valor_centavos bigint check > 0`, `descricao text`, `documento text null`, `id_bancario text null`, `chave text`, `UNIQUE(banco_conta_id, chave)`, índice `(banco_conta_id, data)`).
- Bucket `banco-extratos`: `public=false`, `file_size_limit` 10 MB, mimes `text/plain`, `application/x-ofx`, `application/octet-stream`. Path: `{banco_conta_id}/{uuid}.{ext}`. Policies de INSERT e SELECT em `storage.objects` (molde `20260703090000_pedidos_programados.sql:121-135`), exigindo:
  - `bucket_id='banco-extratos'`;
  - `EXISTS (select 1 from banco_conta c where c.id::text = (storage.foldername(name))[1] and public.fin_user_can_access(c.company))`.

  Sem UPDATE nem DELETE. O caminho não carrega `company`, que é sempre derivada da conta.
- **Privilégios:** `REVOKE ALL` das 5 tabelas de `anon` e `authenticated`, seguido de `GRANT SELECT` a `authenticated`. Isso fecha `TRUNCATE`/`INSERT`/`UPDATE`/`DELETE` diretos.
- **Seed:** para cada `company`, uma `banco_conta` Itaú derivada **por SELECT** de `fin_contas_correntes` (`banco='341'`, `tipo='CC'`, `ativo`, com agência e conta preenchidas). Nenhum literal de conta no arquivo. Ligar em `banco_conta_omie` todas as contas `banco='341'` ativas da mesma empresa (a principal e a "Pix Itaú"). POS: cada empresa com conta Itaú ativa tem exatamente 1 `banco_conta`, e toda conta 341 ativa está ligada.

- [ ] **Step 1: Escrever a prova (vermelha):** `db/test-banco-extrato-f1.sh`, com stubs de `auth.uid()` via GUC `test.uid`, `has_role`, `fin_user_can_access`, `fin_contas_correntes` e `storage.buckets/objects`. Casos:
  - `t1_rls_le_so_empresa_permitida`: sob `SET ROLE authenticated` com um usuário sem permissão, `select count(*) from banco_extrato_linha` = 0.
  - `t1_insert_direto_negado`: INSERT como `authenticated` falha com SQLSTATE `42501`. Capturar a SQLSTATE exata e re-lançar o resto.
  - `t1_truncate_negado`: `has_table_privilege('authenticated','banco_extrato_linha','TRUNCATE') = false`, e o mesmo para `anon` e para as 5 tabelas.
  - `t1_storage_outra_empresa_negado`: sob `authenticated` sem acesso à empresa da conta, INSERT em `storage.objects` com `name = '<conta>/x.ofx'` falha com `42501`.
  - `t1_seed_pix_itau_ligada`: fixture com 2 contas 341 na mesma empresa, uma com agência e conta e outra "Pix Itau" sem elas → 1 `banco_conta`, 2 linhas em `banco_conta_omie`.
  - `t1_idempotente`: aplicar a migration 2× → mesmo estado, sem erro.
- [ ] **Step 2: Rodar** `bash db/test-banco-extrato-f1.sh` → vermelho porque a migration não existe.
- [ ] **Step 3: Escrever a migration** (TRAVA → PRE → CREATE → POS), cobrindo as interfaces acima.
- [ ] **Step 4: Rodar a prova** → verde, com `exit 0` colado. Rodar `bun run audit:migrations` e `bun run wt:preflight supabase/migrations/<ts>_banco_extrato_f1.sql`.
- [ ] **Step 5: Commit** `feat(banco): esquema F1 do extrato bancário (tabelas, RLS, bucket, seed Itaú) [migration manual]`.
- [ ] **Step 6: Falsificar** (depois do commit): remover o `ENABLE ROW LEVEL SECURITY` de `banco_extrato_linha` → `t1_rls…` vermelho; trocar `'341'` por `'999'` no seed → `t1_seed…` vermelho. Tudo com controle verde na mesma invocação e nos 2 locales.

### Task 2: RPC `banco_extrato_registrar` e `banco_extrato_marcar_conferido`

**Files:**
- Modify: `supabase/migrations/<ts>_banco_extrato_f1.sql`
- Modify: `db/test-banco-extrato-f1.sh`

**Interfaces:**
- Consumes: as tabelas da Task 1.
- Produces:
  - `public.banco_extrato_registrar(p jsonb) RETURNS jsonb`, `SECURITY DEFINER`, `SET search_path = public`, `REVOKE` de `PUBLIC`, `anon` e `authenticated`, `GRANT` a `service_role`. `p` = `{banco_conta_id, formato, estrategia_chave, storage_path, sha256, enviado_por, hoje (date, America/Sao_Paulo), extrato: {banco, agencia, conta, periodo_inicio, periodo_fim, saldo_inicial_centavos|null, saldo_final_centavos, linhas:[{data, sentido, valor_centavos, descricao, documento, id_bancario, chave}]}}`. Retorna `{status: 'aceito'|'pendente_revisao'|'recusado'|'ja_importado', arquivo_id, motivo, detalhe, qtd_linhas_novas}`.
  - `public.banco_extrato_marcar_conferido(p_arquivo_id uuid) RETURNS void`, `SECURITY DEFINER`. Exige `fin_user_can_access(company)` do `auth.uid()` (senão SQLSTATE `42501`). Grava `conferido_por` e `conferido_em` só se o status for `aceito`. `GRANT` a `authenticated`, `REVOKE` de `PUBLIC` e `anon`.
  - `public.banco_extrato_resumo_dia(p_banco_conta_id uuid, p_de date, p_ate date) RETURNS TABLE(data date, coberto bool, creditos_centavos bigint, debitos_centavos bigint, saldo_final_dia_centavos bigint)`, `SECURITY INVOKER` (a RLS vale). Dia sem cobertura devolve `coberto=false` e os três valores `NULL`, nunca 0. Dia coberto sem movimento devolve `0, 0, saldo`. O saldo do dia é ancorado no `saldo_inicial` (ou no inicial derivado por continuidade) do arquivo aceito que cobre o dia.

**Ordem de decisão dentro de `banco_extrato_registrar`** (primeira que falhar define o resultado). Tudo sob `pg_advisory_xact_lock(hashtext(banco_conta_id::text))`:
0. `company` é **derivada de `banco_conta`**, nunca do payload. Conta inexistente ou inativa → `recusado` / `conta_desconhecida`.
1. `(banco_conta_id, sha256)` já existe **com status `aceito`** → `ja_importado` com o `arquivo_id` existente. Se existe com outro status, **reavalia** os passos 2–9 e atualiza aquela mesma linha (status, motivo, detalhe) em vez de criar outra.
2. Banco, agência ou conta do extrato (só dígitos) ausentes → `recusado` / `identidade_incompleta`. Qualquer um ≠ `banco_conta` → `recusado` / `conta_divergente`.
3. `periodo_fim >= hoje` → `recusado` / `periodo_inclui_dia_corrente`.
4. Alguma linha fora de `[periodo_inicio, periodo_fim]` ou chave repetida no próprio arquivo → `recusado` / `linha_invalida`.
5. Com `saldo_inicial` presente: `inicial + Σcréditos − Σdébitos ≠ final` → `recusado` / `nao_fecha` (o detalhe traz a diferença em centavos).
6. `banco_conta.formato` definido e ≠ `formato`, ou `estrategia_chave` definida e ≠ a do payload → `pendente_revisao` / `formato_diferente`.
7. **Sobreposição:** para cada dia de `[inicio, fim]` já coberto por arquivo aceito, o multiconjunto de chaves do arquivo naquele dia precisa ser igual ao das linhas existentes daquele dia. Se diferir → `pendente_revisao` / `sobreposicao_divergente`.
8. **Continuidade nas duas fronteiras e em toda data comum:**
   - Sendo `S(d)` o saldo ao fim do dia `d` já conhecido para a conta (arquivos aceitos e âncoras), e `N(d)` o saldo do novo arquivo ao fim de `d`, então para **todo** `d` em `[inicio − 1, fim]` em que `S(d)` existe vale `N(d) = S(d)`. Isso cobre a véspera, a sobreposição e o sucessor: o dia `fim` comparado com a abertura do arquivo seguinte, isto é, `S(fim) = saldo_inicial_do_seguinte − movimentos`, calculado a partir do arquivo que começa em `fim + 1`.
   - Qualquer diferença → `pendente_revisao` / `descontinuidade_saldo`, com a data e a diferença no detalhe.
   - Sem `saldo_inicial`: deriva o inicial de qualquer `S(d)` disponível no intervalo. Sem nenhum → `pendente_revisao` / `sem_saldo_inicial`.
9. Senão → `aceito`: grava o arquivo, insere só as linhas de dias não cobertos (`ON CONFLICT (banco_conta_id, chave) DO NOTHING`) e fixa `banco_conta.formato` e `estrategia_chave` se forem nulos. A cobertura e o saldo de cada dia são derivados de **uma só** fonte por dia (cada linha conta uma vez, mesmo com arquivos sobrepostos).

`pendente_revisao` e `recusado` gravam a linha em `banco_extrato_arquivo` (para aparecer na tela), mas **nunca** gravam linhas.

- [ ] **Step 1: Casos da prova (vermelhos), um por ramo**, casando o `motivo` exato:
  - `t2_aceita_e_fecha`
  - `t2_reimport_mesmo_hash_ja_importado`
  - `t2_conta_divergente`
  - `t2_dia_corrente`
  - `t2_nao_fecha_diferenca_1_centavo`
  - `t2_formato_diferente`
  - `t2_sobreposicao_igual_acrescenta_so_dias_novos`
  - `t2_sobreposicao_divergente_nao_grava_linha`
  - `t2_descontinuidade_saldo`
  - `t2_sem_saldo_inicial_sem_ancora`
  - `t2_sem_saldo_inicial_com_ancora_aceita`
  - `t2_tarifas_identicas_duas_linhas` (ordinal 1 e 2)
  - `t2_fora_de_ordem_dia2_confere_dia3`: dias 1 e 3 aceitos; dia 2 que fecha com o dia 1 mas não com a abertura do dia 3 → `descontinuidade_saldo`
  - `t2_fora_de_ordem_sem_saldo_inicial`: OFX do dia 2 sem inicial, ancorado pelo dia 1, e o dia 3 confere → `aceito`
  - `t2_ancora_manual_aceita_primeiro_ofx`
  - `t2_reavalia_recusado_dia_corrente`: mesmo hash recusado ontem é aceito hoje, e a mesma linha de arquivo é atualizada (`count(*)` de arquivos não muda)
  - `t2_reavalia_pendente_quando_ancora_chega`
  - `t2_outro_banco_mesmos_digitos` → `conta_divergente`
  - `t2_company_do_payload_ignorada`
  - `t2_resumo_dia_sem_cobertura_null`: o dia fora de cobertura tem `creditos IS NULL`, não 0.
  - `t2_resumo_dia_coberto_sem_movimento_zero`
  - `t2_conferido_exige_acesso` (SQLSTATE `42501`)
  - `t2_rpc_fechada_para_authenticated` (`has_function_privilege('authenticated', …,'EXECUTE') = false`, e o mesmo para `anon`)
  - `t2_concorrencia`: duas sessões `psql` em paralelo com o mesmo payload → 1 `aceito` + 1 `ja_importado`, e `count(*)` de linhas igual ao do arquivo.
- [ ] **Step 2: Rodar** → vermelho.
- [ ] **Step 3: Implementar as 3 funções** na migration, com POS conferindo `prosecdef` e o ACL.
- [ ] **Step 4: Rodar** → verde, com `exit 0`.
- [ ] **Step 5: Commit** `feat(banco): RPC de registro do extrato (fechamento, continuidade, sobreposição, idempotência)`.
- [ ] **Step 6: Falsificar uma camada por vez:**
  - tirar o advisory lock → `t2_concorrencia` vermelho;
  - trocar o `=` do passo 7 por "subconjunto" → `t2_sobreposicao_divergente…` vermelho;
  - `COALESCE(...,0)` no resumo → `t2_resumo_dia_sem_cobertura_null` vermelho.

### Task 3: Núcleo puro do extrato (tipos, normalização, chave, fechamento)

**Files:**
- Create: `src/lib/financeiro/extrato/nucleo.ts`
- Create: `supabase/functions/_shared/extrato-nucleo.ts` (cópia byte-idêntica)
- Test: `src/lib/financeiro/extrato/__tests__/nucleo.test.ts`
- Test: `src/lib/financeiro/extrato/__tests__/nucleo.parity.test.ts` (molde `src/lib/gates/__tests__/limpeza-fonte.parity.test.ts:15-32`, com teste de calibração)
- Modify: `src/lib/modulos/manifesto.ts` (testes no `financeiro.testes[]`)

**Interfaces:**
- Produces:
```ts
export type Sentido = 'C' | 'D';
export type FormatoExtrato = 'ofx' | 'cnab240';
export interface LinhaExtrato { data: string; sentido: Sentido; valorCentavos: number; descricao: string; documento: string | null; idBancario: string | null; }
export interface ExtratoParseado { formato: FormatoExtrato; agencia: string | null; conta: string; periodoInicio: string; periodoFim: string; saldoInicialCentavos: number | null; saldoFinalCentavos: number; linhas: LinhaExtrato[]; }
export type MotivoRecusaParse = 'formato_desconhecido' | 'campo_ausente' | 'valor_invalido' | 'data_invalida' | 'lancamento_nao_efetivado';
export type ResultadoParse = { ok: true; extrato: ExtratoParseado } | { ok: false; motivo: MotivoRecusaParse; detalhe: string };
export function soDigitos(s: string): string;
export function normalizarDescricao(s: string): string;          // trim, colapsa espaços, maiúsculas, sem acento (NFD)
export function decimalTextoParaCentavos(s: string): number | null; // "1234.56" | "-1234.56" | "1234,56" → |centavos|; >2 casas, vazio, NaN → null
export type EstrategiaChave = 'id_bancario' | 'tupla';
export function chavesDasLinhas(linhas: LinhaExtrato[], estrategia: EstrategiaChave): string[] | null; // mesma ordem; null se 'id_bancario' e alguma linha sem id ou id repetido
export function fecha(inicial: number, linhas: LinhaExtrato[], final: number): { fecha: boolean; diferencaCentavos: number };
```
- Formato da chave: `id:${idBancario}` (estratégia `id_bancario`) ou `${data}|${sentido}|${valorCentavos}|${documento ?? ''}|${ordinal}` (estratégia `tupla`).

- [ ] **Step 1: Testes vermelhos:**
  - `decimalTextoParaCentavos('1234.56') === 123456`
  - `('-0.01') === 1`
  - `('1.234,56') === 123456`
  - `('12.345') === null` (ambíguo, recusa)
  - `('') === null`
  - `chavesDasLinhas(…, 'tupla')` com 2 tarifas idênticas → sufixos `|1` e `|2`; invertendo a ordem do array, o **conjunto** de chaves é igual
  - mesma linha com descrição diferente → mesma chave `tupla`
  - estorno (D 500 e C 500 no mesmo dia) → 2 chaves distintas
  - `'id_bancario'` com uma linha sem id → `null`
  - `fecha(10000, [C 500, D 200], 10300).fecha === true`
  - com final `10301` → `diferencaCentavos === 1`
  - teste de propriedade (`fast-check`, se já for dependência; senão, 200 casos gerados à mão): permutar as linhas não muda o conjunto de chaves
- [ ] **Step 2: Rodar** `heavy bun run test src/lib/financeiro/extrato` → FAIL.
- [ ] **Step 3: Implementar** `nucleo.ts` e copiar para `_shared/extrato-nucleo.ts`. O arquivo **não importa nada** (paridade byte a byte).
- [ ] **Step 4: Rodar** → PASS. A paridade fica vermelha se as cópias divergirem (calibração).
- [ ] **Step 5: Commit** `feat(banco): núcleo puro do extrato (centavos, chave, fechamento) + espelho edge`.

### Task 4: Parser OFX

**Files:**
- Create: `src/lib/financeiro/extrato/parser-ofx.ts` + espelho `supabase/functions/_shared/extrato-parser-ofx.ts`
- Test: `src/lib/financeiro/extrato/__tests__/parser-ofx.test.ts`, com fixtures em `src/lib/financeiro/extrato/__tests__/fixtures/` (sintéticas, agência `0000`, conta `000000`)
- Modify: `nucleo.parity.test.ts` (incluir o par), manifesto

**Interfaces:**
- Consumes: `nucleo.ts`. O espelho importa `./extrato-nucleo.ts` e o canônico importa `./nucleo.ts`. A paridade compara **depois de normalizar essa linha de import**.
- Produces: `export function parseOfx(bytes: Uint8Array): ResultadoParse`.
- Regras:
  - Aceita SGML (OFX 1.x, com cabeçalho `CHARSET:1252`) e XML (2.x). Decodifica pelo `CHARSET`/`ENCODING` declarado (default `windows-1252`).
  - `BANKID`/`BRANCHID`/`ACCTID` → agência e conta (`soDigitos`).
  - `DTSTART`/`DTEND` → período (8 primeiros dígitos). `DTEND` exclusivo à meia-noite vira o dia anterior.
  - `STMTTRN`: `TRNAMT` < 0 → `D`; `FITID` → `idBancario`; `CHECKNUM`/`REFNUM` → `documento`; `MEMO`/`NAME` → `descricao`.
  - `LEDGERBAL/BALAMT` → `saldoFinalCentavos`, com sinal. `saldoInicialCentavos` = `null` (decisão 4).
  - **Revisto pela T0 (v2, R22–R26):** ver o apêndice "Task 0 medida". O `saldoInicialCentavos = null` deixou de ser regra: no Bankline ele vem do `SALDO ANTERIOR` do arquivo.
  - `TRNAMT` = 0 → `valor_invalido`.

- [ ] **Step 1: Testes vermelhos:**
  - `parseOfx(sgml1252)` devolve a descrição `'TARIFA PACOTE SERVIÇOS'` decodificada
  - `TRNAMT -1234.56` → `{sentido:'D', valorCentavos:123456}`
  - XML 2.x equivalente → mesmo resultado
  - sem `LEDGERBAL` → `{ok:false, motivo:'campo_ausente'}`
  - `TRNAMT 0.00` → `valor_invalido`
  - lixo binário → `formato_desconhecido`
- [ ] **Step 2: Rodar** → FAIL. **Step 3: Implementar.** **Step 4: Rodar** → PASS.
- [ ] **Step 5: Commit** `feat(banco): parser OFX do extrato`.

### Task 5: Parser CNAB 240 (extrato para conciliação)

**Bloqueado até haver** o manual CNAB 240 de extrato do Itaú e um arquivo real no scratchpad. As posições de campo **não** são escritas de memória: vêm do manual, e cada constante cita a página.

**Files:**
- Create: `src/lib/financeiro/extrato/parser-cnab240.ts` + espelho `supabase/functions/_shared/extrato-parser-cnab240.ts`
- Test: `src/lib/financeiro/extrato/__tests__/parser-cnab240.test.ts`, com fixture sintética gerada pelo layout do manual (agência `0000`, conta `000000`)
- Modify: paridade, manifesto

**Interfaces:**
- Produces: `export function parseCnab240(bytes: Uint8Array): ResultadoParse`.
- Regras:
  - Linhas de 240 posições. Qualquer outro tamanho → `formato_desconhecido`.
  - Header de lote → agência, conta, saldo inicial e data inicial.
  - Segmento E → lançamentos.
  - Trailer de lote → saldo final.
  - Lançamento marcado como não efetivado (previsto/futuro) → `lancamento_nao_efetivado` (recusa o arquivo).
  - Mais de um lote/conta no arquivo → `formato_desconhecido`.

- [ ] **Step 1: Testes vermelhos:**
  - fixture válida fecha com `fecha(...)`
  - linha com 239 posições → `formato_desconhecido`
  - lançamento futuro → `lancamento_nao_efetivado`
  - dois lotes → `formato_desconhecido`
- [ ] **Steps 2–4:** FAIL → implementar → PASS. **Step 5: Commit** `feat(banco): parser CNAB 240 de extrato`.

### Task 6: Edge `banco-extrato-importar`

**Files:**
- Create: `supabase/functions/banco-extrato-importar/index.ts`, `versao.ts`, `index_test.ts`
- Create: `supabase/functions/banco-extrato-importar/processar.ts` (lógica testável sem rede)
- Modify: `supabase/functions/_shared/sonda-fingerprints.ts` (via `bun run sonda:fingerprint -- --write`)

**Interfaces:**
- Consumes: `parseOfx`, `parseCnab240`, `chavesDasLinhas`, RPC `banco_extrato_registrar`.
- Produces:
  - `POST {storage_path: string, banco_conta_id: string}` → 200 com o JSON da RPC, mais `{erro_parse?: {motivo, detalhe}}`.
  - `export async function processar(deps: {baixar(path): Promise<Uint8Array>, registrar(p): Promise<unknown>, agora(): Date}, entrada, usuario: {id: string}): Promise<Resposta>`.
- Regras:
  - Gate `authorizeCronOrStaff` (`_shared/auth.ts:45`), aceitando **só JWT** (não cron).
  - Com o client do usuário, `rpc('fin_user_can_access', {check_company})`. Falso → 403.
  - `storage_path` precisa começar com `{banco_conta_id}/`. Senão → 400. A `company` vem de `banco_conta`, lida antes do gate de acesso.
  - A `estrategia_chave` vem de `banco_conta`. Se for nula, usa a decidida na Task 0, registrada como constante em `versao.ts` e citada no PR.
  - Formato detectado pelo conteúdo (`OFXHEADER`/`<OFX>` → OFX; linhas de 240 → CNAB), **não pela extensão**.
  - `sha256` calculado na edge sobre os bytes.
  - `hoje` calculado em America/Sao_Paulo.
  - Erro de parse: a edge **não** chama a RPC (que só recebe extrato parseado). Devolve 422 com `{erro_parse}`, e o front mostra.

- [ ] **Step 1: Testes Deno vermelhos** (`processar` com deps falsas):
  - path de outra conta → 400
  - OFX válido → `registrar` chamado com 1 linha por `STMTTRN` e as chaves de `chavesDasLinhas`
  - arquivo que não fecha → resposta com o motivo `nao_fecha` vindo da RPC
  - CNAB de 239 colunas → 422 com `formato_desconhecido`
  - `agora` = 20/11 01:00 UTC → `hoje` = `2026-11-19`
- [ ] **Step 2: Rodar** `bun run test:edges` → FAIL. **Step 3: Implementar** `processar.ts`, `index.ts` e `versao.ts` (molde `fin-cashflow-engine`).
- [ ] **Step 4: Rodar** `test:edges`, `edges:typecheck`, `edges:sintaxe`, `sonda:nova`, `sonda:bump` e `sonda:fingerprint -- --write` → todos com exit 0.
- [ ] **Step 5: Commit** `feat(banco): edge banco-extrato-importar [deploy edge]`.

### Task 7: Sensores no ledger

**Files:**
- Modify: `supabase/migrations/<ts>_banco_extrato_f1.sql` (recriar `analytics_ledger_registrar` acrescentando `'banco.extrato_importado'` e `'banco.extrato_conferido'` à allowlist; molde `20261028100200_analytics_ledger_corantes.sql:23-99`, corpo vivo mais recente em `20261106132259_radar_abriu_ficha_com_cnpj.sql`)
- Modify: `src/lib/analytics-ledger.ts:39-99` (união `EventoLedger`)
- Modify: `db/test-banco-extrato-f1.sh`

- [ ] **Step 1: Pré-flight:** `pg_get_functiondef('public.analytics_ledger_registrar'::regproc)` em prod via `psql-ro`. Calcular o md5 e pôr a trava TRAVA no topo do bloco (aborta se o predecessor em prod ≠ esperado).
- [ ] **Step 2: Prova vermelha:** `t7_ledger_aceita_eventos_banco` (as duas chamadas não lançam exceção) e `t7_ledger_mantem_eventos_antigos` (um evento antigo da allowlist continua aceito).
- [ ] **Step 3: Implementar. Step 4: Prova verde. Step 5: Commit** `feat(banco): sensores banco.extrato_importado/conferido no ledger`.

### Task 8: Tela `/financeiro/extrato-bancario`

**Files:**
- Create: `src/pages/FinanceiroExtratoBancario.tsx`
- Create: `src/components/financeiro/extrato/{UploadExtrato,ListaArquivosExtrato,ResumoDiarioExtrato}.tsx`
- Create: `src/services/financeiroExtratoBancario.ts`, `src/hooks/useFinanceiroExtratoBancario.ts`
- Test: `src/components/financeiro/extrato/__tests__/ResumoDiarioExtrato.test.tsx`, `src/services/__tests__/financeiroExtratoBancario.test.ts`
- Modify: `src/App.tsx` (`lazyRota` + rota dentro de `<RequireFinanceiroAccess />`, ao lado de `:249`), manifesto (testes), entrada no menu financeiro.

**Interfaces:**
- Consumes: as RPCs da Task 2, a edge da Task 6 e `registrarNoLedger`.
- Produces: `listarContasBancarias(): Promise<BancoConta[]>`, `listarArquivos(bancoContaId): Promise<ArquivoExtrato[]>`, `resumoDia(bancoContaId, de, ate): Promise<ResumoDia[]>`, `enviarExtrato(file, conta): Promise<RespostaImport>`, `marcarConferido(arquivoId): Promise<void>`. Tipos em `src/services/financeiroExtratoBancario.ts`.
- Comportamento:
  - Conta e mês em `useUrlState`.
  - Upload: `supabase.storage.from('banco-extratos').upload(...)` → `functions.invoke('banco-extrato-importar')`, via `useMutationComRegistro`.
  - Toast por `status`/`motivo`, com texto pt-BR por motivo (mapa exaustivo e `never` no default).
  - Lista de arquivos: status, motivo, período, linhas novas e botão "Conferi" (só para `aceito` ainda não conferido).
  - Resumo diário: data, créditos, débitos, saldo do dia, coluna Omie (Task 9). Dia não coberto mostra **"indisponível"**, nunca R$ 0,00.
  - Sensores: `banco.extrato_importado` no `aceito` (chave = `arquivo_id`) e `banco.extrato_conferido` no clique, cada um com `track()` + `registrarNoLedger()`.

- [ ] **Step 1: Testes vermelhos:**
  - `ResumoDiarioExtrato` com `{coberto:false, creditos:null}` renderiza `'indisponível'` e não renderiza `'R$ 0,00'`
  - com `{coberto:true, creditos:0}` renderiza `'R$ 0,00'`
  - o mapa de motivo cobre todos os valores de `motivo` (o teste itera a união)
  - `resumoDia` chama a RPC com `p_de`/`p_ate` e não usa `.from('banco_extrato_linha')`
- [ ] **Step 2: Rodar** → FAIL. **Step 3: Implementar. Step 4:** `heavy bun run test`, `heavy bun run typecheck`, `bun lint` → exit 0.
- [ ] **Step 5: Commit** `feat(banco): tela de extrato bancário (upload, arquivos, resumo diário) [Publish]`.

### Task 9: Lado Omie (movimento realizado por dia), calibrado antes de aparecer

**Files:**
- Create: `src/lib/financeiro/extrato/omie-realizado.ts` + teste
- Modify: `supabase/migrations/<ts>_banco_extrato_f1.sql` (RPC `banco_extrato_omie_dia(p_banco_conta_id, p_de, p_ate) RETURNS TABLE(data, creditos_centavos, debitos_centavos, regra_versao text)`, `SECURITY INVOKER`, somando as N `omie_ncodcc` de `banco_conta_omie`)
- Modify: `ResumoDiarioExtrato.tsx`, prova SQL

- [ ] **Step 1: Descoberta (só leitura), sem código:** em `fin_movimentacoes`, a `natureza` mistura previsões (`VENR`/`VENP`, muitas com `valor = 0`), baixas (`BAXR`/`BAXP`), manuais (`MANR`/`MANP`), `COMP`, `RPTR`/`RPTP` e `API*`. Ler `docs/agent/financeiro.md` (data de baixa: `omie_ncodbaixa`, `data_pagamento_omie`/`data_credito_omie`) e propor a regra "movimento realizado no dia D" com a data efetiva, nunca o vencimento. Escrever a regra no topo do arquivo, com `regra_versao = 'v1'`.
- [ ] **Step 2: Calibração com o arquivo real (Task 10):** num período já conferido à mão pelo financeiro, a soma diária Omie pela regra tem de bater com o extrato nos dias em que a baixa foi feita. Registrar no PR o denominador (dias que batem ÷ dias cobertos).
- [ ] **Step 3: Prova SQL:** `t9_omie_dia_soma_pix_itau` (a "Pix Itaú" entra na soma) e `t9_omie_dia_ignora_previsao_valor_zero`.
- [ ] **Step 3b: Casos que a regra precisa tratar,** cada um com teste SQL:
  - `t9_ignora_baixa_cancelada` (o espelho preserva baixas canceladas);
  - `t9_previsao_valor_positivo_nao_e_realizado`;
  - `t9_creditos_e_debitos_calibrados_separadamente`.
- [ ] **Step 4: Gate de exibição (fail-closed):** a coluna Omie só aparece quando a calibração registrada (tabela `banco_regra_calibracao(regra_versao, banco_conta_id, de, ate, dias_conferidos, dias_batem_creditos, dias_batem_debitos, divergencias_explicadas)`) tiver **todos** os dias cobertos do período batendo em créditos **e** em débitos, ou cada divergência explicada. Senão, a coluna mostra "indisponível (regra não calibrada)". Teste do componente para os dois estados.
- [ ] **Step 5: Commit** `feat(banco): movimento Omie realizado por dia ao lado do extrato`.

### Task 9b: Foto diária do saldo Omie e diferença do corte

**Files:**
- Modify: `supabase/migrations/<ts>_banco_extrato_f1.sql`, com:
  - tabela `fin_saldo_conta_diario(company, omie_ncodcc, data date, saldo_centavos bigint, fotografado_em timestamptz, PRIMARY KEY(company, omie_ncodcc, data))`, com RLS `fin_user_can_access`;
  - função `fin_fotografar_saldos()`, que faz `INSERT … SELECT` de `fin_contas_correntes` com `saldo_data` e `round(saldo_atual*100)`, com `ON CONFLICT DO NOTHING` e `saldo_atual IS NULL` → não grava;
  - job `pg_cron` diário às 05:00 America/Sao_Paulo (08:00 UTC), depois do sync das 03h. É SQL puro, sem `net.http_post`.
- Modify: RPC `banco_extrato_resumo_dia`, acrescentando a coluna `saldo_omie_centavos` (Σ das N contas na data; `NULL` se faltar foto de qualquer uma).
- Modify: `ResumoDiarioExtrato.tsx`, com o bloco "Diferença do corte" (saldo Itaú − saldo Omie na data de corte, `NULL` → "indisponível").
- Modify: prova SQL.

- [ ] **Step 1: Prova vermelha:**
  - `t9b_foto_idempotente`
  - `t9b_saldo_null_nao_vira_zero`
  - `t9b_resumo_null_se_falta_uma_das_n_contas`
  - `t9b_soma_pix_itau`
- [ ] **Steps 2–4:** implementar → verde → falsificar (`COALESCE(saldo,0)` → `t9b_resumo_null…` vermelho).
- [ ] **Step 5: Commit** `feat(banco): foto diária do saldo Omie e diferença do corte`.

### Task 10: Prova com arquivo real e checklist de deploy

- [ ] **Step 1:** com o extrato real da Oben (no scratchpad, **fora do repo**), rodar os parsers via um script local `scripts/` não versionado ou um teste `.skip` local:
  - o arquivo fecha?
  - quantas linhas?
  - o FITID é estável? Exportar 2 períodos sobrepostos e comparar os ids dos dias em comum.

  Registrar só os números agregados no PR, sem nenhum dado da conta.
- [ ] **Step 2:** importar pelo fluxo completo, no ensaio local, o primeiro arquivo, o segundo com sobreposição e um terceiro fora de ordem, e conferir que a `estrategia_chave` decidida na Task 0 não gera `sobreposicao_divergente` falso.
- [ ] **Step 3: Deploy, na ordem:**
  1. Migration via `bun run db:aplicar --ensaio` → `db:aplicar` no envelope, ou o founder no SQL Editor.
  2. Postcondição conferida por `psql-ro`.
  3. Deploy da edge `banco-extrato-importar` e sonda humana da 1ª atestação.
  4. Publish.

  Conferir com `bun run pendencias:deploy`.
- [ ] **Step 4: Sinal da F1 (critério para a F2):** query no ledger de `banco.extrato_conferido` ≥ 1 para a conta Itaú Oben, num período real completo, com o denominador de dias cobertos ÷ dias do período.

---

## Apêndice — Task 9, Step 1: descoberta (regra v1, NÃO calibrada)

> Medido em prod via `psql-ro` (só leitura, agregados) em 2026-11-21. Nada disto vira código na F1: a RPC `banco_extrato_omie_dia`, a tabela `banco_regra_calibracao` e o gate de exibição esperam a calibração com o extrato real (Tasks 0/10). Até lá a coluna Omie mostra "indisponível (regra não calibrada)".
>
> Achado lateral: as transferências (TRAR/TRAP) somem do espelho a partir de jul/2026 (oben: 93 em jun → 0 em jul, 4 em ago, 0 depois; colacor: 0 desde jul). Pode ser mudança de operação ou falha de sync; investigação fora da F1.

### 2. Regra v1 proposta

```sql
-- regra_versao = 'v1' — movimento Omie REALIZADO por dia e por sentido
-- Entra: ótica CONTA CORRENTE, naturezas de caixa, valor > 0, com data efetiva.
WITH contas AS (
  SELECT bco.company, bco.omie_ncodcc
    FROM public.banco_conta_omie bco
   WHERE bco.banco_conta_id = p_banco_conta_id
),
linhas AS (
  SELECT m.id, m.company, m.omie_ncodcc, m.natureza, m.valor,
         m.omie_codigo_lancamento, m.omie_ncodbaixa, m.updated_at, m.created_at,
         m.categoria_descricao AS grupo,
         COALESCE(m.data_credito_omie, m.data_pagamento_omie) AS data_efetiva
    FROM public.fin_movimentacoes m
    JOIN contas c ON c.company = m.company AND c.omie_ncodcc = m.omie_ncodcc
   WHERE m.categoria_descricao IN ('CONTA_CORRENTE_REC', 'CONTA_CORRENTE_PAG')
     AND m.natureza IN ('BAXR', 'APBR', 'TRAR', 'EXTR',      -- créditos
                        'BAXP', 'APEP', 'TRAP', 'EXTP')      -- débitos
     AND m.valor > 0
     AND COALESCE(m.data_credito_omie, m.data_pagamento_omie) BETWEEN p_de AND p_ate
),
-- versões da MESMA baixa: uma linha por (empresa, título, nCodBaixa), a observada por último
baixas AS (
  SELECT DISTINCT ON (l.company, l.omie_codigo_lancamento, l.omie_ncodbaixa) l.*
    FROM linhas l
   WHERE l.omie_ncodbaixa IS NOT NULL
   ORDER BY l.company, l.omie_codigo_lancamento, l.omie_ncodbaixa,
            l.updated_at DESC NULLS LAST, l.created_at DESC NULLS LAST, l.id DESC
),
sem_id AS (SELECT l.* FROM linhas l WHERE l.omie_ncodbaixa IS NULL),
atuais AS (SELECT * FROM baixas UNION ALL SELECT * FROM sem_id),
validas AS (
  SELECT a.*
    FROM atuais a
   WHERE
     -- baixa cancelada: o título voltou a aberto/cancelado e a baixa sobrou no espelho
     NOT (a.natureza IN ('BAXR', 'APBR') AND EXISTS (
            SELECT 1 FROM public.fin_contas_receber r
             WHERE r.company = a.company AND r.omie_codigo_lancamento = a.omie_codigo_lancamento
               AND r.status_titulo NOT IN ('RECEBIDO', 'PAGTO PARCIAL')))
     AND NOT (a.natureza = 'BAXP' AND EXISTS (
            SELECT 1 FROM public.fin_contas_pagar p
             WHERE p.company = a.company AND p.omie_codigo_lancamento = a.omie_codigo_lancamento
               AND p.status_titulo NOT IN ('PAGO', 'PAGTO PARCIAL')))
     -- transferência entre duas contas Omie da MESMA conta bancária (ex.: "Pix Itaú" ↔ Itaú)
     AND NOT (a.natureza IN ('TRAP', 'TRAR') AND EXISTS (
            SELECT 1 FROM public.fin_movimentacoes o
              JOIN contas c2 ON c2.company = o.company AND c2.omie_ncodcc = o.omie_ncodcc
             WHERE o.company = a.company
               AND o.natureza = CASE a.natureza WHEN 'TRAP' THEN 'TRAR' ELSE 'TRAP' END
               AND o.omie_ncodcc <> a.omie_ncodcc
               AND o.valor = a.valor
               AND COALESCE(o.data_credito_omie, o.data_pagamento_omie) = a.data_efetiva))
)
SELECT v.data_efetiva AS data,
       COALESCE(round(sum(v.valor) FILTER (WHERE v.grupo = 'CONTA_CORRENTE_REC') * 100), 0)::bigint AS creditos_centavos,
       COALESCE(round(sum(v.valor) FILTER (WHERE v.grupo = 'CONTA_CORRENTE_PAG') * 100), 0)::bigint AS debitos_centavos,
       'v1'::text AS regra_versao
  FROM validas v
 GROUP BY v.data_efetiva
 ORDER BY v.data_efetiva;
```

Dia sem linha na saída = **sem dado**, não "R$0": a RPC não deve gerar série densa com zeros, e a tela trata dia ausente como ausente. O `COALESCE(...,0)` só vale dentro de um dia que tem movimento no outro sentido.

### 3. Decisões e justificativa

1. **Só a ótica `CONTA_CORRENTE_*` (`categoria_descricao`).** Q3: o mesmo pagamento aparece de novo em `CONTA_A_RECEBER`/`CONTA_A_PAGAR` com valor>0 (≈43 mil créditos e ≈15 mil débitos "RECEBIDO/PAGO"). Somar por `natureza` sem esse filtro dobra o caixa. É o filtro mais importante da regra.
2. **Lista positiva de naturezas** (BAXR, APBR, TRAR, EXTR / BAXP, APEP, TRAP, EXTP). Q3: na ótica CC, toda linha de origem de inclusão (APIR/MANR/VENR/DEVR/RPTR, DEVP/COMP/MANP/RPTP/BARP/CTEP/IMPP) tem `valor = 0` em 100%. Lista positiva (e não "tudo menos X") porque natureza nova não deve entrar sozinha no número.
3. **`valor > 0`** — cobre `t9_omie_dia_ignora_previsao_valor_zero`; redundante com (1)+(2) hoje, fica como cinto.
4. **Previsão com valor positivo não é realizado.** Q3: `PREVISAO_PEDIDO_VENDA`/`PREVISAO_ORDEM_SERVICO` têm valor>0 em 836 de 886 linhas e nenhuma data efetiva; saem pelo grupo. Cobre `t9_previsao_valor_positivo_nao_e_realizado` — filtrar só por `valor > 0` deixaria essas linhas entrar.
5. **Data efetiva = `COALESCE(data_credito_omie, data_pagamento_omie)`; nunca `data_movimento`.** `data_movimento` cai em registro/previsão/vencimento quando falta o pagamento. `data_credito_omie` é a data da ótica do caixa e só existe em baixas; TRA*/EXT* só têm `data_pagamento_omie`. Onde as duas existem, nunca diferem (0 linhas). Linha sem nenhuma das duas (≈80 no total; 15 na conta Itaú da oben, todas de 2026) **fica fora** — não se inventa data.
6. **Sentido por grupo** (`_REC` = crédito, `_PAG` = débito), não por sinal: `valor` é `Math.abs` na ingestão e não há negativo no espelho.
7. **Dedupe de versão por `(company, título, omie_ncodbaixa)`**, última observação. Q4: 4 baixas duplicadas na oben. Mesmo critério da `v_titulo_baixas`.
8. **TRA*/EXT* entram sem dedupe.** Não têm título nem `nCodBaixa`. Os repetidos por (conta, data, valor) — 76 EXTP na colacor_sc, 50 na oben — podem ser tarifas idênticas legítimas no mesmo dia ou versões velhas; não há como distinguir. Deduplicar apagaria lançamento real; não deduplicar pode contar versão. Escolha v1: não deduplicar, e deixar a calibração dizer.
9. **Transferência entra** (TRAR crédito, TRAP débito): Q8 mostra que o Itaú é destino de transferências vindas de caixa, adquirente e outros bancos — é dinheiro que de fato pousa no extrato. **Só sai** a transferência entre duas contas Omie ligadas à mesma conta bancária (Pix Itaú ↔ Itaú: 2 pares medidos), que não existe no extrato.
10. **"Pix Itaú" entra na soma** por estar em `banco_conta_omie` — é onde caem APBR/BAXR de Pix (colacor 30 linhas em 2026). Cobre `t9_omie_dia_soma_pix_itau`. Atenção: na oben a conta com "pix" no nome é `AC/950`, não `CC/341`; o vínculo é decisão humana no cadastro, não inferência por nome.
11. **Baixa cancelada: fora quando o título hoje não está liquidado.** Q5c: 4 baixas de 2026 (~R$3.250) apontam para título `ATRASADO`/`CANCELADO`. `PAGTO PARCIAL` fica dentro (46 linhas, baixa parcial legítima). Limite conhecido: baixa cancelada **e refeita** (título volta a RECEBIDO) não é detectável e fica contada duas vezes. Cobre `t9_ignora_baixa_cancelada`.
12. **Créditos e débitos calibrados separadamente** (`t9_creditos_e_debitos_calibrados_separadamente`): os dois lados têm qualidade muito diferente (ver riscos 2 e 3). Recomendo que o gate de exibição permita mostrar um lado sem o outro, em vez de exigir os dois.

### 4. Riscos

1. **O Omie não espelha o extrato; espelha o que alguém baixou.** Na conta Itaú da oben em outubro não há nenhum EXT*/TRA* — tarifas, impostos, folha e qualquer débito sem título não aparecem. O total diário de débitos tende a ficar **abaixo** do extrato de forma estrutural.
2. **Débito é registrado com atraso** (p50 8 dias, p90 48, e 1 BAXP em novembro até o dia 21). Qualquer período recente vai divergir por atraso, não por erro de regra. A calibração precisa de janela fechada há ≥ 60–90 dias, e a tela não pode comparar débitos de dias recentes.
3. **Transferências somem do espelho a partir de jul/2026** (oben: de ~60/mês para 0). Ou a operação mudou, ou o sync deixou de trazê-las. Se for o sync, os créditos por transferência (R$1 milhão caixa→Itaú desde 2025 na oben) estão faltando no segundo semestre.
4. **Granularidade:** o banco credita em lote (cobrança, cartão, depósito do caixa); o Omie tem uma baixa por título. O total do dia pode bater sem que as linhas batam — e vice-versa quando a data de baixa no Omie é a do pagamento do cliente e o crédito cai em D+1/D+2. Há 22 linhas de 2026 com data efetiva em sábado/domingo.
5. **Dinheiro baixado em outra conta:** baixas em `CX` e `AC` só chegam ao Itaú por transferência (ver risco 3). Com a transferência ausente, esse crédito do extrato fica sem par.
6. **Sem identidade em TRA*/EXT*:** versões velhas não são separáveis de lançamentos repetidos legítimos (decisão 8).
7. **Estorno perde o sinal** (`Math.abs`) e baixa cancelada-e-refeita conta em dobro (decisão 11). Não mensurável pelo espelho.
8. **Linhas sem data efetiva** (15 na conta Itaú da oben em 2026) ficam fora até a releitura — subcontagem pequena e silenciosa; vale expor a contagem ao lado do número.
9. **`conciliado` é sempre `false`** — não há marca de conciliação do Omie para usar como segunda fonte.

### 5. Perguntas que só a calibração com o extrato real (Task 0/10) responde

1. Nos dias conferidos, créditos Omie = créditos do extrato? E débitos? (denominador: dias que batem ÷ dias cobertos, por lado.)
2. A data de baixa no Omie é a do crédito em conta ou a do pagamento pelo cliente (boleto D+1, cartão D+N)? Existe deslocamento sistemático?
3. Tarifas, impostos, folha e débitos automáticos aparecem em algum lugar do Omie para o Itaú, ou ficam só no extrato? (define se débito é comparável.)
4. Por que TRA* para em jul/2026 — mudança de processo ou falha de sync?
5. Os EXTP repetidos (mesma conta/data/valor) são tarifas idênticas reais ou versões velhas?
6. Quais `omie_ncodcc` compõem cada conta bancária (a "Pix Itaú" é a mesma conta do Itaú? e a `AC/950` com "pix" da oben?).
7. O crédito de cobrança/cartão chega líquido de tarifa no extrato enquanto o Omie baixa o bruto?
8. As 4 baixas de título `ATRASADO`/`CANCELADO` são mesmo canceladas? Há cancelada-e-refeita no período conferido?
9. Depósito do caixa: entra no extrato como um crédito único que corresponde a uma TRAR, ou a várias baixas em `CX`?
10. Qual a idade mínima de um dia para o lado débito ser considerado "fechado" no Omie?

## Apêndice — Task 0 medida: parser OFX v2 no layout real do Bankline (R22–R26)

A T0 mediu os dois OFX reais da Oben (só agregados, sem conteúdo no repo). Os dois eram recusados (`BRANCHID ausente`) e, atrás disso, as linhas de saldo virariam 29 lançamentos fabricados. Decisões, já implementadas em `parser-ofx.ts` (e no espelho da edge, v1.2):

- **R22, sem BRANCHID:** com BANKID 341/0341 e ACCTID de exatamente 10 dígitos, agência = 4 primeiros e conta com DV = 6 restantes. Qualquer outra forma → `campo_ausente`. Um corte errado vira `conta_divergente` na RPC. Conferido em prod que as 3 contas cadastradas têm agência de 4 e conta de 6 dígitos.
- **R23, linhas de SALDO:** allowlist exata, já normalizada: `SALDO ANTERIOR` e `SALDO TOTAL DISPONIVEL DIA` (o rótulo real; "SALDO DIA" no briefing é abreviação). Qualquer outra descrição começando com `SALDO` → `formato_desconhecido`.
  - O `SALDO ANTERIOR` precisa ser único e datado de DTSTART−1. Vira `saldoInicialCentavos`.
  - O `SALDO DIA` precisa ser único por dia, cair dentro do período e aparecer em todo dia com movimento e só nele. Senão, recusa.
  - Encadeamento obrigatório: anterior + Σ do dia = SALDO DIA de cada dia (`valor_invalido` se não fechar). O saldo final é o último SALDO DIA.
  - SALDO DIA sem SALDO ANTERIOR → `campo_ausente`.
- **R24, LEDGERBAL:** o Bankline manda o saldo de HOJE (DTASOF = DTSERVER). Ele só vale como saldo final quando o DTASOF cai em `periodoFim`. Com SALDO DIA presente, o SALDO DIA manda. Sem SALDO DIA e com DTASOF fora do fim → `campo_ausente`.
- **R25, encoding:** se os bytes forem UTF-8 válido, decodifica como UTF-8. Senão, usa o 1252 declarado.
- **R26, chave:** `estrategia_chave` segue `tupla`, porque o FITID é posicional e houve colisão entre exportações. CHECKNUM == FITID → `documento = null`. O `idBancario` segue sendo o FITID, só como informação.
- **Efeito:** o arquivo do Bankline se ancora sozinho (`saldo_inicial_centavos` presente → a RPC fecha em centavos e confere a continuidade). A âncora manual vira só conferência externa.
- **Endurecimento pela 2ª opinião (Codex, REPROVA → corrigido):**
  - Arquivo sem `</BANKTRANLIST>`, `</STMTRS>` ou `</OFX>` → recusa por truncamento. Com SALDO DIA, o LEDGERBAL, que vem depois da lista, deixou de proteger contra arquivo cortado.
  - O rótulo de SALDO é procurado como palavra no MEMO **e** no NAME. MEMO e NAME divergentes, ou com prefixo, → recusa.
  - Mais de um LEDGERBAL → recusa.
  - O SALDO DIA precisa ser a última linha do dia e ter TRNTYPE coerente com o sinal.
  - O DTASOF à meia-noite só vale no instante do DTEND exclusivo.
  - Quando o LEDGERBAL é do mesmo corte do fim do período, ele precisa bater com o SALDO DIA.
  - REFNUM == FITID também anula o documento.
  - O corte 4+6 só vale com o BANKID cru `341`/`0341`.
- **Risco residual aceito (registrado no PR):**
  - Um 1252 legítimo que por acaso seja UTF-8 válido seria lido como UTF-8.
  - Na sobreposição, sem documento estável, a troca de uma linha por outra de mesmo valor e mesmo dia não é vista pela tupla. A descrição fica fora da chave por desenho da RPC; é follow-up, não muda neste PR.
