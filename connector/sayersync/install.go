// install.go — lógica PURA do assistente de `install` (testável fora do Windows).
//
// O `install` é o caminho documentado para refazer a recovery-copy e as failure
// actions do SCM (README "Rollout em 2 passos"), então PRECISA ser seguro de repetir:
// um config.json existente é a BASE (cada campo vira o default do prompt; Enter
// mantém) e campos que o assistente não pergunta — update_manifest_url,
// intervalo_min, token_plain_dev — são preservados. Antes (≤0.2.2) o install montava
// a Config do zero: apagava o update_manifest_url (desligava o auto-update em
// silêncio) e exigia o token em texto, que o operador já não tem à mão.
package main

import (
	"errors"
	"fmt"
	"io/fs"
	"net/url"
	"strings"
)

// respostasInstall são as respostas CRUAS do operador: "" = Enter (mantém o default).
type respostasInstall struct {
	AppURL    string
	StoreCode string
	Token     string // texto puro; "" = manter o token atual (se houver)
	PGConn    string
}

// carregarConfigParaInstall decide a base do assistente:
//   - (nil, nil)  → config.json não existe: instalação limpa;
//   - (cfg, nil)  → existe e carrega: vira a base (defaults + campos preservados);
//   - (nil, err)  → existe mas não carrega (malformado, sem permissão…): ABORTAR —
//     sobrescrever às cegas pode perder o token_dpapi e o update_manifest_url.
func carregarConfigParaInstall(load func() (*Config, error)) (*Config, error) {
	cfg, err := load()
	if err == nil {
		return cfg, nil
	}
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	return nil, err
}

// baseDoInstall devolve a Config de onde saem os defaults dos prompts.
func baseDoInstall(atual *Config) *Config {
	if atual == nil {
		return configDefaults()
	}
	return atual
}

// temTokenSalvo: há token persistido que o install pode manter sem pedir texto.
func temTokenSalvo(atual *Config) bool {
	return atual != nil && atual.TokenEnc != ""
}

// mesclarConfigInstall aplica as respostas sobre uma CÓPIA da base: resposta vazia
// mantém o valor atual; campos não perguntados passam intactos. tokenEnc é o token
// novo JÁ cifrado ("" = manter o atual). built_version passa a ser a versão que
// escreveu a config. Erro = campo obrigatório ausente (nada deve ser gravado).
func mesclarConfigInstall(atual *Config, r respostasInstall, tokenEnc, versao string) (*Config, error) {
	novo := *baseDoInstall(atual) // cópia: nunca muta a base

	if v := strings.TrimSpace(r.AppURL); v != "" {
		novo.AppURL = v
	}
	if v := strings.TrimSpace(r.StoreCode); v != "" {
		novo.StoreCode = v
	}
	if v := strings.TrimSpace(r.PGConn); v != "" {
		novo.PGConn = v
	}
	if tokenEnc != "" {
		novo.TokenEnc = tokenEnc
	}
	if novo.IntervaloMin <= 0 {
		novo.IntervaloMin = 10
	}
	novo.BuiltVersion = versao

	if novo.StoreCode == "" {
		return nil, fmt.Errorf("store_code é obrigatório")
	}
	if novo.TokenEnc == "" {
		return nil, fmt.Errorf("token é obrigatório")
	}
	return &novo, nil
}

// validarConfigParaManter: `install --manter-config` só registra o serviço; exige
// uma config já utilizável (senão o serviço sobe e falha em todo ciclo).
func validarConfigParaManter(atual *Config) error {
	if atual == nil {
		return fmt.Errorf("--manter-config exige um config.json existente (rode 'install' sem a flag para criar)")
	}
	if atual.StoreCode == "" {
		return fmt.Errorf("config.json sem store_code — rode 'install' sem a flag para preencher")
	}
	if atual.TokenEnc == "" {
		return fmt.Errorf("config.json sem token_dpapi — rode 'install' sem a flag para gravar o token")
	}
	return nil
}

// temFlag procura uma flag exata nos argumentos depois do subcomando.
func temFlag(args []string, flag string) bool {
	for _, a := range args {
		if a == flag {
			return true
		}
	}
	return false
}

// mascararSenhaPG esconde a senha da pg_conn no default exibido pelo prompt (a
// string real continua sendo o default). Não-URL volta inalterada só se não
// parecer conter credencial.
func mascararSenhaPG(conn string) string {
	u, err := url.Parse(conn)
	if err != nil || u.User == nil {
		if strings.Contains(conn, "password=") {
			return "(conexão atual — senha oculta)"
		}
		return conn
	}
	if _, temSenha := u.User.Password(); !temSenha {
		return conn
	}
	u.User = url.UserPassword(u.User.Username(), "***")
	return strings.Replace(u.String(), "%2A%2A%2A", "***", 1)
}
