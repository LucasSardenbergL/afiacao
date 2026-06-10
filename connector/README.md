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
5. Segunda-feira: re-scan completo de todas as entidades (HWM zerado)
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

## Manifesto de auto-update

Para publicar uma nova versão, faça upload do `.exe` para o bucket público do Supabase
e atualize o arquivo `manifest.json`:

```json
{
  "version": "0.2.0",
  "sha256": "<hex do sha256 do .exe>",
  "url": "https://<project>.supabase.co/storage/v1/object/public/releases/sayersync/sayersync.exe"
}
```

O conector verifica o manifesto uma vez por dia e aplica a atualização automaticamente
(anti-downgrade: só atualiza se `manifest.version > current`).

---

## Segurança

- Token armazenado com DPAPI (escopo máquina+usuário, LocalService consegue descriptografar)
- Serviço roda como `LocalService` (menor privilégio: só localhost + HTTPS outbound)
- `UpdateManifestURL` aponta para bucket read-only público; escrita = `service_role` apenas
- sha256 verificado antes de instalar o binário baixado
- Crash-loop guard: 3 falhas de update em 24h → restaura `.prev` e para de tentar

---

## Variáveis de ambiente relevantes (para testes de integração)

Não há variáveis de ambiente obrigatórias — a configuração é toda via `config.json`.
Para testes com PG real, passe a connection string via `--pg-conn` no comando `config`.
