# Avalanche C-Chain Public RPC Endpoints

Checked from this host on 2026-05-13 around 03:25 UTC.

Scope: unauthenticated HTTPS JSON-RPC endpoints for Avalanche mainnet C-Chain only. Expected `eth_chainId` is `0xa86a` / `43114`. WSS endpoints and URLs with `<api-key>` placeholders were not included.

Probe: `eth_chainId`, `eth_blockNumber`, and spot checks of `eth_getBlockByNumber("latest", false)` for `timestampMilliseconds`. "Recent" means within 300 blocks of the max block observed during the probe.

## Open And Recent

These returned chain ID `43114` and a recent block number.

| Provider | Endpoint | Block | Lag | `timestampMilliseconds` | Notes |
| --- | --- | ---: | ---: | --- | --- |
| Ava Labs official | `https://api.avax.network/ext/bc/C/rpc` | 85296609 | 5 | yes | Official public C-Chain endpoint. |
| dRPC | `https://avalanche.drpc.org` | 85296613 | 1 | yes | Open HTTPS RPC. |
| LeoRPC | `https://avax.leorpc.com/?api_key=FREE` | 85296614 | 0 | yes | Public `FREE` key URL. |
| Nodies C path | `https://avax-pokt.nodies.app/ext/bc/C/rpc` | 85296613 | 1 | yes | Open HTTPS RPC. |
| Nodies public ext | `https://avalanche-public.nodies.app/ext/bc/C/rpc` | 85296613 | 1 | yes | Open HTTPS RPC. |
| Pocket legacy | `https://avax.api.pocket.network` | 85296613 | 1 | yes | Open HTTPS RPC. |
| Polkachu | `https://avalanche-rpc.polkachu.com/ext/bc/C/rpc` | 85296614 | 0 | yes | Open HTTPS RPC. |
| PublicNode | `https://avalanche-c-chain-rpc.publicnode.com` | 85296613 | 1 | yes | Open HTTPS RPC. |
| PublicNode legacy | `https://avalanche-c-chain.publicnode.com` | 85296614 | 0 | yes | Also works, but the `-rpc` hostname is the one PublicNode advertises now. |
| Simply Staking | `https://spectrum-01.simplystaking.xyz/avalanche-mn-rpc/ext/bc/C/rpc` | 85296613 | 1 | yes | Open HTTPS RPC. |
| thirdweb | `https://avalanche.rpc.thirdweb.com` | 85296614 | 0 | yes | Open HTTPS RPC. |
| ZAN | `https://api.zan.top/avax-mainnet/ext/bc/C/rpc` | 85296613 | 1 | yes | Open HTTPS RPC. |

## Open But Not Benchmark-Ready

These are open C-Chain endpoints, but should not be used for the `timestampMilliseconds` benchmark without special handling.

| Provider | Endpoint | Result |
| --- | --- | --- |
| Tenderly | `https://avalanche.gateway.tenderly.co` | Chain ID `43114`, recent block `85296613`, but latest block response did not include `timestampMilliseconds`. |
| Tenderly mainnet | `https://avalanche-mainnet.gateway.tenderly.co` | Chain ID `43114`, recent block `85296614`, but latest block response did not include `timestampMilliseconds`. |
| GetBlock public | `https://go.getblock.io/3292d0f06570467b875988753301587f/ext/bc/C/rpc` | Returned chain ID `43114` and recent block in an initial probe, but repeated probes hit HTTP 429 quickly. Single block lookup did include `timestampMilliseconds`. |
| OnFinality | `https://avalanche.api.onfinality.io/public/ext/bc/C/rpc` | Returned chain ID `43114` and recent block in an initial probe, but repeated probes hit HTTP 429 quickly. Single block lookup did include `timestampMilliseconds`. |

## Listed But Not Open/Working

These appeared in public endpoint lists, but did not pass the no-key HTTPS C-Chain probe from this host.

| Provider | Endpoint | Probe result |
| --- | --- | --- |
| 1RPC | `https://1rpc.io/avax/c` | TLS connection failed from this host. |
| 0xRPC | `https://0xrpc.io/avax` | HTTP 404. |
| Allnodes public-rpc | `https://avalanche.public-rpc.com` | HTTP 403 with Ankr auth-required error. |
| Ankr | `https://rpc.ankr.com/avalanche` | JSON-RPC error says API key is required. |
| Blast | `https://ava-mainnet.public.blastapi.io/ext/bc/C/rpc` | HTTP 403; response says Blast API is no longer available. |
| BlockPI | `https://avalanche.public.blockpi.network/v1/rpc/public` | HTTP 400. Current BlockPI docs show API-key URLs. |
| DexGuru | `https://public-stage-lax.dexguru.biz/rpc/43114/GoQ7lSlHLwC9NyLzfFt0LcRjdjwOIkRhOTtjcy55t2o` | TLS certificate verification failed. |
| ENVIO HyperSync | `https://avalanche.rpc.hypersync.xyz` | HTTP 401; token required. |
| GMX infra | `https://avalanche-api.gmxinfra.io` | HTTP 404; this is not a plain public JSON-RPC endpoint. |
| Lava | `https://avax1.lava.build` | HTTP 403. |
| MeowRPC | `https://avax.meowrpc.com` | HTTP 404. |
| Nodies root | `https://avalanche-public.nodies.app` | HTTP 404 without `/ext/bc/C/rpc`. |
| Nodies POKT root | `https://avax-pokt.nodies.app` | HTTP 404 without `/ext/bc/C/rpc`. |
| Nodies C no-rpc | `https://avax-pokt.nodies.app/ext/bc/C/` | HTTP 404. |
| OMNIA | `https://endpoints.omniatech.io/v1/avax/mainnet/public` | HTTP 521. |
| OwlRPC | `https://rpc.owlracle.info/avax/70d38ce1826c4a60bb2a8e05a6c8b20f` | HTTP 401. |
| Pocket gateway | `https://avax-rpc.gateway.pokt.network` | DNS resolution failed. |
| Poolz | `https://rpc.poolz.finance/avalanche` | DNS resolution failed. |
| Stackup | `https://public.stackup.sh/api/v1/node/avalanche-mainnet` | DNS resolution failed. |
| SubQuery | `https://avalanche.rpc.subquery.network/public` | DNS resolution failed. |
| Tatum avax-x | `https://avax-x-mainnet.gateway.tatum.io` | HTTP 402 Payment Required. |
| Terminet | `https://avalancheapi.terminet.io/ext/bc/C/rpc` | Timed out. |
| TheRPC | `https://avalanche.therpc.io` | HTTP 525. |

## Sources Consulted

- Avalanche Builder Hub C-Chain RPC docs: https://build.avax.network/docs/rpcs/c-chain
- Ethereum Lists chain data for chain `43114`: https://raw.githubusercontent.com/ethereum-lists/chains/master/_data/chains/eip155-43114.json
- Buildscape Avalanche C-Chain RPC list: https://buildscape.org/chain/avalanche/development/rpcs
- CompareNodes Avalanche public endpoints: https://comparenodes.com/library/public-endpoints/avalanche/
- BiuBiu/ChainList-derived Avalanche endpoint list: https://biubiu.tools/chains/avalanche
- RPC.info Avalanche C-Chain list: https://rpc.info/avalanche-c-chain
- POKT public endpoint docs: https://docs.pokt.network/developers/public-endpoints
