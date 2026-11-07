# Radar pacote D: levar o lead até o vendedor (e-mail semanal + card "Prospectar hoje"), 2026-11-06

> Pacote D da revisão Codex + Fable do Radar (A: defeitos da fila · B: entrada do vendedor · C: mapa e território ·
> D: este). Migration `20261106181000_radar_leads_ao_vendedor.sql` (**manual**), edge `dispatch-notifications`
> `v1.2-radar-leads-vendedor` (**deploy**), card e rota no front (**Publish**). Prova PG17
> `db/test-radar-leads-vendedor.sh`: 39 asserts, 31 sabotagens vermelhas no assert certo, nos dois locales.
> **O cron nasce DESLIGADO e nenhuma vendedora está ligada: ativar é decisão do founder.**

## A medição que decidiu a ordem (psql-ro + HogQL, 2026-11-06)

O roteirizador já consome leads do Radar (`radar_prospects_para_rota`). A pergunta era se a rota de visita seria o
ponto de adoção, e não a tela `/radar`. Não é: a rota nunca foi usada.

| Fonte | Medida | Resultado |
| --- | --- | --- |
| `pg_stat_user_tables.n_tup_ins` | `route_visits`, `visitas_agendadas`, `route_contact_log`, `route_queue_snapshot` | **0** nas quatro: nunca gravaram uma linha |
| PostHog, 60 dias | page views de `/admin/route-planner` e `/farmer` | **0** e **0** (no mesmo período `/radar` teve 24, de 1 usuário) |
| `analytics_outbox` (ledger, desde 30/10) | eventos de qualquer tipo das 2 farmers | **0** (os 44 `navegacao.rota_servida` são de 1 usuário, o master) |
| `telemetria_vitals` / `telemetria_probes` | linhas das 2 farmers | **0** / **0** |
| `radar_eventos` 60 dias | contato humano | **0** (64.299 contatos são da automação) |

A prospecção do roteirizador não persiste o lead (o `radarCnpj` do stop só vive na memória da tela), então mesmo um uso
futuro da rota não deixaria rastro: "quanto os prospects aparecem e são usados em rotas" é **0 medido** onde há
registro e **não mensurável** no resto.

**Carteira e região das vendedoras** (`carteira_assignments` elegível × `addresses` × `radar_municipios`, 100% dos
clientes casam com um município do Radar):

| Vendedora | Clientes | Municípios | Top 3 por clientes | Território (1 dono por município) |
| --- | --- | --- | --- | --- |
| Regina (farmer) | 1.570 | 60 | Divinópolis 358 · Nova Serrana 266 · Cláudio 187 | Divinópolis, Nova Serrana, Cláudio |
| Tatyana (farmer) | 1.272 | 52 | Divinópolis 223 · Carmo do Cajuru 195 · Itaúna 148 | Carmo do Cajuru, Itaúna, Pará de Minas |

Leads `a_contatar` não clientes nesses municípios: Divinópolis 677 (666 com score), Nova Serrana 174, Cláudio 140,
Carmo do Cajuru 106, Itaúna 261, Pará de Minas 341.

**Decisão:** as farmers não abrem o app; nenhuma tela alcança quem não entra nela. O e-mail é o único canal que chega
nelas fora do app (o WhatsApp e as tarefas estão congelados até 10/01/2027). **D1 primeiro**; D2 entra junto por ser
pequeno e reusar a mesma escolha, mas o card só vai ser visto quando alguém abrir `/farmer` (0 views em 60 dias).

## O que entrou

| Peça | O quê |
| --- | --- |
| `private.radar_territorio_do_vendedor(p_vendedor, p_top)` | Municípios onde o vendedor tem mais clientes da carteira elegível (endereço padrão, `norm_cidade` + UF). Cada município tem **um dono**, quem tem mais clientes nele (empate: menor uuid). Sem isso as duas farmers receberiam os mesmos leads de Divinópolis. Só disputa quem é vendedor de verdade (employee + farmer/hunter/closer): o master (12.690 clientes) e cargos residuais ficam fora. |
| `private.radar_leads_do_vendedor(p_vendedor, p_n, p_nao_repetir_desde, p_agora)` | Top-N por score no território (3 municípios), **uma empresa por raiz de CNPJ** (a filial de maior score; na prévia em prod o top-5 da Regina trazia a mesma metalúrgica 4 vezes). Fora: `ja_cliente`, status ≠ `a_contatar`, **sem score (fica fora, não entra como 0)**, situação RFB 03/04/08, dono temporário ativo de outro vendedor (mesma regra de `radar_atendimentos_ativos`). `elegiveis` = universo, o denominador do e-mail. |
| `public.radar_avisar_vendedores(p_agora)` + cron `radar-avisar-vendedores-semanal` | Segunda 11:00 UTC (08:00 BRT), **criado com `active = false`**. Para cada vendedor com `radar_email_vendedor_config.ativo`: 1 e-mail por semana com 5 leads, link `https://steu.lovable.app/radar/abrir/<envio>/<cnpj>` por lead, e o porquê ("maior score entre N empresas a contatar nesses municípios; ficam de fora…"). Nenhuma empresa (raiz de CNPJ) se repete para o mesmo vendedor em 90 dias. `email_teste` desvia para um destinatário de teste; esse envio não entra no denominador nem queima lead. Pulado (sem acesso, sem e-mail, sem território, sem leads, já enviado) sai com o motivo em `acoes_execucoes` (`radar.avisar_vendedores`). O e-mail sai pelo canal vivo: `fornecedor_alerta` → job 102 (`net.http_post`, `timeout_milliseconds := 60000`, a cada 30 min) → edge. |
| Edge `dispatch-notifications` v1.2 (`destinatario.ts`) | Alerta com linha em `radar_email_vendedor_envios` vai para o **vendedor** daquele envio, com corpo próprio e links clicáveis; o resto segue no `NOTIFICATION_EMAIL_TO`. O destinatário vem da tabela fechada ao JWT, nunca de coluna livre de `fornecedor_alerta` (staff escreve nela; seria um relay). Tabela ausente (edge antes da migration) não derruba os avisos do gestor; qualquer outra falha de leitura aborta antes do token. |
| `public.radar_prospectar_hoje(p_vendedor, p_n)` + card `ProspectarHojeCard` | Leitura **pura** (`STABLE`, na allowlist de leitura da lente) de 3 leads e do território. No painel `/farmer`, logo abaixo do SLA: nome, município, score e motivos, **Assumir** (dono temporário, `radar_definir_atendimento`) e **Abrir ficha** (`/radar?cnpj=`). Erro de leitura ≠ "sem leads" ≠ "sem território". Lente: lê a persona (o servidor exige gestor), Assumir desligado, nada gravado. |
| Sensor no ledger | `radar_email_vendedor_envios` (denominador do D1), `radar_lead_aberturas` (numerador: aberturas pelo link do e-mail ou pelo card, 1 por origem/cnpj/usuário/dia, com `do_destinatario`), `radar_prospectar_hoje_servido` (denominador do D2: dias em que o card mostrou ≥ 1 lead, gravado por `radar_registrar_card_servido`, bloqueada na lente). Todas com RLS, sem policy, REVOKE de PUBLIC/anon/authenticated. |
| Rota `/radar/abrir/:envio/:cnpj` (`RadarAbrirEmail`) | Grava a abertura (`radar_registrar_abertura_empurrada`) e redireciona para `/radar?cnpj=`. Link malformado ou lente: só redireciona. |

### Fora do escopo, de propósito

- **Telefone no e-mail.** Ligar direto do e-mail seria o caminho mais curto, mas a ligação ficaria invisível ao
  sensor; o telefone está na ficha, a um clique.
- **Deep link e "Meus atendimentos"**: pacote B (B5). Este pacote só **usa** o formato `/radar?cnpj=`.
- **Amostra de controle 1/10**: o e-mail empurra os de maior score, que ficam no grupo "topo" da coorte. A comparação
  topo × amostra passa a medir também o efeito do empurrão; registrado aqui para quem ler o placar da coorte.

## Desempenho medido em prod

A 1ª forma do território passava de 30 s no `psql-ro`: o cast `::text` nas colunas enum fazia o planejador estimar 1
linha de carteira (são 2.842) e casar endereço × município num laço aninhado (8 milhões de linhas descartadas). Com a
comparação direta no enum e o dono carregado junto do endereço, a mesma consulta executa em ~100 ms, e o top-5 com
filtros em 63 ms (`EXPLAIN ANALYZE`). Prévia do 1º e-mail da Regina: 5 de **977** empresas elegíveis em Divinópolis,
Nova Serrana e Cláudio, scores 94 a 86.

## Quando medir (query, não recado)

Denominador = e-mails reais notificados; numerador = envios com ≥ 1 abertura do próprio destinatário (psql-ro):

```sql
SELECT count(DISTINCT ab.envio_id) FILTER (WHERE ab.do_destinatario) AS envios_abertos,
       count(DISTINCT e.id)                                         AS envios_reais_notificados,
       count(ab.id) FILTER (WHERE ab.do_destinatario)               AS leads_abertos
  FROM public.radar_email_vendedor_envios e
  JOIN public.fornecedor_alerta a ON a.id = e.alerta_id AND a.status = 'notificado'
  LEFT JOIN public.radar_lead_aberturas ab ON ab.envio_id = e.id
 WHERE NOT e.eh_teste;

-- D2: dias com card servido × aberturas pelo card
SELECT (SELECT count(*) FROM public.radar_prospectar_hoje_servido)                                        AS dias_servidos,
       (SELECT count(*) FROM public.radar_lead_aberturas WHERE origem = 'card' AND do_destinatario) AS aberturas_card;
```

Fase seguinte (mais leads, outra cadência, WhatsApp depois de 10/01/2027) só com ≥ 1 envio aberto nesse placar.

## Deploy (2026-11-07)

| Camada | Estado | Evidência |
| --- | --- | --- |
| Migration `20261106181000` | ✅ aplicada pelo founder (SQL Editor) | validação via psql-ro: 5 tabelas com RLS, 6 funções, cron **desligado** |
| Edge `dispatch-notifications` v1.2 | ✅ deployada pela sessão (MCP do Lovable, pacote `666525a8657d`, 7/7 sha256 contra `76a10cdb`) | sonda `db/sonda-dispatch-notifications-2026-11-07.sql` (recibo #943): **DEPLOY CONFIRMADO**, fingerprint `ec5f06b8…`; `pendencias:deploy` exit 0 |
| 1º e-mail em modo TESTE | ✅ `db/radar-d1-teste-email-regina-2026-11-07.sql` (recibo #945; os bytes aplicados estão no commit `5315cea6a`, branch `claude/radar-d1-aplicados-2026-11-07`): config da Regina ligada com `email_teste` = founder; 5 de 972 elegíveis | alerta 614 `notificado` às 00:30 BRT; `net._http_response` 200 com `sucesso: 1` |
| Publish do front (card, rota `/radar/abrir`, deep link B5) | ✅ founder (2026-11-07) | `monitor-deploy.sh --pr 3678`: `PR_NO_AR`, o ar serve `b7fd8ae2` = `origin/main`; o `?cnpj=` do B5 (`RadarClientes.tsx`) está nesse build |
| Envio à vendedora real + cron | 🧭 decisão do founder | os passos 2 e 3 abaixo |

O envio de teste não entra no denominador e não queima lead: quando a Regina for ligada de verdade, ela recebe a lista
calculada naquela semana.

## Ativação (founder)

Pré-requisitos: migration aplicada, edge v1.2 publicada (sonda), **B5 (deep link) mergeado e publicado** (sem ele o
link grava a abertura e cai na lista do Radar, sem abrir a ficha).

1. Teste com destinatário seu (o e-mail traz os leads da Regina, marcado `[TESTE]`):
   `INSERT INTO public.radar_email_vendedor_config (vendedor_user_id, ativo, email_teste) VALUES ('700657a1-d75d-4c72-99b1-0a0f2065fa29', true, '<seu e-mail>') ON CONFLICT (vendedor_user_id) DO UPDATE SET ativo = true, email_teste = EXCLUDED.email_teste, atualizado_em = now();`
   e `SELECT public.radar_avisar_vendedores();` (o job 102 manda em até 30 min).
2. Para a vendedora real: `UPDATE public.radar_email_vendedor_config SET email_teste = NULL, atualizado_em = now() WHERE vendedor_user_id = '…';`
3. Ligar o cron: `SELECT cron.alter_job(job_id := (SELECT jobid FROM cron.job WHERE jobname = 'radar-avisar-vendedores-semanal'), active := true);`
