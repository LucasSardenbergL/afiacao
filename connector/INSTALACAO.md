# Instalação do SayerSync — Guia Rápido

> Conector que sincroniza o catálogo, as fórmulas e os preços do SayerSystem
> com o módulo Tintométrico do app, rodando sozinho em segundo plano.
> Instala uma vez e esquece.

---

## O que você vai precisar

- O computador do balcão (Windows, o mesmo onde o SayerSystem roda), ligado e com internet
- O arquivo `sayersync.exe` (fornecido pela equipe)
- O **código da loja** e o **token** — os dois aparecem no app em
  **Tintométrico → Integração → aba Integrações** (crie a loja ali se ainda não existir e copie o token)
- Acesso de Administrador no computador

Tempo estimado: **5 minutos**.

---

## Passo 1 — Copiar o programa

1. Crie a pasta `C:\SayerSync\`
2. Copie o arquivo `sayersync.exe` para dentro dela

---

## Passo 2 — Abrir o Prompt de Comando como Administrador

1. Clique no botão **Iniciar** (ícone do Windows)
2. Digite `cmd`
3. Clique com o botão direito em **Prompt de Comando** → **Executar como administrador**
4. Clique em **Sim** na confirmação

---

## Passo 3 — Instalar (o programa pergunta tudo)

Na janela preta, digite e pressione **Enter**:

```
C:\SayerSync\sayersync.exe install
```

Ele vai fazer **4 perguntas**. Responda assim:

| Pergunta | O que responder |
|---|---|
| URL do app | só apertar **Enter** (usa o padrão) |
| store_code | colar o **código da loja** copiado do app |
| Token de sync | colar o **token** copiado do app |
| String de conexão PostgreSQL | só apertar **Enter** (usa o padrão) |

No final deve aparecer: **`Serviço SayerSync instalado e iniciado com sucesso.`**

> O token fica guardado **criptografado** no computador (DPAPI do Windows) — ninguém consegue lê-lo abrindo os arquivos.

---

## Passo 4 — Testar agora (opcional, recomendado)

Para rodar um ciclo de sincronização na hora e ver o resultado na tela:

```
C:\SayerSync\sayersync.exe once
```

---

## Passo 5 — Conferir no app

Abra o app em **Tintométrico → Integração → aba Integrações**.
A loja deve aparecer com o **heartbeat verde** (Online) em até ~10 minutos.

**Pronto.** O serviço roda sozinho daqui em diante — a cada 10 minutos ele envia
o que mudou no SayerSystem, inclusive depois de reiniciar o computador.
Ele também se **atualiza sozinho** quando a equipe publica uma versão nova.

---

## Comandos úteis (no Prompt como Administrador)

| O que fazer | Comando |
|---|---|
| Rodar um ciclo agora (teste) | `C:\SayerSync\sayersync.exe once` |
| Gerar o relatório do banco (se a equipe pedir) | `C:\SayerSync\sayersync.exe discovery` |
| Desinstalar o serviço | `C:\SayerSync\sayersync.exe uninstall` |
| Ver a versão instalada | `C:\SayerSync\sayersync.exe version` |
| Parar / iniciar o serviço | aperte `Win+R`, digite `services.msc`, ache **SayerSync** → botão direito → Parar/Iniciar |

---

## Resolução de problemas

### "Acesso negado" ao instalar/desinstalar
O Prompt precisa estar aberto **como Administrador** (passo 2).

### A loja aparece Offline / sem heartbeat no app
- Confira se o computador está ligado e com internet
- Rode `C:\SayerSync\sayersync.exe once` e leia a mensagem de erro na tela
- Token errado? Copie de novo do app (Tintométrico → Integração → Integrações) e rode `install` outra vez (pode repetir sem medo — ele só atualiza a configuração)

### "Não foi possível conectar ao banco de dados"
- Verifique se o SayerSystem está instalado nesta máquina (o banco roda junto, porta 5986)

### O app mostra "schema divergente" (ou a equipe pedir o relatório do banco)
1. Rode: `C:\SayerSync\sayersync.exe discovery`
2. Ele cria o arquivo `C:\SayerSync\sayersystem-schema.txt`
3. Envie esse arquivo pra equipe (WhatsApp/e-mail) — é só a estrutura do banco, sem dados de clientes

---

## Arquivos da pasta `C:\SayerSync\`

| Arquivo | O que é |
|---|---|
| `sayersync.exe` | O programa |
| `config.json` | Configuração (token criptografado — não editar) |
| `state.json` | Memória do que já foi sincronizado (não apagar) |
| `sayersystem-schema.txt` | Só existe se você rodar `discovery` |

---

*Dúvidas? Fale com a equipe.*
