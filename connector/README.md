# sayersync — Conector Tintométrico

Conector Go que sincroniza o catálogo e fórmulas do SayerSystem (PostgreSQL local, porta 5986)
com o módulo Tintométrico do Afiação OS via Edge Function `tint-sync-agent`.

## Arquitetura

```
SayerSystem PG (local)
    │  delta via data_atualizacao HWM
    ▼
sayersync.exe (Windows Service, LocalService)
    │  POST /catalogs, /formulas, /keys-snapshot, /heartbeat
    ▼
tint-sync-agent (Supabase Edge Function)
    │
    ▼
tint_* tables (Supabase PostgreSQL)
```

**Fluxo de um ciclo:**
1. Extrai delta de cada entidade desde o último HWM (margem de 5 min)
2. Envia em lotes ≤ 1000 com idempotency key (UUID v4)
3. Avança o HWM apenas após todos os lotes do agente responderem 2xx
4. Uma vez por dia: envia keys-snapshot completo (reconciliação de chaves)
5. Domingo: re-scan completo de todas as entidades (HWM zerado)
6. Heartbeat ao final com versão, uptime e contagens do ciclo

---

## Pré-requisitos de desenvolvimento

- Go 1.22+ (`brew install go`)
- Acesso ao PostgreSQL do SayerSystem (para testes de integração — opcional)

---

## Build

### Build local (para teste)

```bash
cd connector/sayersync
go build -o sayersync .
```

### Build de release para Windows (cross-compile a partir do macOS/Linux)

```bash
cd connector/sayersync
CGO_ENABLED=0 GOOS=windows GOARCH=amd64 \
  go build -ldflags "-s -w -X main.Version=0.1.0" \
  -o /tmp/sayersync-final.exe .
```

O binário resultante é um executável Windows estático (~10 MB), sem dependências externas.

### Calcular sha256 para o manifesto de auto-update

```bash
shasum -a 256 /tmp/sayersync-final.exe
```

---

## Testes

```bash
cd connector/sayersync
go test ./... -count=1 -timeout 120s
```

Os testes usam `httptest.Server` e uma implementação fake da interface `Extractor` —
**não precisam de PostgreSQL nem de conexão com o Supabase**.

Para rodar com verbose:

```bash
go test ./... -v -count=1 -timeout 120s
```

---

## Estrutura do código

| Arquivo | Responsabilidade |
|---|---|
| `main.go` | Ponto de entrada, serviço Windows via `kardianos/service`, comandos CLI |
| `config.go` | Carrega/salva `config.json`; protege token com DPAPI |
| `state.go` | Persiste HWMs, datas de snapshot/rescan, contadores de falha |
| `pg.go` | Extrator PostgreSQL (implementação real do `Extractor`) |
| `sync.go` | Orquestrador `RunCycle`; mapeadores de entidade; lógica de batch |
| `api.go` | Cliente HTTP com retry exponencial (1s/4s/16s); Heartbeat |
| `update.go` | Auto-update diário: manifesto → semver → sha256 → install + crash-loop guard |
| `recovery.go` · `recovery_windows.go` · `recovery_other.go` | Recuperação de crash-loop de BOOT: recovery-copy estável, failure actions do SCM, rollback rename-based, quarentena de versão |
| `mapping.go` | Carregamento do schema de mapeamento tintométrico |
| `discovery.go` | Descoberta de entidades no schema |
| `dpapi_windows.go` | DPAPI (CryptProtectData) para Windows |
| `dpapi_other.go` | Stub DPAPI para build em outras plataformas (dev) |

---

## Auto-update — publicar uma nova versão

O conector verifica o manifesto **uma vez por dia** e se atualiza sozinho
(anti-downgrade: só aplica se `manifest.version > current`, semver estrito; sha256
verificado antes de instalar). A chamada vive **cedo** no `RunCycle` (`sync.go`),
então o conector consegue se auto-curar mesmo quando o sync está quebrado (PG local
fora / schema divergente) — justamente quando um fix precisa chegar. O auto-update
roda **só no serviço** (`run`); o subcomando `once` (debug/manual) não auto-atualiza.

**Install Windows-safe + restart automático:** a imagem `.exe` em execução não pode
ser sobrescrita no Windows (sharing violation), então o install **move** o exe atual
para `<exe>.prev` e coloca o novo no lugar; em seguida o serviço **reinicia sozinho**
(o processo sai com código de falha → o SCM, configurado com `OnFailure=restart` pelo
`install`, relança o serviço a partir do binário novo). Sem esse restart o serviço
seguiria rodando a imagem antiga e a próxima atualização falharia ao tentar substituir
o `.prev` em uso.

**Crash-loop guard (do updater):** 3 falhas de update em 24h → restaura o `.prev` e
**pausa** as tentativas. A janela de 24h ancora na última **falha** (não no throttle
diário), então ela **expira** e o conector volta a tentar — nunca trava permanentemente.

**Recuperação de crash-loop de BOOT (rede externa ao binário):** o guard acima cobre
falhas do *updater*. Um binário que passa no sha256 mas **panica no boot**
(`init`/`main`/`LoadConfig`/`cmdRun`) seria relançado para sempre pelo SCM — e o código
de restauração, por viver no mesmo binário que não boota, nunca rodaria. Por isso o
recovery é **externo ao binário que quebra**: o `install` grava uma cópia estável
`sayersync-recovery.exe` (que o auto-update **nunca** toca) e estende as failure actions
do serviço para `[restart, restart, run_command]` (`dwResetPeriod` de 1h). Após 2
restarts falhos consecutivos, o SCM roda `sayersync-recovery.exe rollback --target <exe>`
num processo **fresco e bom**, que restaura o `.prev` (rename-based, Windows-safe) e
reinicia o serviço (o `run_command` do SCM não reinicia sozinho). A versão ruim é
**quarentenada** (`quarantined_version` no `state.json`): o auto-update a pula até o
manifesto publicar **outra** — senão o binário restaurado reinstalaria o mesmo manifesto
ruim no dia seguinte (brick *diário* em vez de permanente). E antes de cada troca de
binário o updater **verifica/repara** essas failure actions; se não conseguir, **pula** o
update (não ativa versão nova sem rede de rollback).

### 1. Gerar os artefatos

```bash
cd connector/sayersync
go test ./... -count=1        # nunca publique com teste vermelho
./release.sh 0.2.0            # cross-compila, calcula sha256, gera dist/manifest.json
```

Saída em `dist/`: `sayersync-0.2.0.exe` (binário **imutável e versionado** — evita
cache stale do CDN do Storage) + `manifest.json` apontando para ele.

### 2. Publicar (Supabase Storage → bucket `releases`, pasta `sayersync/`)

Upload **nesta ordem** — o `.exe` ANTES do manifest (senão o conector baixa um alvo
inexistente, falha o sha256 e conta como falha de update):

1. `dist/sayersync-0.2.0.exe`
2. `dist/manifest.json` (sobrescreve o ponteiro)

### 3. Ativar (uma vez)

- **Bucket** (global, uma vez): criar o bucket **público read-only** `releases` no
  Supabase Storage — leitura `anon`, escrita só `service_role`.
- **config.json** (em cada balcão): preencher `"update_manifest_url":
  "https://fzvklzpomgnyikkfkzai.supabase.co/storage/v1/object/public/releases/sayersync/manifest.json"`.
  Vazio = auto-update desativado (default seguro).

> **Rollout em 2 passos (importante):** o recovery externo só existe a partir de uma
> versão que já o contenha. Num balcão que rodou `install` de uma versão antiga:
> **(1)** faça um redeploy manual desta versão (rollback-capable) e rode
> `sayersync.exe install` de novo — idempotente: recria a recovery-copy e as failure
> actions `[restart, restart, run_command]`; **(2)** só então preencha o
> `update_manifest_url`. Ativar o manifesto antes disso deixaria o primeiro auto-update
> sem rede de recuperação. (O updater também verifica/repara as failure actions e pula
> o update se faltarem — mas não conte com isso para o bootstrap.)
>
> **Verificação ponta-a-ponta EXIGE um balcão Windows real.** Os testes provam a
> *lógica* (restore rename-based, quarentena, gate de recovery, montagem do
> `lpCommand`), mas a semântica do SCM — contagem de falhas, `dwResetPeriod`, execução
> do `run_command` — só é observável no Windows. Antes de confiar, publique um release
> **deliberadamente quebrado** (compila, passa sha256, mas **panica no boot**) e confirme
> que o SCM dispara o `rollback`, o `.prev` é restaurado, o serviço **volta a sincronizar**
> e a versão ruim fica **quarentenada**.
>
> **Limites ainda abertos (degradação aceita, não resolvida):** **(F4)** queda de energia
> *entre* os dois renames do restore pode deixar o `exe` ausente por um instante — limite
> inerente do self-replace; só um launcher/watchdog dedicado resolveria. **(F9)** o sha256
> garante **integridade**, não **autenticidade** — assinar os releases (chave pinada /
> Authenticode) fica para o roadmap. Nenhum bloqueia a ativação; ambos devem entrar no
> backlog do conector.

---

## Segurança

- Token armazenado com DPAPI (escopo de MÁQUINA (CRYPTPROTECT_LOCAL_MACHINE) — o serviço descriptografa mesmo rodando como conta de serviço)
- Serviço roda como `LocalService` (menor privilégio: só localhost + HTTPS outbound)
- `UpdateManifestURL` aponta para bucket read-only público; escrita = `service_role` apenas
- sha256 verificado antes de instalar o binário baixado
- Crash-loop guard (updater): 3 falhas em 24h → restaura `.prev`; a janela ancora na última falha e **expira** (não trava permanentemente)
- Recuperação de crash-loop de **boot**: ator externo (recovery-copy) restaura o `.prev` via SCM `run_command` e **quarentena** a versão ruim; o auto-update é gateado pela verificação dessa rede de recuperação

---

## Variáveis de ambiente relevantes (para testes de integração)

Não há variáveis de ambiente obrigatórias — a configuração é toda via `config.json`.
Para testes com PG real, passe a connection string via `--pg-conn` no comando `config`.
