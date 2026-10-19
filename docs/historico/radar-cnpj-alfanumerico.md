# Radar: CNPJ alfanumérico de ponta a ponta (RFB, desde jul/2026)

> PR: #3175 (2026-10-19). Bloco seguinte ao #3169 (carga mensal automática + recruzamento diário). Origem: P0 do parecer Codex de desenho do #3169, fora daquele bloco.

## O problema

A Receita Federal emite **CNPJ alfanumérico** desde julho/2026: 12 posições `[0-9A-Z]` + 2 dígitos verificadores (DV por módulo 11 sobre o valor `ASCII − 48` de cada caractere — dígito vale o próprio valor, `A..Z` valem 17..42; pesos `5,4,3,2,9,8,7,6,5,4,3,2` e `6,5,4,3,2,9,8,7,6,5,4,3,2`; resto < 2 → 0, senão 11 − resto). Exemplo oficial: `12.ABC.345/01DE-35`. Para CNPJ só-numérico a regra coincide com a clássica.

O Radar inteiro assumia `^[0-9]{14}$`, em quatro camadas que não se cobriam:

| Camada | Antes | Efeito com CNPJ alfanumérico |
|---|---|---|
| `montarCnpj` (`src/lib/radar/normalizar.ts`, usado por `scripts/radar/carga.ts`) | `^\d{1,8}$` etc. | linha do dump descartada com `continue` mudo |
| edge `radar-ingest` action `chunk` | `CNPJ_RE = /^\d{14}$/` + `console.warn` | linha descartada em silêncio (contador agregado, sem motivo) |
| CHECK `radar_empresas.cnpj` | `~ '^[0-9]{14}$'` | insert rejeitado (nunca chegaria — as camadas acima já descartam) |
| `radar_recruzar_ja_cliente()` | `regexp_replace(doc,'[^0-9]','','g')` + `length = 14` | cliente alfanumérico **nunca** vira `ja_cliente` |

## Medido em prod ANTES de escrever (psql-ro, 2026-10-19)

| Fonte | documentos | com letra | 14 dígitos |
|---|---|---|---|
| `profiles.document` | 5.668 | **0** | 4.976 |
| `omie_clientes_nao_vinculados.cnpj_cpf` | 10.164 | **0** | 10.085 |
| `radar_empresas.cnpj` | 526.176 | **0** | 526.176 |

E **0 de 526.176** CNPJs do radar falham o módulo 11 — validar DV também nos numéricos não descarta ninguém do acervo. Mudança **preventiva**: nenhum dado existente muda de estado.

⚠️ **O zero não prova ausência na origem** (achado ALTO do Codex): os escritores das duas fontes de cliente removem `\D` antes de gravar (`omie-analytics-sync` em `cnpj_cpf`; `omie-vendas-sync` e o import de `profiles.document`). Um cliente alfanumérico hoje chegaria ao banco **sem as letras** — e o recruzamento novo não recupera o que já foi apagado. Fica como follow-up (abaixo), com o recruzamento já preparado para o dia em que os escritores preservarem o documento.

## O que mudou

1. **`normalizar.ts`** (TDD): `CNPJ_RE = /^[0-9A-Z]{12}[0-9]{2}$/`, `dvCnpj`, `cnpjValido`; `montarCnpj` aceita `[0-9A-Z]` nos componentes básico/ordem, exige DV numérico e **valida o DV para todos** (fail-closed: minúscula, caractere fora do alfabeto ou DV errado → `null`). O oráculo externo dos testes é o exemplo oficial da RFB. Consumidores do módulo trocaram o regex local por `CNPJ_RE`: `lote-persistido` (parse do localStorage) e `formatarCnpj` (a máscara `00.000.000/0000-00` vale igual para letras).
2. **Edge `radar-ingest`** (`v1.0-sonda` → `v1.1-cnpj-alfanumerico`): módulo `cnpj.ts` próprio (Deno não importa `src/`) com teste Deno espelhando o TS; o `chunk` descarta **por motivo** (`cnpj_formato` → `cnpj_dv` → `cnae`) e devolve `descartadas_por_motivo` + `duplicadas_no_chunk` (antes duplicata intra-chunk se misturava a inválida). Fingerprint regravado.
3. **`carga.ts`** conta as rejeições locais por motivo e **soma o retorno dos chunks** (era ignorado), imprimindo `⚠️` antes do finalize quando há qualquer rejeição.
4. **Migration `20261019110000_radar_cnpj_alfanumerico.sql`** (envelope `BEGIN/COMMIT` para SQL Editor/MCP — os objetos são do `postgres`, fora do alcance do `db:aplicar`): CHECK de `radar_empresas.cnpj` recriado só se a definição viva divergir; CHECK novo em `radar_contatos.cnpj` (antes só a FK); `radar_recruzar_ja_cliente()` no molde **TRAVA → PRE (md5 `prosrc` de prod `27ccab8e…`) → CREATE → PÓS**, `REVOKE` nomeando roles + `GRANT EXECUTE TO service_role` explícito. O documento do cliente passa por **duas** normalizações: a antiga (só dígitos — acervo numérico intocado, `"CNPJ: 22.333.444/0001-81"` segue casando) e a nova (`btrim` + `upper` + remove **só** `.`, `-`, `/`). A nova **não apaga letra** e não trata espaço interno como separador: o contraexemplo do Codex `aeg 123.456.789-09` (CPF com anotação) **não** vira a chave `AEG12345678909` por acaso — precisão > recall.
5. **Prova PG17 `db/test-radar-cnpj-alfanumerico.sh`** (no `nucleo-ci.txt`, `23 falsificar=4`): a PRE exige o md5 de PROD do predecessor, então **repo ≠ prod fica vermelho no CI**, não na mão do founder. Sabotagens em espelho, após controle verde na mesma invocação, **uma camada por vez** — a régua de md5 da PRE/PÓS é neutralizada (literal → md5 vivo) nas sabotagens semânticas, senão todo mutante morreria na PÓS sem exercitar o assert funcional (achado 6 do Codex): F1 CHECK aceita minúscula → A1 vermelho; F2 sem `upper()` → "minúsculo com máscara não marca"; F3 caminho alnum vira só-dígitos → "alfanumérico não marca" (numérico segue marcando); F4 corpo sabotado **sem** neutralizar → a PÓS morde.
6. **Bloqueio explícito no cadastro Omie** (`cadastro-omie.ts`): CNPJ fora de `^[0-9]{14}$` falha na etapa `omie` **antes** de chamar a edge — `omie-vendas-sync` (`criar_cliente`) remove `\D` e trataria `12ABC34501DE35` como um CPF de 11 dígitos de **outra** pessoa (achado ALTO do Codex: "follow-up com botões operantes é o veto").

Custo medido do `DROP + ADD CHECK` em 526.176 linhas (PG17 local, mesma regex): **1,08 s** de `ACCESS EXCLUSIVE` — abaixo de qualquer timeout; `NOT VALID` + `VALIDATE` separado (sugestão Codex) não compensa a perda da garantia `convalidated` na PÓS.

## Estado em prod (2026-10-19)

- **Migration APLICADA** pelo envelope MCP (`postgres`), pré-voo colado 🟢 e validada por psql-ro em outra conexão após o COMMIT: `check_empresas_ok=t · check_contatos_ok=t · funcao_ok=t (md5 9163372c…) · acl_ok=t · ja_cliente_total=3001 (inalterado) · provolatile=v`. Evidência no comentário do PR.
- **Edge `radar-ingest` v1.1**: pendente até o deploy pelo chat do Lovable (`bun run pendencias:pacote radar-ingest` após o merge; sonda deve responder `v1.1-cnpj-alfanumerico`). Até lá a edge em prod (`v1.0-sonda`) descarta alfanumérico como hoje — sem regressão.
- **Codex de código: REVISÃO INDEPENDENTE PENDENTE** (`COTA_ESGOTADA`, plano `prolite` a 71 %). Rodar retroativo quando a janela voltar.

## Follow-ups (não feitos aqui — cada um é um bloco)

- **Escritores que apagam letras** antes de persistir o documento: `omie-analytics-sync` (`cnpj_cpf: replace(/\D/g,'')`), `omie-vendas-sync` (`documentClean`, `criar_cliente`), import de `profiles.document`, `analyze-unified-order`. Sem isso o recruzamento alfanumérico é **inerte** para clientes vindos do Omie. Exige revisar os consumidores de `cnpj_cpf` que deduplicam por dígitos — domínio `sync.md`.
- **RPCs do Radar com guard numérico** (`radar_atribuir_tarefa`, `registrar_contato_radar`, `radar_registrar_cadastro_omie`: `p_cnpj !~ '^[0-9]{14}$'` → `RAISE 'cnpj inválido'`): falham **alto** para alfanumérico, não em silêncio; e o `like-cru-em-migrations-gate` ancora nesse texto. Trocar junto com o gate.
- **`criar_cliente` no Omie para alfanumérico**: depende da API Omie aceitar o formato novo; até lá o bloqueio do item 6 vale.

## Lições

- **Zero na tabela ≠ zero na origem** quando o escritor normaliza: medir a fonte certa é medir o que entra no `INSERT`, não o que sobrou dele.
- **Falsificação de corpo com PÓS por md5 é sempre vermelha** — e por isso não prova a semântica. Neutralize a régua de md5 nas sabotagens semânticas e deixe **uma** sabotagem para provar que a régua morde.
- **Normalizar apagando** (`[^0-9A-Z]`) transforma anotação em chave. Remova só o que é separador conhecido.
