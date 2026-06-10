//go:build windows

// dpapi_windows.go — proteção do token via CryptProtectData/CryptUnprotectData
// (DPAPI do Windows). Usa escopo de MÁQUINA (CRYPTPROTECT_LOCAL_MACHINE) para
// que a conta LocalService consiga descriptografar o token que o admin gravou
// durante o 'sayersync install'.
//
// Ref: https://learn.microsoft.com/en-us/windows/win32/api/dpapi/
package main

import (
	"encoding/base64"
	"fmt"
	"unsafe"

	"golang.org/x/sys/windows"
)

// CRYPTPROTECT_LOCAL_MACHINE (0x4): protege com a chave da MÁQUINA, não do usuário.
// Qualquer conta de sistema (LocalService, LocalSystem, etc.) na mesma máquina
// pode descriptografar — necessário para que o Windows SCM execute o serviço
// com LocalService e ainda acesse o token gravado pelo admin.
const cryptprotectLocalMachine = 0x4

// dataBlob corresponde à estrutura DATA_BLOB da API Win32.
type dataBlob struct {
	cbData uint32
	pbData *byte
}

// newBlob converte um slice de bytes em dataBlob (sem cópia; o GC mantém a memória).
func newBlob(data []byte) *dataBlob {
	if len(data) == 0 {
		return &dataBlob{}
	}
	return &dataBlob{
		cbData: uint32(len(data)),
		pbData: &data[0],
	}
}

// toBytes converte um dataBlob em slice de bytes e libera a memória alocada pelo
// sistema com LocalFree (obrigatório para ponteiros retornados pelo CryptProtect*).
func (b *dataBlob) toBytes() []byte {
	if b.pbData == nil || b.cbData == 0 {
		return nil
	}
	out := make([]byte, b.cbData)
	copy(out, unsafe.Slice(b.pbData, b.cbData))
	windows.LocalFree(windows.Handle(unsafe.Pointer(b.pbData)))
	b.pbData = nil
	return out
}

var (
	modCrypt32             = windows.NewLazySystemDLL("crypt32.dll")
	procCryptProtectData   = modCrypt32.NewProc("CryptProtectData")
	procCryptUnprotectData = modCrypt32.NewProc("CryptUnprotectData")
)

// dpapiProtect cifra data com CryptProtectData (escopo de máquina).
func dpapiProtect(data []byte) ([]byte, error) {
	in := newBlob(data)
	var out dataBlob

	ret, _, err := procCryptProtectData.Call(
		uintptr(unsafe.Pointer(in)),     // pDataIn
		0,                               // szDataDescr (NULL)
		0,                               // pOptionalEntropy (NULL)
		0,                               // pvReserved (NULL)
		0,                               // pPromptStruct (NULL)
		uintptr(cryptprotectLocalMachine), // dwFlags
		uintptr(unsafe.Pointer(&out)),   // pDataOut
	)
	if ret == 0 {
		return nil, fmt.Errorf("CryptProtectData falhou: %w", err)
	}
	return out.toBytes(), nil
}

// dpapiUnprotect descriptografa data com CryptUnprotectData.
func dpapiUnprotect(data []byte) ([]byte, error) {
	in := newBlob(data)
	var out dataBlob

	ret, _, err := procCryptUnprotectData.Call(
		uintptr(unsafe.Pointer(in)),   // pDataIn
		0,                             // ppszDataDescr (NULL)
		0,                             // pOptionalEntropy (NULL)
		0,                             // pvReserved (NULL)
		0,                             // pPromptStruct (NULL)
		uintptr(cryptprotectLocalMachine), // dwFlags
		uintptr(unsafe.Pointer(&out)), // pDataOut
	)
	if ret == 0 {
		return nil, fmt.Errorf("CryptUnprotectData falhou: %w", err)
	}
	return out.toBytes(), nil
}

// encryptToken cifra o token e retorna a representação base64 para persistência.
func encryptToken(plain string) (string, error) {
	enc, err := dpapiProtect([]byte(plain))
	if err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(enc), nil
}

// decryptToken descriptografa o token a partir do config.
// No Windows usa DPAPI; retorna erro se TokenEnc estiver vazio.
func decryptToken(cfg *Config) (string, error) {
	if cfg.TokenEnc == "" {
		return "", fmt.Errorf("token não configurado (execute 'sayersync install')")
	}
	raw, err := base64.StdEncoding.DecodeString(cfg.TokenEnc)
	if err != nil {
		return "", fmt.Errorf("token base64 inválido: %w", err)
	}
	plain, err := dpapiUnprotect(raw)
	if err != nil {
		return "", fmt.Errorf("falha ao descriptografar token (DPAPI): %w", err)
	}
	return string(plain), nil
}
