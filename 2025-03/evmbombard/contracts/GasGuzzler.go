// Code generated - DO NOT EDIT.
// This file is a generated binding and any manual changes will be lost.

package contracts

import (
	"errors"
	"math/big"
	"strings"

	ethereum "github.com/ethereum/go-ethereum"
	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/accounts/abi/bind"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/core/types"
	"github.com/ethereum/go-ethereum/event"
)

// Reference imports to suppress errors if they are not otherwise used.
var (
	_ = errors.New
	_ = big.NewInt
	_ = strings.NewReader
	_ = ethereum.NotFound
	_ = bind.Bind
	_ = common.Big1
	_ = types.BloomLookup
	_ = event.NewSubscription
	_ = abi.ConvertType
)

// ContractsMetaData contains all meta data concerning the Contracts contract.
var ContractsMetaData = &bind.MetaData{
	ABI: "[{\"inputs\":[{\"internalType\":\"address\",\"name\":\"\",\"type\":\"address\"}],\"name\":\"balanceOf\",\"outputs\":[{\"internalType\":\"uint256\",\"name\":\"\",\"type\":\"uint256\"}],\"stateMutability\":\"view\",\"type\":\"function\"},{\"inputs\":[{\"internalType\":\"uint64\",\"name\":\"intensity\",\"type\":\"uint64\"}],\"name\":\"consumeCPU\",\"outputs\":[],\"stateMutability\":\"nonpayable\",\"type\":\"function\"},{\"inputs\":[{\"internalType\":\"address\",\"name\":\"to\",\"type\":\"address\"},{\"internalType\":\"uint256\",\"name\":\"amount\",\"type\":\"uint256\"}],\"name\":\"simulateTransfer\",\"outputs\":[{\"internalType\":\"bool\",\"name\":\"\",\"type\":\"bool\"}],\"stateMutability\":\"nonpayable\",\"type\":\"function\"},{\"inputs\":[],\"name\":\"someValue\",\"outputs\":[{\"internalType\":\"uint256\",\"name\":\"\",\"type\":\"uint256\"}],\"stateMutability\":\"view\",\"type\":\"function\"},{\"inputs\":[{\"internalType\":\"address\",\"name\":\"\",\"type\":\"address\"}],\"name\":\"userValues\",\"outputs\":[{\"internalType\":\"uint256\",\"name\":\"\",\"type\":\"uint256\"}],\"stateMutability\":\"view\",\"type\":\"function\"},{\"inputs\":[],\"name\":\"value\",\"outputs\":[{\"internalType\":\"uint256\",\"name\":\"\",\"type\":\"uint256\"}],\"stateMutability\":\"view\",\"type\":\"function\"},{\"inputs\":[{\"internalType\":\"uint256\",\"name\":\"\",\"type\":\"uint256\"}],\"name\":\"values\",\"outputs\":[{\"internalType\":\"bytes32\",\"name\":\"\",\"type\":\"bytes32\"}],\"stateMutability\":\"view\",\"type\":\"function\"}]",
	Bin: "0x6080604052348015600e575f5ffd5b506109218061001c5f395ff3fe608060405234801561000f575f5ffd5b506004361061007b575f3560e01c80634acfd9b8116100595780634acfd9b8146100eb578063510b45e31461011b5780635e383d211461013757806370a08231146101675761007b565b80631c171a8e1461007f5780633fa4f245146100af5780634a627e61146100cd575b5f5ffd5b6100996004803603810190610094919061052f565b610197565b6040516100a69190610587565b60405180910390f35b6100b76103dc565b6040516100c491906105af565b60405180910390f35b6100d56103e1565b6040516100e291906105af565b60405180910390f35b610105600480360381019061010091906105c8565b6103e7565b60405161011291906105af565b60405180910390f35b61013560048036038101906101309190610630565b6103fc565b005b610151600480360381019061014c919061065b565b610469565b60405161015e919061069e565b60405180910390f35b610181600480360381019061017c91906105c8565b610489565b60405161018e91906105af565b60405180910390f35b5f8160035f3373ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff1681526020019081526020015f2054101561023e57612710826101eb91906106e4565b60035f3373ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff1681526020019081526020015f205f8282546102369190610725565b925050819055505b8160035f3373ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff1681526020019081526020015f205410156102be576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004016102b5906107b2565b60405180910390fd5b8160035f3373ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff1681526020019081526020015f205f82825461030a91906107d0565b925050819055508160035f8573ffffffffffffffffffffffffffffffffffffffff1673ffffffffffffffffffffffffffffffffffffffff1681526020019081526020015f205f82825461035d9190610725565b925050819055505f5f90505b60028110156103d15760043384428460405160200161038b9493929190610868565b60405160208183030381529060405280519060200120908060018154018082558091505060019003905f5260205f20015f90919091909150558080600101915050610369565b506001905092915050565b5f5481565b60025481565b6001602052805f5260405f205f915090505481565b5f425f1b90505f5f90505b8267ffffffffffffffff168167ffffffffffffffff16101561045b5781816040516020016104369291906108c4565b6040516020818303038152906040528051906020012091508080600101915050610407565b50805f1c6002819055505050565b60048181548110610478575f80fd5b905f5260205f20015f915090505481565b6003602052805f5260405f205f915090505481565b5f5ffd5b5f73ffffffffffffffffffffffffffffffffffffffff82169050919050565b5f6104cb826104a2565b9050919050565b6104db816104c1565b81146104e5575f5ffd5b50565b5f813590506104f6816104d2565b92915050565b5f819050919050565b61050e816104fc565b8114610518575f5ffd5b50565b5f8135905061052981610505565b92915050565b5f5f604083850312156105455761054461049e565b5b5f610552858286016104e8565b92505060206105638582860161051b565b9150509250929050565b5f8115159050919050565b6105818161056d565b82525050565b5f60208201905061059a5f830184610578565b92915050565b6105a9816104fc565b82525050565b5f6020820190506105c25f8301846105a0565b92915050565b5f602082840312156105dd576105dc61049e565b5b5f6105ea848285016104e8565b91505092915050565b5f67ffffffffffffffff82169050919050565b61060f816105f3565b8114610619575f5ffd5b50565b5f8135905061062a81610606565b92915050565b5f602082840312156106455761064461049e565b5b5f6106528482850161061c565b91505092915050565b5f602082840312156106705761066f61049e565b5b5f61067d8482850161051b565b91505092915050565b5f819050919050565b61069881610686565b82525050565b5f6020820190506106b15f83018461068f565b92915050565b7f4e487b71000000000000000000000000000000000000000000000000000000005f52601160045260245ffd5b5f6106ee826104fc565b91506106f9836104fc565b9250828202610707816104fc565b9150828204841483151761071e5761071d6106b7565b5b5092915050565b5f61072f826104fc565b915061073a836104fc565b9250828201905080821115610752576107516106b7565b5b92915050565b5f82825260208201905092915050565b7f496e73756666696369656e742062616c616e63650000000000000000000000005f82015250565b5f61079c601483610758565b91506107a782610768565b602082019050919050565b5f6020820190508181035f8301526107c981610790565b9050919050565b5f6107da826104fc565b91506107e5836104fc565b92508282039050818111156107fd576107fc6106b7565b5b92915050565b5f8160601b9050919050565b5f61081982610803565b9050919050565b5f61082a8261080f565b9050919050565b61084261083d826104c1565b610820565b82525050565b5f819050919050565b61086261085d826104fc565b610848565b82525050565b5f6108738287610831565b6014820191506108838286610851565b6020820191506108938285610851565b6020820191506108a38284610851565b60208201915081905095945050505050565b6108be816105f3565b82525050565b5f6040820190506108d75f83018561068f565b6108e460208301846108b5565b939250505056fea2646970667358221220ad2b8bd598085f63bd6f7d9b4e8d90f220b8467e26a51c89bbb26f628048671c64736f6c634300081d0033",
}

// ContractsABI is the input ABI used to generate the binding from.
// Deprecated: Use ContractsMetaData.ABI instead.
var ContractsABI = ContractsMetaData.ABI

// ContractsBin is the compiled bytecode used for deploying new contracts.
// Deprecated: Use ContractsMetaData.Bin instead.
var ContractsBin = ContractsMetaData.Bin

// DeployContracts deploys a new Ethereum contract, binding an instance of Contracts to it.
func DeployContracts(auth *bind.TransactOpts, backend bind.ContractBackend) (common.Address, *types.Transaction, *Contracts, error) {
	parsed, err := ContractsMetaData.GetAbi()
	if err != nil {
		return common.Address{}, nil, nil, err
	}
	if parsed == nil {
		return common.Address{}, nil, nil, errors.New("GetABI returned nil")
	}

	address, tx, contract, err := bind.DeployContract(auth, *parsed, common.FromHex(ContractsBin), backend)
	if err != nil {
		return common.Address{}, nil, nil, err
	}
	return address, tx, &Contracts{ContractsCaller: ContractsCaller{contract: contract}, ContractsTransactor: ContractsTransactor{contract: contract}, ContractsFilterer: ContractsFilterer{contract: contract}}, nil
}

// Contracts is an auto generated Go binding around an Ethereum contract.
type Contracts struct {
	ContractsCaller     // Read-only binding to the contract
	ContractsTransactor // Write-only binding to the contract
	ContractsFilterer   // Log filterer for contract events
}

// ContractsCaller is an auto generated read-only Go binding around an Ethereum contract.
type ContractsCaller struct {
	contract *bind.BoundContract // Generic contract wrapper for the low level calls
}

// ContractsTransactor is an auto generated write-only Go binding around an Ethereum contract.
type ContractsTransactor struct {
	contract *bind.BoundContract // Generic contract wrapper for the low level calls
}

// ContractsFilterer is an auto generated log filtering Go binding around an Ethereum contract events.
type ContractsFilterer struct {
	contract *bind.BoundContract // Generic contract wrapper for the low level calls
}

// ContractsSession is an auto generated Go binding around an Ethereum contract,
// with pre-set call and transact options.
type ContractsSession struct {
	Contract     *Contracts        // Generic contract binding to set the session for
	CallOpts     bind.CallOpts     // Call options to use throughout this session
	TransactOpts bind.TransactOpts // Transaction auth options to use throughout this session
}

// ContractsCallerSession is an auto generated read-only Go binding around an Ethereum contract,
// with pre-set call options.
type ContractsCallerSession struct {
	Contract *ContractsCaller // Generic contract caller binding to set the session for
	CallOpts bind.CallOpts    // Call options to use throughout this session
}

// ContractsTransactorSession is an auto generated write-only Go binding around an Ethereum contract,
// with pre-set transact options.
type ContractsTransactorSession struct {
	Contract     *ContractsTransactor // Generic contract transactor binding to set the session for
	TransactOpts bind.TransactOpts    // Transaction auth options to use throughout this session
}

// ContractsRaw is an auto generated low-level Go binding around an Ethereum contract.
type ContractsRaw struct {
	Contract *Contracts // Generic contract binding to access the raw methods on
}

// ContractsCallerRaw is an auto generated low-level read-only Go binding around an Ethereum contract.
type ContractsCallerRaw struct {
	Contract *ContractsCaller // Generic read-only contract binding to access the raw methods on
}

// ContractsTransactorRaw is an auto generated low-level write-only Go binding around an Ethereum contract.
type ContractsTransactorRaw struct {
	Contract *ContractsTransactor // Generic write-only contract binding to access the raw methods on
}

// NewContracts creates a new instance of Contracts, bound to a specific deployed contract.
func NewContracts(address common.Address, backend bind.ContractBackend) (*Contracts, error) {
	contract, err := bindContracts(address, backend, backend, backend)
	if err != nil {
		return nil, err
	}
	return &Contracts{ContractsCaller: ContractsCaller{contract: contract}, ContractsTransactor: ContractsTransactor{contract: contract}, ContractsFilterer: ContractsFilterer{contract: contract}}, nil
}

// NewContractsCaller creates a new read-only instance of Contracts, bound to a specific deployed contract.
func NewContractsCaller(address common.Address, caller bind.ContractCaller) (*ContractsCaller, error) {
	contract, err := bindContracts(address, caller, nil, nil)
	if err != nil {
		return nil, err
	}
	return &ContractsCaller{contract: contract}, nil
}

// NewContractsTransactor creates a new write-only instance of Contracts, bound to a specific deployed contract.
func NewContractsTransactor(address common.Address, transactor bind.ContractTransactor) (*ContractsTransactor, error) {
	contract, err := bindContracts(address, nil, transactor, nil)
	if err != nil {
		return nil, err
	}
	return &ContractsTransactor{contract: contract}, nil
}

// NewContractsFilterer creates a new log filterer instance of Contracts, bound to a specific deployed contract.
func NewContractsFilterer(address common.Address, filterer bind.ContractFilterer) (*ContractsFilterer, error) {
	contract, err := bindContracts(address, nil, nil, filterer)
	if err != nil {
		return nil, err
	}
	return &ContractsFilterer{contract: contract}, nil
}

// bindContracts binds a generic wrapper to an already deployed contract.
func bindContracts(address common.Address, caller bind.ContractCaller, transactor bind.ContractTransactor, filterer bind.ContractFilterer) (*bind.BoundContract, error) {
	parsed, err := ContractsMetaData.GetAbi()
	if err != nil {
		return nil, err
	}
	return bind.NewBoundContract(address, *parsed, caller, transactor, filterer), nil
}

// Call invokes the (constant) contract method with params as input values and
// sets the output to result. The result type might be a single field for simple
// returns, a slice of interfaces for anonymous returns and a struct for named
// returns.
func (_Contracts *ContractsRaw) Call(opts *bind.CallOpts, result *[]interface{}, method string, params ...interface{}) error {
	return _Contracts.Contract.ContractsCaller.contract.Call(opts, result, method, params...)
}

// Transfer initiates a plain transaction to move funds to the contract, calling
// its default method if one is available.
func (_Contracts *ContractsRaw) Transfer(opts *bind.TransactOpts) (*types.Transaction, error) {
	return _Contracts.Contract.ContractsTransactor.contract.Transfer(opts)
}

// Transact invokes the (paid) contract method with params as input values.
func (_Contracts *ContractsRaw) Transact(opts *bind.TransactOpts, method string, params ...interface{}) (*types.Transaction, error) {
	return _Contracts.Contract.ContractsTransactor.contract.Transact(opts, method, params...)
}

// Call invokes the (constant) contract method with params as input values and
// sets the output to result. The result type might be a single field for simple
// returns, a slice of interfaces for anonymous returns and a struct for named
// returns.
func (_Contracts *ContractsCallerRaw) Call(opts *bind.CallOpts, result *[]interface{}, method string, params ...interface{}) error {
	return _Contracts.Contract.contract.Call(opts, result, method, params...)
}

// Transfer initiates a plain transaction to move funds to the contract, calling
// its default method if one is available.
func (_Contracts *ContractsTransactorRaw) Transfer(opts *bind.TransactOpts) (*types.Transaction, error) {
	return _Contracts.Contract.contract.Transfer(opts)
}

// Transact invokes the (paid) contract method with params as input values.
func (_Contracts *ContractsTransactorRaw) Transact(opts *bind.TransactOpts, method string, params ...interface{}) (*types.Transaction, error) {
	return _Contracts.Contract.contract.Transact(opts, method, params...)
}

// BalanceOf is a free data retrieval call binding the contract method 0x70a08231.
//
// Solidity: function balanceOf(address ) view returns(uint256)
func (_Contracts *ContractsCaller) BalanceOf(opts *bind.CallOpts, arg0 common.Address) (*big.Int, error) {
	var out []interface{}
	err := _Contracts.contract.Call(opts, &out, "balanceOf", arg0)

	if err != nil {
		return *new(*big.Int), err
	}

	out0 := *abi.ConvertType(out[0], new(*big.Int)).(**big.Int)

	return out0, err

}

// BalanceOf is a free data retrieval call binding the contract method 0x70a08231.
//
// Solidity: function balanceOf(address ) view returns(uint256)
func (_Contracts *ContractsSession) BalanceOf(arg0 common.Address) (*big.Int, error) {
	return _Contracts.Contract.BalanceOf(&_Contracts.CallOpts, arg0)
}

// BalanceOf is a free data retrieval call binding the contract method 0x70a08231.
//
// Solidity: function balanceOf(address ) view returns(uint256)
func (_Contracts *ContractsCallerSession) BalanceOf(arg0 common.Address) (*big.Int, error) {
	return _Contracts.Contract.BalanceOf(&_Contracts.CallOpts, arg0)
}

// SomeValue is a free data retrieval call binding the contract method 0x4a627e61.
//
// Solidity: function someValue() view returns(uint256)
func (_Contracts *ContractsCaller) SomeValue(opts *bind.CallOpts) (*big.Int, error) {
	var out []interface{}
	err := _Contracts.contract.Call(opts, &out, "someValue")

	if err != nil {
		return *new(*big.Int), err
	}

	out0 := *abi.ConvertType(out[0], new(*big.Int)).(**big.Int)

	return out0, err

}

// SomeValue is a free data retrieval call binding the contract method 0x4a627e61.
//
// Solidity: function someValue() view returns(uint256)
func (_Contracts *ContractsSession) SomeValue() (*big.Int, error) {
	return _Contracts.Contract.SomeValue(&_Contracts.CallOpts)
}

// SomeValue is a free data retrieval call binding the contract method 0x4a627e61.
//
// Solidity: function someValue() view returns(uint256)
func (_Contracts *ContractsCallerSession) SomeValue() (*big.Int, error) {
	return _Contracts.Contract.SomeValue(&_Contracts.CallOpts)
}

// UserValues is a free data retrieval call binding the contract method 0x4acfd9b8.
//
// Solidity: function userValues(address ) view returns(uint256)
func (_Contracts *ContractsCaller) UserValues(opts *bind.CallOpts, arg0 common.Address) (*big.Int, error) {
	var out []interface{}
	err := _Contracts.contract.Call(opts, &out, "userValues", arg0)

	if err != nil {
		return *new(*big.Int), err
	}

	out0 := *abi.ConvertType(out[0], new(*big.Int)).(**big.Int)

	return out0, err

}

// UserValues is a free data retrieval call binding the contract method 0x4acfd9b8.
//
// Solidity: function userValues(address ) view returns(uint256)
func (_Contracts *ContractsSession) UserValues(arg0 common.Address) (*big.Int, error) {
	return _Contracts.Contract.UserValues(&_Contracts.CallOpts, arg0)
}

// UserValues is a free data retrieval call binding the contract method 0x4acfd9b8.
//
// Solidity: function userValues(address ) view returns(uint256)
func (_Contracts *ContractsCallerSession) UserValues(arg0 common.Address) (*big.Int, error) {
	return _Contracts.Contract.UserValues(&_Contracts.CallOpts, arg0)
}

// Value is a free data retrieval call binding the contract method 0x3fa4f245.
//
// Solidity: function value() view returns(uint256)
func (_Contracts *ContractsCaller) Value(opts *bind.CallOpts) (*big.Int, error) {
	var out []interface{}
	err := _Contracts.contract.Call(opts, &out, "value")

	if err != nil {
		return *new(*big.Int), err
	}

	out0 := *abi.ConvertType(out[0], new(*big.Int)).(**big.Int)

	return out0, err

}

// Value is a free data retrieval call binding the contract method 0x3fa4f245.
//
// Solidity: function value() view returns(uint256)
func (_Contracts *ContractsSession) Value() (*big.Int, error) {
	return _Contracts.Contract.Value(&_Contracts.CallOpts)
}

// Value is a free data retrieval call binding the contract method 0x3fa4f245.
//
// Solidity: function value() view returns(uint256)
func (_Contracts *ContractsCallerSession) Value() (*big.Int, error) {
	return _Contracts.Contract.Value(&_Contracts.CallOpts)
}

// Values is a free data retrieval call binding the contract method 0x5e383d21.
//
// Solidity: function values(uint256 ) view returns(bytes32)
func (_Contracts *ContractsCaller) Values(opts *bind.CallOpts, arg0 *big.Int) ([32]byte, error) {
	var out []interface{}
	err := _Contracts.contract.Call(opts, &out, "values", arg0)

	if err != nil {
		return *new([32]byte), err
	}

	out0 := *abi.ConvertType(out[0], new([32]byte)).(*[32]byte)

	return out0, err

}

// Values is a free data retrieval call binding the contract method 0x5e383d21.
//
// Solidity: function values(uint256 ) view returns(bytes32)
func (_Contracts *ContractsSession) Values(arg0 *big.Int) ([32]byte, error) {
	return _Contracts.Contract.Values(&_Contracts.CallOpts, arg0)
}

// Values is a free data retrieval call binding the contract method 0x5e383d21.
//
// Solidity: function values(uint256 ) view returns(bytes32)
func (_Contracts *ContractsCallerSession) Values(arg0 *big.Int) ([32]byte, error) {
	return _Contracts.Contract.Values(&_Contracts.CallOpts, arg0)
}

// ConsumeCPU is a paid mutator transaction binding the contract method 0x510b45e3.
//
// Solidity: function consumeCPU(uint64 intensity) returns()
func (_Contracts *ContractsTransactor) ConsumeCPU(opts *bind.TransactOpts, intensity uint64) (*types.Transaction, error) {
	return _Contracts.contract.Transact(opts, "consumeCPU", intensity)
}

// ConsumeCPU is a paid mutator transaction binding the contract method 0x510b45e3.
//
// Solidity: function consumeCPU(uint64 intensity) returns()
func (_Contracts *ContractsSession) ConsumeCPU(intensity uint64) (*types.Transaction, error) {
	return _Contracts.Contract.ConsumeCPU(&_Contracts.TransactOpts, intensity)
}

// ConsumeCPU is a paid mutator transaction binding the contract method 0x510b45e3.
//
// Solidity: function consumeCPU(uint64 intensity) returns()
func (_Contracts *ContractsTransactorSession) ConsumeCPU(intensity uint64) (*types.Transaction, error) {
	return _Contracts.Contract.ConsumeCPU(&_Contracts.TransactOpts, intensity)
}

// SimulateTransfer is a paid mutator transaction binding the contract method 0x1c171a8e.
//
// Solidity: function simulateTransfer(address to, uint256 amount) returns(bool)
func (_Contracts *ContractsTransactor) SimulateTransfer(opts *bind.TransactOpts, to common.Address, amount *big.Int) (*types.Transaction, error) {
	return _Contracts.contract.Transact(opts, "simulateTransfer", to, amount)
}

// SimulateTransfer is a paid mutator transaction binding the contract method 0x1c171a8e.
//
// Solidity: function simulateTransfer(address to, uint256 amount) returns(bool)
func (_Contracts *ContractsSession) SimulateTransfer(to common.Address, amount *big.Int) (*types.Transaction, error) {
	return _Contracts.Contract.SimulateTransfer(&_Contracts.TransactOpts, to, amount)
}

// SimulateTransfer is a paid mutator transaction binding the contract method 0x1c171a8e.
//
// Solidity: function simulateTransfer(address to, uint256 amount) returns(bool)
func (_Contracts *ContractsTransactorSession) SimulateTransfer(to common.Address, amount *big.Int) (*types.Transaction, error) {
	return _Contracts.Contract.SimulateTransfer(&_Contracts.TransactOpts, to, amount)
}
