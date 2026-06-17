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

**Crash-loop guard:** 3 falhas de update em 24h → restaura o `.prev` e **pausa** as
tentativas. A janela de 24h ancora na última **falha** (não no throttle diário), então
ela **expira** e o conector volta a tentar — nunca trava permanentemente.

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

> A primeira ativação ainda exige um redeploy manual do `.exe` no balcão: o
> auto-update só passa a valer a partir de uma versão que já contenha a chamada no
> ciclo.
>
> O restart automático depende do recovery `OnFailure=restart` do serviço Windows,
> que o `install` já configura (`svcConfig` em `main.go`). Em um balcão que rodou
> `install` de uma versão antiga, rode `sayersync.exe install` de novo (idempotente)
> para garantir o recovery — sem ele, o `os.Exit` pós-update encerra o serviço e o
> SCM **não** o relança. **Verifique ponta-a-ponta em um balcão Windows real** antes
> de confiar: instalação do `.exe`, troca pelo `.prev` e relançamento pelo SCM só são
> observáveis no Windows (os testes provam a sequência/lógica, não o SCM).
>
> ⚠️ **Limite conhecido (testar com release quebrado):** o crash-loop guard conta
> falhas do *updater* (manifesto/download/sha256/install), **não** crashes do
> *serviço*. Um binário que passa no sha256 mas quebra no boot (panic em `init`/`main`/
> `LoadConfig`/`cmdRun`) reinicia em loop pelo SCM sem o guard pegar e sem restaurar o
> `.prev`. Antes de ativar em produção, teste publicar um release deliberadamente
> quebrado e confirme o comportamento — ou adote um handshake de boot (binário novo só
> é "promovido" após 1 ciclo/heartbeat OK) antes de confiar no auto-restart.

---

## Segurança

- Token armazenado com DPAPI (escopo de MÁQUINA (CRYPTPROTECT_LOCAL_MACHINE) — o serviço descriptografa mesmo rodando como conta de serviço)
- Serviço roda como `LocalService` (menor privilégio: só localhost + HTTPS outbound)
- `UpdateManifestURL` aponta para bucket read-only público; escrita = `service_role` apenas
- sha256 verificado antes de instalar o binário baixado
- Crash-loop guard: 3 falhas de update em 24h → restaura `.prev` e para de tentar

---

## Variáveis de ambiente relevantes (para testes de integração)

Não há variáveis de ambiente obrigatórias — a configuração é toda via `config.json`.
Para testes com PG real, passe a connection string via `--pg-conn` no comando `config`.
