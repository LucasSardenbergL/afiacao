# Radar: acesso de vendedor, dono temporário do lead, telefone compartilhado e modo discagem (frente 2)

> Spec da frente 2 do plano de melhorias do Radar (brainstorm Codex + Fable, depois da medição de
> `docs/historico/radar-uso-e-recorte-cnae-2026-10-28.md`). Fatos de prod medidos por `psql-ro` em
> 2026-10-29. Decisões do founder em 2026-10-29: (1) vendedores entram; (2) o vendedor registra contato,
> assume lead e cadastra no Omie em 1 clique, mas cadastro em massa, resolver conflito e atribuir tarefa
> ficam com gestor/master; (3) o "em atendimento" expira em 7 dias sem toque.

## Problema

O gate do Radar é a inteligência comercial da carteira: `pode_ver_carteira_completa` / `private.cap_carteira_ler`,
que valem para `master` ou `employee` com `commercial_role` em `gerencial`/`estrategico`/`super_admin`.
Staff real: 1 master e 2 `employee/farmer`, **os dois** na lista `sales_only_cpfs`. O vendedor ativo
não abre o Radar: o item de menu (`gestorComercialOuMaster`) fica escondido, ele está em "Gestão"
(que o sales-only não vê) e toda RPC/policy recusa.

`pode_ver_carteira_completa` protege a carteira inteira em dezenas de RPCs e **não pode** ser afrouxada.
Os dados do Radar, por outro lado, são dados públicos da RFB (CNAE, endereço, telefone e e-mail da empresa),
mais o estado de prospecção. Não há valor de cliente, custo nem margem.

## Desenho

### 1. Capability própria `private.cap_radar_prospectar(uuid)`

```
_uid IS NOT NULL AND (
  has_role(_uid,'master')
  OR (has_role(_uid,'employee') AND EXISTS (commercial_roles cr WHERE cr.user_id=_uid
       AND cr.commercial_role IN ('gerencial','estrategico','super_admin','farmer','hunter','closer')))
)
```
COALESCE para `false`. `LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public`, dono `postgres`,
ACL igual à de `private.cap_carteira_ler` (`authenticated` e `service_role`, sem `PUBLIC`/`anon`). `operacional`
fica de fora. A função é **nova**: nenhuma existente muda de significado.

### 2. Troca de gate (reescrita do corpo VIVO, sem colar corpo)

Para cada RPC abaixo: TRAVA (`ALTER FUNCTION … <volatilidade viva>`) → PRE (md5 EXATO do `prosrc` vivo =
o medido) → `replace()` literal da linha de gate + da mensagem → `EXECUTE` do `pg_get_functiondef`
alterado → guards (padrão casou exatamente 1×; nenhuma sobra de `pode_ver_carteira_completa`/`cap_carteira_ler`)
→ PÓS (md5 do `prosrc` = o md5 esperado, calculado offline a partir do vivo). `CREATE OR REPLACE` preserva
o ACL. Mesmo assim, reemitimos `REVOKE EXECUTE … FROM PUBLIC, anon` e `GRANT … TO authenticated, service_role`.

| RPC | gate vivo → novo |
|---|---|
| `radar_kpis()` | pvcc(v_uid) → cap_radar_prospectar(v_uid) |
| `radar_contagem_por_municipio(…10 args)` | pvcc((SELECT auth.uid())) → cap |
| `radar_estado_cadastro_omie(text)` | pvcc(v_uid) → cap |
| `radar_irmaos_por_raiz(text[])` | cap_carteira_ler(auth.uid()) → cap |
| `radar_prospects_para_rota(text,int)` | pvcc((SELECT auth.uid())) → cap (o roteirizador do vendedor passa a ver prospects) |
| `radar_registrar_cadastro_omie_v2(text,text,bool)` | pvcc(v_uid) → cap (1 clique) |
| `radar_registrar_cadastro_omie(text,text,bool)` (v1) | pvcc(v_uid) → cap, **e** `REVOKE EXECUTE FROM authenticated` (ver 2a) |
| `radar_registrar_conflito_cadastro(…4)` | pvcc(v_uid) → cap (o fluxo de 1 clique grava a divergência que viu) |
| `radar_salvar_geocode(…4)` | pvcc(v_uid) → cap (cache de lat/lng) |
| `registrar_contato_radar(text,text,text)` | pvcc(v_uid) → cap |

Ficam **gestor/master** (sem mudança): `radar_resolver_conflito_cadastro`, `radar_atribuir_tarefa`
(o módulo `tarefas` está congelado). `desfazer_contato_radar` não tem gate de papel (só desfaz o próprio
contato dos últimos 5 min) e fica como está. `carteira_por_municipio` é da carteira e fica fora.

**2a. v1 do cadastro:** a v2 chama a v1 (`r := public.radar_registrar_cadastro_omie(…)`), e a v1 confere o
gate com o `auth.uid()` do caller, então precisa da capability nova também. Só que a v1 chamada **direto**
pula a checagem "conflito ABERTO bloqueia o CNPJ" da v2. Nenhum caller do app chama a v1 (o front usa só a v2;
edges não chamam). Por isso a v1 perde `EXECUTE` de `authenticated`; a v2 (SECDEF, dona `postgres`) continua
chamando. Isso também aperta o gestor na chamada direta, que ninguém usa.

**2b. Cadastro em massa:** o lote do front chama a mesma v2 em laço (`useRadarLote`), e o servidor não
distingue "massa" de "1 clique". A edge `omie-cliente` é `authorizeCronOrStaff`, e o vendedor já cadastra
cliente no Omie pelo fluxo normal de vendas. O botão de massa fica escondido para não-gestor na UI. Aceitamos
que essa barreira é **cosmética**: um vendedor que chamar a v2 em laço faz N cadastros legítimos, cada um com a
trava, o lookup e o registro de conflito da v2. Isso não dá poder novo, só volume. (Pergunta ao Codex: vale um
teto diário por uid na v2?)

### 3. Policies de leitura

`ALTER POLICY … USING ((SELECT private.cap_radar_prospectar((SELECT auth.uid()))))` (InitPlan) em:
`radar_empresas`, `radar_contatos`, `radar_ingest_state`, `radar_municipios`, `radar_situacao_cadastral`
(esta usava `pode_ver_carteira_completa` sem o wrapper). `radar_cadastro_conflitos` **fica** em
`cap_carteira_ler` (quem resolve é o gestor; o vendedor vê o conflito do lead pela `radar_estado_cadastro_omie`).
Nenhuma das tabelas tem policy de escrita (escrita só por RPC SECDEF). O nome `_select_gestor` fica, com
`COMMENT ON POLICY`.

Contrato de RLS: `LACUNAS_POR_GRUPO` (`scripts/authz-rls-esperado.ts`) declara 22 tabelas no grupo
`cap_carteira_ler`. 5 saem dele e o md5 muda. Vamos re-medir em prod depois do apply e atualizar no mesmo PR,
com um grupo novo para `cap_radar_prospectar`.

### 4. Dono temporário do lead: `radar_atendimentos`

```
id bigint identity PK, cnpj text NOT NULL REFERENCES radar_empresas(cnpj),
dono_user_id uuid NOT NULL, assumido_em timestamptz NOT NULL DEFAULT now(), renovado_em timestamptz,
encerrado_em timestamptz, encerrado_por uuid,
motivo_encerramento text CHECK IN ('liberado','expirado','gestor_liberou'),
CHECK ((encerrado_em IS NULL) = (motivo_encerramento IS NULL))
UNIQUE (cnpj) WHERE encerrado_em IS NULL
```
- **Expiração calculada na leitura, sem escrita periódica:** `ultimo_toque = GREATEST(assumido_em, renovado_em,
  max(radar_contatos.created_at) do dono naquele cnpj desde assumido_em)`, `expira_em = ultimo_toque + 7 dias`.
  Ativo ⇔ `encerrado_em IS NULL AND expira_em > now()`. Registrar contato renova sem tocar
  `registrar_contato_radar` (essa RPC é da frente 3).
- **1 escritor:** `radar_definir_atendimento(p_cnpj text, p_acao text)` com `p_acao ∈ {assumir, liberar}`.
  Gate `cap_radar_prospectar`, `auth.uid()` não nulo, trava `radar_empresas … FOR UPDATE` (serializa por cnpj).
  - `assumir`: se o aberto expirou, fecha como `expirado` (`encerrado_em = expira_em`); se o aberto é do caller,
    renova (`renovado_em = now()`); se é de outro e está ativo, devolve `{ok:false, motivo:'em_atendimento', dono_nome,
    expira_em}`. `ja_cliente` devolve `{ok:false, motivo:'ja_cliente'}`. Senão insere.
  - `liberar`: o dono fecha como `liberado`; gestor/master (`pode_ver_carteira_completa`) fecha o de outro como
    `gestor_liberou`; outro vendedor recebe `{ok:false, motivo:'nao_e_dono'}`. Sem aberto ativo, `{ok:true, ja_livre:true}`.
- **Leitura:** `radar_atendimentos_ativos()` SECDEF STABLE gateada, `RETURNS TABLE(cnpj, dono_user_id, dono_nome,
  assumido_em, expira_em, eh_meu)`. A lista e a ficha compartilham a mesma query (react-query deduplica).
- **Tabela fechada:** RLS ligada e sem policy; `REVOKE ALL … FROM PUBLIC, anon, authenticated`; `service_role` só
  com `SELECT` (placar da frente 3). Escrita só pela RPC (dona `postgres`).
- O aviso é **consultivo**: não bloqueia `registrar_contato_radar` de outro vendedor. A UI avisa
  "em atendimento por X até dd/mm".

### 5. Telefone compartilhado

`radar_telefone_compartilhado(p_cnpj text) RETURNS TABLE(telefone text, outras_raizes int)`, SECDEF STABLE gateada.
Para cada `telefone1`/`telefone2` não nulo do lead: `count(DISTINCT left(cnpj,8))` em `radar_empresas` com o mesmo
texto em `telefone1` **ou** `telefone2`, excluída a raiz do próprio lead. Medido: 23.369 números aparecem em ≥2 raízes,
1.740 em ≥5, 65 em ≥20 (máx. 267, provável contador). O formato é uniforme (`(DD) NNNNNNNN` em 552.727 de 556k),
então o casamento é pelo texto. Índices novos: `idx_radar_empresas_tel1 (telefone1) WHERE telefone1 IS NOT NULL` e
o mesmo para `telefone2`. A UI mostra "este número aparece em N empresas de raízes diferentes" como **aviso**.
Nunca classifica o número como inválido.

### 6. Front

- `src/lib/radar/acesso.ts` (puro): `podeProspectarRadar(role, commercialRole)` e `podeGerirRadar` espelham o servidor.
  Isso é cosmético: a fronteira é o banco.
- `AppShell`: o item do Radar sai de "Gestão" e entra em "Vendas" (o sales-only vê) com a flag `radarProspectar`.
  A lente usa `display*`.
- `useRadarKpis`: `enabled` por `podeProspectarRadar` real (`useAuth`).
- Ficha: chip "em atendimento por X até dd/mm" + Assumir/Liberar; aviso de telefone compartilhado; **modo discagem**
  (toggle persistido em localStorage): painel com o telefone grande, Ligar (`BotaoLigar`, já gateado pela lente na fonte e
  no `WebRTCCallContext`), os desfechos (`RadarOutcomeMenu`) e "Próximo". Toda escrita fica `disabled` com
  `isImpersonating`. "Criar tarefa" fica escondido para não-gestor.
- Linha: chip "em atendimento por X" (ou "com você").

## Provas (PG17, executando)

`db/test-radar-acesso-vendedor.sh` no núcleo: carrega o snapshot e os corpos VIVOS medidos (a prova monta
as funções pelo mesmo `replace` da migration sobre o `prosrc` de prod gravado em fixture). Papéis: master, gerencial,
farmer, operacional, customer e anon, sob `SET ROLE authenticated` + `request.jwt.claims`.
Matriz: cada RPC trocada × papel (farmer passa, operacional/customer recusa 42501/forbidden); policies (farmer lê
`radar_empresas`, customer 0 linhas); `resolver_conflito`/`atribuir_tarefa` seguem recusando o farmer; v1 sem
EXECUTE para `authenticated`; atendimento (assumir, conflito com outro, renovar, expirar por tempo, contato
renova, liberar dono/gestor/outro, 1 aberto por cnpj sob corrida); telefone (conta raízes distintas, exclui a própria).
Controle verde na mesma invocação e falsificação: (a) cap sabotada para aceitar `operacional` → vermelho;
(b) policy sem a troca → farmer 0 linhas → vermelho; (c) expiração sem o contato → renovação vermelha.
