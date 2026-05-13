package main

import (
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/joho/godotenv"
)

type Config struct {
	PrivateKeyHex string
	Region        string
	SendEndpoints []string
	SendInterval  time.Duration
}

var defaultEndpoints = []string{
	"https://api.avax.network/ext/bc/C/rpc",
	"https://avalanche.drpc.org",
	"https://avax.leorpc.com/?api_key=FREE",
	"https://avax-pokt.nodies.app/ext/bc/C/rpc",
	"https://avalanche-public.nodies.app/ext/bc/C/rpc",
	"https://avax.api.pocket.network",
	"https://avalanche-rpc.polkachu.com/ext/bc/C/rpc",
	"https://avalanche-c-chain-rpc.publicnode.com",
	"https://spectrum-01.simplystaking.xyz/avalanche-mn-rpc/ext/bc/C/rpc",
	"https://avalanche.rpc.thirdweb.com",
	"https://api.zan.top/avax-mainnet/ext/bc/C/rpc",
}

func LoadConfig() (*Config, error) {
	_ = godotenv.Load()

	pk := strings.TrimSpace(os.Getenv("PRIVATE_KEY"))
	if pk == "" {
		return nil, fmt.Errorf("PRIVATE_KEY is required")
	}
	pk = strings.TrimPrefix(pk, "0x")

	region := strings.TrimSpace(os.Getenv("REGION"))
	if region == "" {
		region = "local"
	}

	endpoints := defaultEndpoints
	if v := strings.TrimSpace(os.Getenv("SEND_ENDPOINTS")); v != "" {
		endpoints = splitCSV(v)
	}
	if len(endpoints) == 0 {
		return nil, fmt.Errorf("no send endpoints configured")
	}

	sendInterval := 5 * time.Second
	if v := strings.TrimSpace(os.Getenv("SEND_INTERVAL")); v != "" {
		d, err := time.ParseDuration(v)
		if err != nil {
			return nil, fmt.Errorf("invalid SEND_INTERVAL: %w", err)
		}
		sendInterval = d
	}

	return &Config{
		PrivateKeyHex: pk,
		Region:        region,
		SendEndpoints: endpoints,
		SendInterval:  sendInterval,
	}, nil
}

func splitCSV(s string) []string {
	parts := strings.Split(s, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}
