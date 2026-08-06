# Padrões de assert — prove-sql-money-path

Padrões copiáveis pras 3 famílias de assert + a falsificação. Todos assumem o `harness-template.sh`
(funções `P`/`Pq`/`ok`/`bad`/`eq` e `auth.uid()` lendo o GUC `test.uid`).

> **Lei #2:** todo caminho negativo captura a `SQLSTATE` ESPERADA e re-lança o resto. `WHEN OTHERS THEN 'OK'` é teatro.

---

## 1. Assert POSITIVO (o caminho feliz produz o efeito)

Rode/insira → leia o efeito → compare.

```bash
# RPC produz o estado esperado
Pq -c "SELECT public.aprovar_pedido_sugerido('PED-1'::uuid);" >/dev/null
V=$(Pq -c "SELECT status FROM public.pedido_compra_sugerido WHERE id='PED-1';")
eq "A1 aprovar seta status" "$V" "aprovado"

# money-path: o número certo
V=$(Pq -c "SELECT preco_unitario FROM public.pedido_compra_item WHERE pedido_id='PED-1' LIMIT 1;")
eq "A2 preco vem do cmc" "$V" "536.48"
```

---

## 2. Assert NEGATIVO (a defesa morde) — SQLSTATE + re-raise

O padrão de ouro: bloco `DO` que espera UMA condição de erro e relança qualquer outra. O `RAISE NOTICE`
final só roda se o erro **esperado** veio; se veio outro, o `WHEN OTHERS THEN RAISE` propaga e o
`ON_ERROR_STOP=1` derruba o harness.

> ⚠️ **Capture o stderr (`2>&1`).** O `RAISE NOTICE` da sentinela sai no **stderr** — sem `2>&1`, `$R`
> pega só os command tags (`SET`/`DO`) e a sentinela nunca casa (assert sempre vermelho). Pego rodando
> o smoke desta skill.

```bash
# Gate master nega employee (a RPC faz: RAISE EXCEPTION 'forbidden ...' → SQLSTATE P0001)
R=$(P -tA 2>&1 <<'SQL'
SET test.uid='22222222-2222-2222-2222-222222222222';  -- employee, não master
SET ROLE authenticated;
DO $$
DECLARE v_passou boolean := false;
BEGIN
  BEGIN
    PERFORM public.aprovar_versao_boletim('FO20.6827.00', '{}'::jsonb);
    v_passou := true;                            -- chegou aqui = o gate DEIXOU passar = BUG
  EXCEPTION
    WHEN insufficient_privilege OR raise_exception THEN NULL;  -- 42501/P0001 = o erro ESPERADO
    WHEN OTHERS THEN RAISE;                      -- qualquer outro erro: RELANÇA (não engole)
  END;
  -- decisão FORA do bloco EXCEPTION: a flag não colide com SQLSTATE nenhum
  IF v_passou THEN RAISE NOTICE 'GATE_ABERTO_BUG'; ELSE RAISE NOTICE 'GATE_OK'; END IF;
END $$;
SQL
)
case "$R" in
  *GATE_OK*)         ok  "A3 gate nega employee" ;;
  *GATE_ABERTO_BUG*) bad "A3 gate ABERTO — employee passou" ;;
  *)                 bad "A3 gate — resultado inesperado: $R" ;;
esac
```

> ⚠️ **Sentinela anti-teatro:** a string que você procura (`GATE_OK`) NÃO pode ser o texto que o
> código emite. Se o `RAISE EXCEPTION` do código diz `'forbidden: somente master'` e você grepa por
> `'forbidden'`, um `RAISE` espúrio em qualquer ponto casaria. Use uma sentinela **sua** (`GATE_OK`),
> emitida só no ramo `EXCEPTION` da condição certa.

> ⚠️ **Colisão de SQLSTATE — a mesma armadilha num ângulo que a leitura NÃO mostra** (achado Codex
> xhigh, #1417). Não sinalize "o gate não barrou" com `RAISE EXCEPTION 'GATE_NAO_BARROU'` **dentro do
> bloco cujo handler captura `raise_exception`**: `RAISE EXCEPTION` genérico levanta **P0001**, que é
> exatamente o SQLSTATE do `RAISE EXCEPTION 'forbidden…'` da RPC → o handler captura o **próprio
> sentinel** e o assert fica **VERDE com o gate escancarado**. A sentinela textual está correta e
> mesmo assim o teste mente — o conflito é de *código de erro*, invisível ao ler o texto.
> Por isso o padrão acima usa **flag booleana + `IF` fora do `EXCEPTION`**: uma variável não colide
> com SQLSTATE nenhum. (Se preferir exceção, dê ao sentinel uma SQLSTATE própria via
> `RAISE EXCEPTION … USING ERRCODE='22000'` e **não** a capture.)
>
> **O tell estrutural:** todo assert negativo precisa de uma **falsificação apontada a ele**. O
> harness do #1416 tinha sabotagem para os asserts de dinheiro e **nenhuma** para o do gate — e foi
> exatamente lá que o teatro sobreviveu. Assert sem sabotagem correspondente é candidato a falso-verde.

**SQLSTATEs comuns no repo** (use o nome da condição, é mais legível que o código):

| Defesa | Condição (`WHEN ...`) | Código |
|---|---|---|
| `RAISE EXCEPTION 'forbidden'` (gate) | `raise_exception` | `P0001` |
| CHECK (`minimo > 0`, status válido) | `check_violation` | `23514` |
| UNIQUE (1 vínculo/1 versão viva) | `unique_violation` | `23505` |
| NOT NULL | `not_null_violation` | `23502` |
| FK | `foreign_key_violation` | `23503` |
| REVOKE/grant (`permission denied`) | `insufficient_privilege` | `42501` |
| coluna/função inexistente (drift) | `undefined_column`/`undefined_function` | `42703`/`42883` |

Variante grossa (quando só importa "falhou", sem distinguir o erro): use `must_fail "<sql>" "<rótulo>"`
do template. **Prefira o bloco DO** quando o erro específico importa (quase sempre, no money-path).

---

## 3. Assert RLS (own-scope / staff / anon-deny)

`auth.uid()` lê o GUC `test.uid`; `SET ROLE authenticated` aplica as policies; `service_role` (BYPASSRLS)
semeia. Seed em ZONA 3 com `SET ROLE service_role`.

```bash
# Seed como postgres (superuser ignora RLS e TEM privilégio nas tabelas). NÃO use SET ROLE
# service_role p/ semear: BYPASSRLS ignora a RLS mas NÃO concede GRANT → "permission denied".
P -q <<'SQL'
INSERT INTO auth.users(id) VALUES
  ('11111111-1111-1111-1111-111111111111'),
  ('22222222-2222-2222-2222-222222222222'),
  ('33333333-3333-3333-3333-333333333333') ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles(user_id, role) VALUES
  ('33333333-3333-3333-3333-333333333333','master') ON CONFLICT DO NOTHING;
INSERT INTO public.minha_tabela(owner, valor) VALUES
  ('11111111-1111-1111-1111-111111111111', 10),
  ('22222222-2222-2222-2222-222222222222', 20);
-- migration do repo é --no-privileges (Supabase concede em runtime) → conceda p/ os asserts de RLS
-- lerem; a RLS filtra por cima. ⚠️ a policy é avaliada com os privilégios do CALLER: se ela faz
-- subselect noutra tabela (ex.: user_roles), conceda SELECT nela TAMBÉM, senão dá permission denied.
GRANT SELECT ON public.minha_tabela, public.user_roles TO authenticated, anon;
SQL

# tail -1: psql ecoa "SET" por cada SET → a contagem é a ÚLTIMA linha
OWN=$(Pq  -c "SET test.uid='11111111-1111-1111-1111-111111111111'; SET ROLE authenticated; SELECT count(*) FROM public.minha_tabela;" | tail -1)
STAFF=$(Pq -c "SET test.uid='33333333-3333-3333-3333-333333333333'; SET ROLE authenticated; SELECT count(*) FROM public.minha_tabela;" | tail -1)
ANON=$(Pq -c "SET ROLE anon; SELECT count(*) FROM public.minha_tabela;" | tail -1)
eq "A4 own-scope (cliente vê só a própria)" "$OWN"   "1"
eq "A5 staff vê tudo"                       "$STAFF" "2"
eq "A6 anon não vê nada"                    "$ANON"  "0"
```

> ⚠️ O psql é **superuser** — sem `SET ROLE`, ele BYPASSA a RLS e o teste vira teatro (vê tudo sempre).
> Prove RLS SEMPRE com `SET ROLE authenticated`/`anon` + GUC `test.uid`. (§10: a falsificação B3/A9 do
> KB existe porque sem o `SET ROLE` o assert de RLS não tinha dente.)

---

## 4. FALSIFICAÇÃO (Lei #3) — sabota → exija vermelho → restaura

A prova de que o assert tem dente: quebra a migração de propósito e mostra que o assert **pega**.
Padrão de 4 tempos.

```bash
echo "── falsificação ──"
# 1) SABOTA: recria a defesa NA VERSÃO FURADA (aqui: gate que sempre passa)
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.aprovar_versao_boletim(p_code text, p_payload jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $fn$
BEGIN
  -- GATE SABOTADO: removido o IF NOT is_master THEN RAISE
  INSERT INTO public.kb_product_spec_versions(product_code) VALUES (p_code);
END $fn$;
SQL

# 2+3) RE-RODA o MESMO assert A3 e EXIGE que agora ele FALHE (gate não barra mais)
R=$(P -tA 2>&1 <<'SQL'
SET test.uid='22222222-2222-2222-2222-222222222222'; SET ROLE authenticated;
DO $$ BEGIN
  PERFORM public.aprovar_versao_boletim('X', '{}'::jsonb);
  RAISE NOTICE 'SABOTAGEM_PASSOU';        -- com o gate furado, chega aqui (2>&1: NOTICE é stderr)
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'AINDA_BARRA'; END $$;
SQL
)
case "$R" in
  *SABOTAGEM_PASSOU*) ok "F1 falsificação: gate furado deixou employee passar (A3 tem dente)" ;;
  *) bad "F1 sabotei o gate e o teste NÃO mudou → A3 é fraco, conserte o assert" ;;
esac

# 4) RESTAURA a versão verdadeira (cirurgicamente — re-aplica só o que sabotou)
P -q -f "$REPO_ROOT/supabase/migrations/[[seu_slug]].sql"
# limpa a linha que a sabotagem inseriu, se poluir:
P -q -c "DELETE FROM public.kb_product_spec_versions WHERE product_code='X';" >/dev/null 2>&1 || true
```

**Regras da falsificação:**
- Sabota **uma defesa por vez** e exija que **o assert daquela defesa** vire vermelho. Não sabota tudo de uma vez.
- A sentinela (`SABOTAGEM_PASSOU`) é **sua**, nunca o texto do código (anti-teatro de ILIKE/position).
- **Restaure cirurgicamente** — re-aplicar a migração inteira costuma bastar; se a migração não for
  idempotente nesse ponto, recrie só o objeto sabotado na versão certa.
- ⚠️ **Ordem importa** ao restaurar trigger + dado: reverta o dado que a sabotagem inseriu ANTES de
  recriar um trigger append-only (senão o trigger barra a própria limpeza). (§10, lição do KB.)

### Falsificação para append-only / trigger

```bash
# DROPA o trigger guardião → EXIGE que o DELETE/UPDATE proibido agora PASSE (prova que o trigger guardava)
P -q -c "DROP TRIGGER IF EXISTS kbv_block_mutation ON public.kb_product_spec_versions;"
if P -q -c "DELETE FROM public.kb_product_spec_versions WHERE id='...';" >/dev/null 2>&1; then
  ok "F2 sem o trigger o DELETE passa (o trigger append-only tinha dente)"
else
  bad "F2 droppei o trigger e o DELETE AINDA falhou → o assert não provava o trigger"
fi
# restaura re-aplicando a migração
P -q -f "$REPO_ROOT/supabase/migrations/[[seu_slug]].sql"
```
