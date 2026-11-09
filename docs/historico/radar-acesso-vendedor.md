# Radar: acesso de vendedor, dono temporário, telefone compartilhado e modo discagem (frente 2, 2026-10-29)

> Frente 2 das melhorias do Radar que saíram do brainstorm Codex + Fable, depois da medição
> (`radar-uso-e-recorte-cnae-2026-10-28.md`: só o master acessava; 0 contato humano desde 15/06).
> Spec: `docs/superpowers/specs/2026-10-29-radar-acesso-vendedor-design.md`. Migration
> `20261029201200_radar_acesso_vendedor.sql`. Prova: `db/test-radar-acesso-vendedor.sh` (núcleo, 72 asserts,
> 12 sabotagens).

## O que mudou

- **Gate próprio `private.cap_radar_prospectar`**: master, gestor comercial (gerencial/estrategico/super_admin) ou
  vendedor (farmer/hunter/closer). `operacional`, employee sem cargo e customer com cargo residual ficam de fora.
  `pode_ver_carteira_completa` **não mudou**: continua protegendo a carteira nas dezenas de RPCs que a usam.
- **8 RPCs trocam de gate**, reescritas a partir do corpo VIVO (TRAVA → PRE por md5 exato → replace literal com
  guard de "casou 1×" → PÓS por md5): `radar_kpis`, `radar_contagem_por_municipio`, `radar_estado_cadastro_omie`,
  `radar_irmaos_por_raiz` (com gate de projeção), `radar_prospects_para_rota` (o roteirizador do vendedor passa a
  ver prospects), `radar_registrar_cadastro_omie_v2`, a v1 (chamada por dentro da v2) e `registrar_contato_radar`.
- **4 policies de leitura** (`radar_empresas`, `radar_contatos`, `radar_ingest_state`, `radar_municipios`) passam
  para a capability nova.
- **Dono temporário**: tabela `radar_atendimentos` (fechada para o JWT; único escritor `radar_definir_atendimento`;
  leitura `radar_atendimentos_ativos`). Expira 7 dias depois do último toque **válido** do dono. Teto de 100 posses
  por dono. Gestor libera a posse de outro.
- **Telefone compartilhado**: `radar_telefone_compartilhado` conta em quantas OUTRAS raízes de CNPJ o número aparece
  (índices novos em `telefone1`/`telefone2`). É aviso na ficha, nunca classificação.
- **Front**: o item do Radar sai de "Gestão" e entra em "Vendas" (os 2 vendedores são sales-only e só veem Vendas);
  `podeProspectarRadar`/`podeGerirRadar` espelham o servidor; chip "em atendimento por X" na linha; ficha com
  Assumir/Renovar/Liberar, aviso de telefone e **modo discagem** (telefone grande, Ligar, desfechos e Próximo num
  painel); "Criar tarefa" e "Conferi no Omie" só para gestor; conflito do lead lido pela RPC (a tabela segue gestor).

## Deploy (2026-10-30)

- **Migration aplicada** pelo founder via `bun run db:aplicar` (tentativa **#768**, sha256 `16000ed1…`, a mesma do ensaio
  contra prod). O apply pela sessão foi recusado pelo classificador de permissões e não foi contornado.
- **2ª testemunha (psql-ro, 00:2x UTC):** a pós-condição inteira vale em prod (`VALIDADO … OK`), com o marcador de fim. O A3
  (invocar `cap_radar_prospectar(NULL)`) troca para leitura do corpo, porque o `claude_ro` sem EXECUTE é o REVOKE funcionando.
  Os 8 corpos têm o md5 esperado.
- **Contrato:** `LACUNAS_POR_GRUPO` renovado (`cap_carteira_ler` 22 → 20, novo grupo `cap_radar_prospectar` com 4
  tabelas). As 8 RPCs reescritas entram no baseline do `deriva:corpo:prod` como `EDICAO_MANUAL` (o `alvosDePatch` não lê o
  laço). Carimbo regravado. Sobra 1 achado alheio: o grupo `fin_*` cresceu de 41 para 43 por outra entrega.

## O que o Codex pegou no desenho (max, 692 s) e o que foi feito

| Achado | Decisão |
|---|---|
| P1: `radar_registrar_conflito_cadastro` aceita relato livre (`lookup_ambiguo` sem evidência) e vira bloqueio GLOBAL do CNPJ | Fica gestor. O front já trata a recusa como aviso local "não sincronizado", e a v2 segue gravando RD001/RD002 conferidos pelo banco |
| P1: `radar_situacao_cadastral` guarda a situação de CLIENTES fora do Radar (o conjunto acompanhado é informação comercial) | Fica gestor. A ficha usa `radar_empresas.rfb_situacao*` |
| P1: `radar_irmaos_por_raiz` devolve nome e contagem de clientes só-Omie (`omie_clientes_nao_vinculados` é gestor-only) | Gate de projeção: o ramo `radar_docs_clientes()` só entra para quem passa em `cap_carteira_ler`; o vendedor vê os irmãos já-cliente que o próprio Radar mostra |
| P2: teto de cadastro em massa | Não precisou: a edge `omie-vendas-sync` (`criar_cliente`) já é `authorizeCronOrStaff`, então o vendedor já cria cliente no Omie pelo fluxo de vendas. O Radar não dá poder novo. A massa fica escondida na UI (barreira cosmética, declarada) |
| P2: contato depois de expirar ressuscitava a posse | Expiração por CADEIA: o 1º toque depois de vencer encerra a cadeia (prova E18/E19, sabotagem `expira_ressuscita`) |
| P2: `now()` é o início da transação | `clock_timestamp()` lido depois da trava advisory |
| P2: `radar_salvar_geocode` sobrescreve coordenadas de qualquer CNPJ | Fica gestor (não tem caller no app) |
| P2: leitores de conflito liam a tabela | A ficha lê pela `radar_estado_cadastro_omie`; as 3 RPCs de leitura entram na allowlist da lente |
| P2: `radar_atendimentos_ativos` sem limite | Teto de 100 por dono; o front lê com `.range(0, 999)` e trata o teto como ERRO, nunca como "acabou" |

## Achado de prod no caminho (fail-closed latente)

`authenticated` **não tem EXECUTE** em `public.pode_ver_carteira_completa` (só `service_role`; medido por `psql-ro` em
2026-10-29). A policy viva de `radar_situacao_cadastral` chamava esse wrapper, então a leitura dava `permission denied`
para **todo mundo**, gestor incluso. Ninguém notou porque nenhum leitor do app lê a tabela. A prova reproduziu isso
(o ACL do harness é o de prod). A migration troca a policy por `private.cap_carteira_ler`, com a mesma semântica.
Dentro de SECURITY DEFINER (dona `postgres`) o wrapper funciona, porque o EXECUTE é checado contra o dono.

## Limites declarados

- A prova monta as RPCs antigas por um **fixture de prod** (`db/fixtures/radar-acesso-vendedor-prod-20261029.sql`,
  md5 conferido), não pela cadeia. A cadeia de outubro do radar aborta sobre o snapshot de 15/10 (pós-condição da
  `20261020143000`). Uma migration FUTURA que recrie uma dessas RPCs não é exercitada aqui. Quem a escreve parte do corpo
  vivo e preserva `cap_radar_prospectar` (contrato na nota compartilhada das frentes).
- O vendedor lê TODO o `radar_empresas`, inclusive `ja_cliente`, `omie_codigo_cliente`, notas e motivos de descarte.
  É a decisão do founder: dados da RFB + estado de prospecção, e o cadastro-base do cliente já é broad-staff por
  desenho (`database.md` §4).
- O aviso de atendimento é **consultivo**: não impede outro vendedor de registrar contato.

## Pendências fora desta frente (pré-existentes, agora alcançáveis pelo vendedor)

- ~~`registrar_contato_radar` aceita `virou_cliente` sem a confirmação Omie que a v1 exige (frente 3 é dona da RPC).~~
- ~~`desfazer_contato_radar` restaura o status só porque ele "continua igual à ação desfeita": A e B registram a mesma
  ação, A desfaz e apaga o efeito de B.~~ → as duas feitas em [radar-contato-integridade.md](radar-contato-integridade.md).
- `radar_salvar_geocode` usa regex só-numérica de CNPJ (fica de fora o alfanumérico).
