//go:build !windows

// dpapi_other.go — stub de DPAPI para plataformas não-Windows (macOS, Linux).
//
// ⚠️  AVISO: em plataformas não-Windows o token é armazenado em PLAINTEXT no
// campo TokenPlainDev do config.json. Use apenas para desenvolvimento local.
// Em produção (Windows), o token é sempre protegido pela DPAPI da máquina.
package main

import (
	"fmt"
)

// encryptToken em plataformas não-Windows simplesmente retorna o plaintext
// marcado com um prefixo especial que decryptToken reconhece.
// O token NÃO é cifrado — isto é intencional e limitado a dev.
func encryptToken(_ string) (string, error) {
	// Neste stub retornamos erro para deixar claro que 'install' não funciona
	// fora do Windows. O comando 'install' já impede execução em !windows.
	return "", fmt.Errorf("encryptToken: não implementado em plataformas não-Windows")
}

// decryptToken em plataformas não-Windows lê TokenPlainDev do config.
// Emite um aviso no log ao usar.
func decryptToken(cfg *Config) (string, error) {
	if cfg.TokenPlainDev != "" {
		// ⚠️ Aviso explícito: token em plaintext — apenas para desenvolvimento.
		logger.Warn("⚠️  TOKEN EM PLAINTEXT (TokenPlainDev) — somente para dev; nunca usar em produção Windows!")
		return cfg.TokenPlainDev, nil
	}
	if cfg.TokenEnc != "" {
		return "", fmt.Errorf("TokenEnc (DPAPI) não pode ser descriptografado fora do Windows; " +
			"para dev, remova token_dpapi e use token_plain_dev no config.json")
	}
	return "", fmt.Errorf("token não configurado; para dev defina 'token_plain_dev' no config.json")
}
