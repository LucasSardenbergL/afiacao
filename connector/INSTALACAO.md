# Instalação do sayersync — Guia Rápido

> Conector que sincroniza o catálogo e as fórmulas do SayerSystem (banco PostgreSQL local)
> com o módulo Tintométrico do Afiação OS, rodando como serviço Windows em segundo plano.

---

## O que você vai precisar

- Windows 10/11 (64 bits)
- O SayerSystem instalado e rodando (banco PostgreSQL na porta padrão)
- O executável `sayersync.exe` (fornecido pela equipe)
- O **Token de Sync** e a **URL do app** (fornecidos pela equipe)
- Acesso de Administrador no computador

Tempo estimado: **5 minutos**.

---

## Passo 1 — Copiar o executável

1. Crie a pasta `C:\SayerSync\`
2. Copie o arquivo `sayersync.exe` para dentro dela

---

## Passo 2 — Abrir o Prompt de Comando como Administrador

1. Clique no botão **Iniciar** (ícone do Windows)
2. Digite `cmd`
3. Clique com o botão direito em **Prompt de Comando** → **Executar como administrador**
4. Clique em **Sim** na janela de confirmação

---

## Passo 3 — Configurar o conector

No prompt de comando (janela preta), digite o comando abaixo e pressione **Enter**.
Substitua os valores entre `<` e `>` pelos dados fornecidos pela equipe:

```
C:\SayerSync\sayersync.exe config ^
  --app-url <URL_DO_APP> ^
  --store-code <CODIGO_DA_LOJA> ^
  --token <TOKEN_DE_SYNC>
```

**Exemplo:**
```
C:\SayerSync\sayersync.exe config ^
  --app-url https://fzvklzpomgnyikkfkzai.supabase.co/functions/v1/tint-sync-agent ^
  --store-code COLACOR_DEMO ^
  --token eyJhbGc...
```

Se a mensagem `Configuração salva com sucesso` aparecer, continue para o próximo passo.

> **Observação:** Se a conexão com o banco for diferente do padrão, adicione também:
> ```
> --pg-conn "postgres://usuario:senha@localhost:5986/nome_do_banco"
> ```

---

## Passo 4 — Instalar como serviço Windows

Ainda no prompt de Administrador, execute:

```
C:\SayerSync\sayersync.exe install
```

Você verá a mensagem `Serviço instalado com sucesso`.

---

## Passo 5 — Iniciar o serviço

```
C:\SayerSync\sayersync.exe start
```

Mensagem esperada: `Serviço iniciado`.

---

## Verificar se está funcionando

Para confirmar que o sync está rodando:

```
C:\SayerSync\sayersync.exe status
```

Você verá algo como:
```
sayersync: Running
Último ciclo: 2026-06-09 14:32:01
Próximo ciclo: em ~8 minutos
```

---

## Comandos úteis

| O que fazer | Comando |
|---|---|
| Ver status | `C:\SayerSync\sayersync.exe status` |
| Parar o serviço | `C:\SayerSync\sayersync.exe stop` |
| Reiniciar | `C:\SayerSync\sayersync.exe restart` |
| Desinstalar | `C:\SayerSync\sayersync.exe uninstall` |
| Rodar um ciclo agora (teste) | `C:\SayerSync\sayersync.exe run-once` |

---

## O que acontece depois da instalação

- O conector roda automaticamente em segundo plano, mesmo após reiniciar o computador
- A cada 10 minutos (padrão), ele sincroniza as alterações do SayerSystem com o Afiação OS
- As atualizações do conector são baixadas e instaladas automaticamente (quando disponíveis)
- **Não é necessário fazer nada** — o serviço cuida de tudo sozinho

---

## Resolução de problemas

### "Acesso negado" ao instalar/desinstalar
Confirme que o Prompt de Comando foi aberto como **Administrador** (passo 2).

### "Não foi possível conectar ao banco de dados"
- Verifique se o SayerSystem está aberto e rodando
- Confirme a porta do PostgreSQL com a equipe (padrão: 5986)

### "Token inválido" ou "Não autorizado"
- Solicite um novo token à equipe — tokens são gerados por loja

### O serviço parou de funcionar
Execute no prompt de Administrador:
```
C:\SayerSync\sayersync.exe restart
```
Se persistir, contate a equipe com o conteúdo do arquivo `C:\SayerSync\sayersync.log`.

---

## Localização dos arquivos

| Arquivo | Descrição |
|---|---|
| `C:\SayerSync\sayersync.exe` | Executável principal |
| `C:\SayerSync\config.json` | Configurações (não editar manualmente) |
| `C:\SayerSync\state.json` | Estado interno do sync (não deletar) |

---

*Dúvidas? Contate a equipe Colacor.*
