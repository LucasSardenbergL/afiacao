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
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net/url"
	"regexp"
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
	// Colar de volta o default EXIBIDO (mascarado) = Enter — senão "***" vira a senha.
	if v := strings.TrimSpace(r.PGConn); v != "" && v != mascararSenhaPG(novo.PGConn) {
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

var reSenhaKeyword = regexp.MustCompile(`(?i)(password\s*=\s*)('(?:[^'\\]|\\.)*'|\S+)`)

// mascararSenhaPG esconde a senha da pg_conn no default exibido pelo prompt (a
// string real continua sendo o default). Cobre userinfo e ?password= da URL e o
// formato keyword (password = x, com ou sem aspas).
func mascararSenhaPG(conn string) string {
	u, err := url.Parse(conn)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return reSenhaKeyword.ReplaceAllString(conn, "${1}***")
	}
	if u.User != nil {
		if _, temSenha := u.User.Password(); temSenha {
			u.User = url.UserPassword(u.User.Username(), "***")
		}
	}
	q := u.Query()
	for k := range q {
		if strings.EqualFold(k, "password") {
			q.Set(k, "***")
		}
	}
	u.RawQuery = q.Encode()
	return strings.ReplaceAll(u.String(), "%2A%2A%2A", "***")
}

// promptCru mostra o default (que pode estar mascarado) e devolve a resposta CRUA:
// "" = Enter. Qualquer erro de leitura — inclusive EOF com bytes parciais — é
// devolvido: o assistente ABORTA antes de cifrar/gravar/mexer no serviço (stdin
// cortado no meio não pode virar "Enter em tudo" nem um fragmento de token). (Codex P1)
func promptCru(r *bufio.Reader, question, shownDefault string) (string, error) {
	if shownDefault != "" {
		fmt.Printf("%s [%s]: ", question, shownDefault)
	} else {
		fmt.Printf("%s: ", question)
	}
	line, err := r.ReadString('\n')
	if err != nil {
		return "", fmt.Errorf("entrada interrompida em %q: %w", question, err)
	}
	return strings.TrimSpace(line), nil
}

// configJSONPreservandoDesconhecidos serializa cfg SOBRE o JSON cru anterior:
// chaves que a struct Config não conhece (escritas por outra versão) sobrevivem ao
// install. rawAnterior vazio = só a struct. (Codex P2)
func configJSONPreservandoDesconhecidos(rawAnterior []byte, cfg *Config) ([]byte, error) {
	conhecido, err := json.Marshal(cfg)
	if err != nil {
		return nil, err
	}
	if len(rawAnterior) == 0 {
		return json.MarshalIndent(cfg, "", "  ")
	}
	var mapa map[string]json.RawMessage
	if err := json.Unmarshal(rawAnterior, &mapa); err != nil {
		return nil, fmt.Errorf("config.json anterior ilegível: %w", err)
	}
	var novos map[string]json.RawMessage
	if err := json.Unmarshal(conhecido, &novos); err != nil {
		return nil, err
	}
	for k, v := range novos {
		mapa[k] = v
	}
	return json.MarshalIndent(mapa, "", "  ")
}
