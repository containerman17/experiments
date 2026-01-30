package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/ava-labs/avalanchego/api/info"
	"github.com/ava-labs/avalanchego/genesis"
	"github.com/ava-labs/avalanchego/ids"
	"github.com/ava-labs/avalanchego/utils/constants"
	"github.com/ava-labs/avalanchego/utils/units"
	"github.com/ava-labs/avalanchego/vms/platformvm/txs"
	"github.com/ava-labs/avalanchego/vms/secp256k1fx"
	"github.com/ava-labs/avalanchego/wallet/subnet/primary"
	"github.com/spf13/cobra"
)

const (
	baseHTTPPort        = 9100
	portIncrement       = 100
	nodeHealthTimeout   = 2 * time.Second
	nodeStartupTimeout  = 60 * time.Second
	healthCheckInterval = 200 * time.Millisecond
)

type Result struct {
	DataDir  string `json:"dataDir"`
	ChainID  string `json:"chainId"`
	SubnetID string `json:"subnetId"`
	RPCURL   string `json:"rpcUrl"`
	PIDs     []int  `json:"pids"`
}

type NodeInfo struct {
	NodeID string
	URI    string
	PID    int
}

type ChainResult struct {
	SubnetID string `json:"subnetId"`
	ChainID  string `json:"chainId"`
}

var (
	dataDir         string
	outputPath      string
	validators      int
	background      bool
	chainName       string
	nodeURI         string
	l1NodeURI       string
	genesisPath     string
	chainConfigPath string
	subnetIDStr     string
	chainIDStr      string
)

func main() {
	rootCmd := &cobra.Command{Use: "network", Short: "L1 Network Manager"}

	startCmd := &cobra.Command{Use: "start", Short: "Start network", RunE: runStart}
	startCmd.Flags().StringVar(&dataDir, "data-dir", "./network_data", "Data directory")
	startCmd.Flags().StringVar(&outputPath, "output", "./network-info.json", "Output file")
	startCmd.Flags().IntVar(&validators, "validators", 1, "Number of L1 validators")
	startCmd.Flags().BoolVar(&background, "background", false, "Run in background")
	startCmd.Flags().StringVar(&chainName, "chain-name", "testchain", "Chain name")

	stopCmd := &cobra.Command{Use: "stop", Short: "Stop network", RunE: runStop}
	stopCmd.Flags().StringVar(&outputPath, "info", "./network-info.json", "Network info file")

	createChainCmd := &cobra.Command{Use: "create-chain", Short: "Create subnet and chain", RunE: runCreateChain}
	createChainCmd.Flags().StringVar(&nodeURI, "node-uri", "", "Node URI to connect to")
	createChainCmd.Flags().StringVar(&genesisPath, "genesis", "./genesis.json", "Genesis file path")
	createChainCmd.Flags().StringVar(&chainConfigPath, "chain-config", "./chain-config.json", "Chain config path")
	createChainCmd.Flags().StringVar(&chainName, "chain-name", "testchain", "Chain name")
	createChainCmd.MarkFlagRequired("node-uri")

	convertToL1Cmd := &cobra.Command{Use: "convert-to-l1", Short: "Convert subnet to L1", RunE: runConvertToL1}
	convertToL1Cmd.Flags().StringVar(&nodeURI, "node-uri", "", "Primary node URI")
	convertToL1Cmd.Flags().StringVar(&l1NodeURI, "l1-node-uri", "", "L1 validator node URI")
	convertToL1Cmd.Flags().StringVar(&subnetIDStr, "subnet-id", "", "Subnet ID")
	convertToL1Cmd.Flags().StringVar(&chainIDStr, "chain-id", "", "Chain ID")
	convertToL1Cmd.MarkFlagRequired("node-uri")
	convertToL1Cmd.MarkFlagRequired("l1-node-uri")
	convertToL1Cmd.MarkFlagRequired("subnet-id")
	convertToL1Cmd.MarkFlagRequired("chain-id")

	rootCmd.AddCommand(startCmd, stopCmd, createChainCmd, convertToL1Cmd)
	if err := rootCmd.Execute(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func runCreateChain(cmd *cobra.Command, args []string) error {
	ctx := context.Background()

	genesisBytes, err := os.ReadFile(genesisPath)
	if err != nil {
		return fmt.Errorf("failed to read genesis: %w", err)
	}

	kc := secp256k1fx.NewKeychain(genesis.EWOQKey)
	wallet, err := primary.MakePWallet(ctx, nodeURI, kc, primary.WalletConfig{})
	if err != nil {
		return fmt.Errorf("failed to create wallet: %w", err)
	}

	owner := &secp256k1fx.OutputOwners{Threshold: 1, Addrs: []ids.ShortID{genesis.EWOQKey.Address()}}
	subnetTx, err := wallet.IssueCreateSubnetTx(owner)
	if err != nil {
		return fmt.Errorf("failed to create subnet: %w", err)
	}
	subnetID := subnetTx.ID()

	wallet, err = primary.MakePWallet(ctx, nodeURI, kc, primary.WalletConfig{SubnetIDs: []ids.ID{subnetID}})
	if err != nil {
		return fmt.Errorf("failed to refresh wallet: %w", err)
	}

	chainTx, err := wallet.IssueCreateChainTx(subnetID, genesisBytes, constants.SubnetEVMID, nil, chainName)
	if err != nil {
		return fmt.Errorf("failed to create chain: %w", err)
	}
	chainID := chainTx.ID()

	result := ChainResult{
		SubnetID: subnetID.String(),
		ChainID:  chainID.String(),
	}
	data, _ := json.Marshal(result)
	fmt.Println(string(data))
	return nil
}

func runConvertToL1(cmd *cobra.Command, args []string) error {
	ctx := context.Background()

	subnetID, err := ids.FromString(subnetIDStr)
	if err != nil {
		return fmt.Errorf("invalid subnet ID: %w", err)
	}

	chainID, err := ids.FromString(chainIDStr)
	if err != nil {
		return fmt.Errorf("invalid chain ID: %w", err)
	}

	infoClient := info.NewClient(l1NodeURI)
	nodeID, nodePoP, err := infoClient.GetNodeID(ctx)
	if err != nil {
		return fmt.Errorf("failed to get L1 node info: %w", err)
	}

	validators := []*txs.ConvertSubnetToL1Validator{
		{
			NodeID:  nodeID.Bytes(),
			Weight:  units.Schmeckle,
			Balance: units.Avax,
			Signer:  *nodePoP,
		},
	}

	kc := secp256k1fx.NewKeychain(genesis.EWOQKey)
	wallet, err := primary.MakePWallet(ctx, nodeURI, kc, primary.WalletConfig{SubnetIDs: []ids.ID{subnetID}})
	if err != nil {
		return fmt.Errorf("failed to create wallet: %w", err)
	}

	_, err = wallet.IssueConvertSubnetToL1Tx(subnetID, chainID, []byte{}, validators)
	if err != nil {
		return fmt.Errorf("failed to convert to L1: %w", err)
	}

	fmt.Println("Subnet converted to L1 successfully")
	return nil
}

func runStart(cmd *cobra.Command, args []string) error {
	ctx, cancel := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	result, err := startNetwork(ctx, dataDir, validators, chainName)
	if err != nil {
		return err
	}

	data, _ := json.MarshalIndent(result, "", "  ")
	os.WriteFile(outputPath, data, 0644)

	fmt.Println("\n==========================================")
	fmt.Printf("Chain ID:  %s\n", result.ChainID)
	fmt.Printf("Subnet ID: %s\n", result.SubnetID)
	fmt.Printf("RPC URL:   %s\n", result.RPCURL)
	fmt.Println("==========================================")

	if background {
		return nil
	}

	fmt.Println("Press Ctrl+C to stop...")
	<-ctx.Done()
	stopNetwork(result.PIDs)
	return nil
}

func runStop(cmd *cobra.Command, args []string) error {
	data, err := os.ReadFile(outputPath)
	if err != nil {
		_ = exec.Command("pkill", "-f", "avalanchego").Run()
		return nil
	}
	var result Result
	json.Unmarshal(data, &result)
	stopNetwork(result.PIDs)
	return nil
}

func startNetwork(ctx context.Context, dataDir string, validatorCount int, chainName string) (*Result, error) {
	dataDirAbs, _ := filepath.Abs(dataDir)
	os.RemoveAll(dataDirAbs)
	os.MkdirAll(dataDirAbs, 0755)

	if err := copyStakingKeys(dataDirAbs); err != nil {
		return nil, err
	}

	avalanchego, _ := filepath.Abs("./bin/avalanchego")
	pluginDir, _ := filepath.Abs("./bin/plugins")
	nodeConfig, _ := filepath.Abs("./node-config.json")

	fmt.Printf("Network dir: %s\n", dataDirAbs)

	var allPIDs []int

	// Start 2 primary nodes
	fmt.Println("Starting primary network...")
	node0, err := startNode(ctx, avalanchego, dataDirAbs, 0, pluginDir, "", nodeConfig)
	if err != nil {
		return nil, fmt.Errorf("bootstrap node failed: %w", err)
	}
	allPIDs = append(allPIDs, node0.PID)
	fmt.Printf("  Node 0: %s\n", node0.NodeID)

	node1, err := startNode(ctx, avalanchego, dataDirAbs, 1, pluginDir, node0.NodeID, nodeConfig)
	if err != nil {
		killPIDs(allPIDs)
		return nil, fmt.Errorf("node 1 failed: %w", err)
	}
	allPIDs = append(allPIDs, node1.PID)
	fmt.Printf("  Node 1: %s\n", node1.NodeID)

	// Load genesis
	genesisBytes, _ := os.ReadFile("./genesis.json")
	chainConfigBytes, _ := os.ReadFile("./chain-config.json")

	// Create subnet and chain
	fmt.Println("Creating subnet and chain...")
	kc := secp256k1fx.NewKeychain(genesis.EWOQKey)
	wallet, err := primary.MakePWallet(ctx, node0.URI, kc, primary.WalletConfig{})
	if err != nil {
		killPIDs(allPIDs)
		return nil, err
	}

	owner := &secp256k1fx.OutputOwners{Threshold: 1, Addrs: []ids.ShortID{genesis.EWOQKey.Address()}}
	subnetTx, err := wallet.IssueCreateSubnetTx(owner)
	if err != nil {
		killPIDs(allPIDs)
		return nil, err
	}
	subnetID := subnetTx.ID()
	fmt.Printf("  Subnet: %s\n", subnetID)

	wallet, _ = primary.MakePWallet(ctx, node0.URI, kc, primary.WalletConfig{SubnetIDs: []ids.ID{subnetID}})
	chainTx, err := wallet.IssueCreateChainTx(subnetID, genesisBytes, constants.SubnetEVMID, nil, chainName)
	if err != nil {
		killPIDs(allPIDs)
		return nil, err
	}
	chainID := chainTx.ID()
	fmt.Printf("  Chain:  %s\n", chainID)

	// Write chain config to primary nodes
	for i := 0; i < 2; i++ {
		nodeDir := filepath.Join(dataDirAbs, fmt.Sprintf("node-%d", i))
		writeChainConfig(nodeDir, chainID.String(), chainConfigBytes)
	}

	// Start L1 validators
	fmt.Printf("Starting %d L1 validator(s)...\n", validatorCount)
	var l1Nodes []*NodeInfo
	for i := 0; i < validatorCount; i++ {
		nodeIdx := 2 + i
		l1NodeDir := filepath.Join(dataDirAbs, fmt.Sprintf("l1-validator-%d", nodeIdx))
		os.MkdirAll(l1NodeDir, 0755)
		writeChainConfig(l1NodeDir, chainID.String(), chainConfigBytes)

		l1Node, err := startL1Node(ctx, avalanchego, dataDirAbs, nodeIdx, pluginDir, node0.NodeID, subnetID.String(), nodeConfig)
		if err != nil {
			killPIDs(allPIDs)
			return nil, err
		}
		l1Nodes = append(l1Nodes, l1Node)
		allPIDs = append(allPIDs, l1Node.PID)
		fmt.Printf("  L1 Validator %d: %s\n", i+1, l1Node.NodeID)
	}

	// Convert to L1
	fmt.Println("Converting subnet to L1...")
	var validators []*txs.ConvertSubnetToL1Validator
	for _, node := range l1Nodes {
		infoClient := info.NewClient(node.URI)
		nodeID, nodePoP, _ := infoClient.GetNodeID(ctx)
		validators = append(validators, &txs.ConvertSubnetToL1Validator{
			NodeID: nodeID.Bytes(), Weight: units.Schmeckle, Balance: units.Avax, Signer: *nodePoP,
		})
	}
	_, err = wallet.IssueConvertSubnetToL1Tx(subnetID, chainID, []byte{}, validators)
	if err != nil {
		killPIDs(allPIDs)
		return nil, err
	}

	time.Sleep(5 * time.Second)

	return &Result{
		DataDir:  dataDirAbs,
		ChainID:  chainID.String(),
		SubnetID: subnetID.String(),
		RPCURL:   fmt.Sprintf("%s/ext/bc/%s/rpc", l1Nodes[0].URI, chainID),
		PIDs:     allPIDs,
	}, nil
}

func startNode(ctx context.Context, avalanchego, networkDir string, idx int, pluginDir, bootstrapID, nodeConfig string) (*NodeInfo, error) {
	httpPort := baseHTTPPort + idx*portIncrement
	nodeDir := filepath.Join(networkDir, fmt.Sprintf("node-%d", idx))
	os.MkdirAll(filepath.Join(nodeDir, "db"), 0755)
	os.MkdirAll(filepath.Join(nodeDir, "logs"), 0755)

	stakingDir := filepath.Join(networkDir, "staking", "local")
	args := nodeArgs(httpPort, nodeDir, pluginDir, nodeConfig)
	args = append(args,
		fmt.Sprintf("--staking-tls-cert-file=%s/staker%d.crt", stakingDir, idx+1),
		fmt.Sprintf("--staking-tls-key-file=%s/staker%d.key", stakingDir, idx+1),
		fmt.Sprintf("--staking-signer-key-file=%s/signer%d.key", stakingDir, idx+1),
	)
	if bootstrapID != "" {
		args = append(args, fmt.Sprintf("--bootstrap-ips=127.0.0.1:%d", baseHTTPPort+1), fmt.Sprintf("--bootstrap-ids=%s", bootstrapID))
	} else {
		args = append(args, "--bootstrap-ips=", "--bootstrap-ids=")
	}

	cmd := exec.Command(avalanchego, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	logFile, _ := os.Create(filepath.Join(nodeDir, "logs", "process.log"))
	cmd.Stdout, cmd.Stderr = logFile, logFile
	if err := cmd.Start(); err != nil {
		return nil, err
	}

	uri := fmt.Sprintf("http://127.0.0.1:%d", httpPort)
	nodeID, err := waitForHealth(ctx, uri, cmd.Process.Pid)
	if err != nil {
		cmd.Process.Kill()
		return nil, err
	}
	return &NodeInfo{NodeID: nodeID, URI: uri, PID: cmd.Process.Pid}, nil
}

func startL1Node(ctx context.Context, avalanchego, networkDir string, idx int, pluginDir, bootstrapID, subnetID, nodeConfig string) (*NodeInfo, error) {
	httpPort := baseHTTPPort + idx*portIncrement
	nodeDir := filepath.Join(networkDir, fmt.Sprintf("l1-validator-%d", idx))
	os.MkdirAll(filepath.Join(nodeDir, "db"), 0755)
	os.MkdirAll(filepath.Join(nodeDir, "logs"), 0755)

	args := nodeArgs(httpPort, nodeDir, pluginDir, nodeConfig)
	args = append(args,
		"--staking-ephemeral-cert-enabled=true",
		"--staking-ephemeral-signer-enabled=true",
		fmt.Sprintf("--track-subnets=%s", subnetID),
		fmt.Sprintf("--bootstrap-ips=127.0.0.1:%d", baseHTTPPort+1),
		fmt.Sprintf("--bootstrap-ids=%s", bootstrapID),
	)

	cmd := exec.Command(avalanchego, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	logFile, _ := os.Create(filepath.Join(nodeDir, "logs", "process.log"))
	cmd.Stdout, cmd.Stderr = logFile, logFile
	if err := cmd.Start(); err != nil {
		return nil, err
	}

	uri := fmt.Sprintf("http://127.0.0.1:%d", httpPort)
	nodeID, err := waitForHealth(ctx, uri, cmd.Process.Pid)
	if err != nil {
		cmd.Process.Kill()
		return nil, err
	}
	return &NodeInfo{NodeID: nodeID, URI: uri, PID: cmd.Process.Pid}, nil
}

func nodeArgs(httpPort int, nodeDir, pluginDir, configPath string) []string {
	return []string{
		fmt.Sprintf("--http-port=%d", httpPort),
		fmt.Sprintf("--staking-port=%d", httpPort+1),
		fmt.Sprintf("--db-dir=%s/db", nodeDir),
		fmt.Sprintf("--log-dir=%s/logs", nodeDir),
		fmt.Sprintf("--chain-data-dir=%s/chainData", nodeDir),
		fmt.Sprintf("--data-dir=%s", nodeDir),
		"--network-id=local",
		"--http-host=127.0.0.1",
		"--sybil-protection-enabled=false",
		fmt.Sprintf("--plugin-dir=%s", pluginDir),
		fmt.Sprintf("--config-file=%s", configPath),
	}
}

func waitForHealth(ctx context.Context, uri string, pid int) (string, error) {
	deadline := time.Now().Add(nodeStartupTimeout)
	client := &http.Client{Timeout: nodeHealthTimeout}

	for time.Now().Before(deadline) {
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		default:
		}

		req, _ := http.NewRequest("POST", uri+"/ext/info", strings.NewReader(`{"jsonrpc":"2.0","id":1,"method":"info.getNodeID"}`))
		req.Header.Set("Content-Type", "application/json")
		resp, err := client.Do(req)
		if err == nil {
			var result struct {
				Result struct {
					NodeID string `json:"nodeID"`
				} `json:"result"`
			}
			json.NewDecoder(resp.Body).Decode(&result)
			resp.Body.Close()
			if result.Result.NodeID != "" {
				return result.Result.NodeID, nil
			}
		}
		time.Sleep(healthCheckInterval)
	}
	return "", fmt.Errorf("timeout waiting for node health")
}

func copyStakingKeys(networkDir string) error {
	srcDir := "./staking/local"
	dstDir := filepath.Join(networkDir, "staking", "local")
	os.MkdirAll(dstDir, 0755)

	entries, err := os.ReadDir(srcDir)
	if err != nil {
		return fmt.Errorf("staking keys not found at %s", srcDir)
	}
	for _, e := range entries {
		if !e.IsDir() {
			data, _ := os.ReadFile(filepath.Join(srcDir, e.Name()))
			os.WriteFile(filepath.Join(dstDir, e.Name()), data, 0644)
		}
	}
	return nil
}

func writeChainConfig(nodeDir, chainID string, config []byte) {
	dir := filepath.Join(nodeDir, "configs", "chains", chainID)
	os.MkdirAll(dir, 0755)
	os.WriteFile(filepath.Join(dir, "config.json"), config, 0644)
}

func stopNetwork(pids []int) {
	for _, pid := range pids {
		if p, err := os.FindProcess(pid); err == nil {
			p.Signal(syscall.SIGTERM)
		}
	}
	time.Sleep(500 * time.Millisecond)
	exec.Command("pkill", "-f", "avalanchego").Run()
}

func killPIDs(pids []int) {
	for _, pid := range pids {
		if p, err := os.FindProcess(pid); err == nil {
			p.Kill()
		}
	}
}
