// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20 {
    function balanceOf(address) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(
        address from,
        address to,
        uint256 amount
    ) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
}

// === POOL INTERFACES ===

interface IUniV3Pool {
    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata data
    ) external returns (int256, int256);
    function token0() external view returns (address);
    function token1() external view returns (address);
}

interface IAlgebraPool {
    function swap(
        address recipient,
        bool zeroForOne,
        int256 amountSpecified,
        uint160 sqrtPriceLimitX96,
        bytes calldata data
    ) external returns (int256, int256);
    function token0() external view returns (address);
    function token1() external view returns (address);
}

interface ILFJV1Pair {
    function swap(
        uint amount0Out,
        uint amount1Out,
        address to,
        bytes calldata data
    ) external;
    function getReserves() external view returns (uint112, uint112, uint32);
    function token0() external view returns (address);
    function token1() external view returns (address);
}

interface ILBPair {
    function swap(
        bool swapForY,
        address to
    ) external returns (bytes32 amountsOut);
    function getTokenX() external view returns (address);
    function getTokenY() external view returns (address);
}

interface IDODOPool {
    function sellBase(address to) external returns (uint256);
    function sellQuote(address to) external returns (uint256);
    function _BASE_TOKEN_() external view returns (address);
    function _QUOTE_TOKEN_() external view returns (address);
}

interface IWooRouter {
    function swap(
        address fromToken,
        address toToken,
        uint256 fromAmount,
        uint256 minToAmount,
        address payable to,
        address rebateTo
    ) external payable returns (uint256);
}

interface IPharaohV1Pair {
    function swap(
        uint amount0Out,
        uint amount1Out,
        address to,
        bytes calldata data
    ) external;
    function metadata()
        external
        view
        returns (
            uint256 dec0,
            uint256 dec1,
            uint256 r0,
            uint256 r1,
            bool st,
            address t0,
            address t1
        );
    function getAmountOut(
        uint256 amountIn,
        address tokenIn
    ) external view returns (uint256);
}

interface IBalancerV3Vault {
    enum SwapKind {
        EXACT_IN,
        EXACT_OUT
    }
    struct VaultSwapParams {
        SwapKind kind;
        address pool;
        IERC20 tokenIn;
        IERC20 tokenOut;
        uint256 amountGivenRaw;
        uint256 limitRaw;
        bytes userData;
    }
    function unlock(bytes calldata data) external returns (bytes memory);
    function swap(
        VaultSwapParams calldata params
    )
        external
        returns (uint256 amountCalculated, uint256 amountIn, uint256 amountOut);
    function settle(
        IERC20 token,
        uint256 amountHint
    ) external returns (uint256 credit);
    function sendTo(IERC20 token, address to, uint256 amount) external;
}

/// @notice Hayabusa (隼) - MEV router for Avalanche
/// @dev Supports: UniV3, Pharaoh V3, Algebra, LFJ V1, LFJ V2, DODO, WOOFi, Balancer V3
contract Hayabusa {
    address public immutable owner;

    // Pool types
    uint8 constant UNIV3 = 0;
    uint8 constant ALGEBRA = 1;
    uint8 constant LFJ_V1 = 2;
    uint8 constant LFJ_V2 = 3;
    uint8 constant DODO = 4;
    uint8 constant WOOFI = 5;
    uint8 constant BALANCER_V3 = 6;
    uint8 constant PHARAOH_V1 = 7;
    uint8 constant PANGOLIN_V2 = 8;

    // V3 sqrt price limits
    uint160 constant MIN_SQRT_RATIO = 4295128739;
    uint160 constant MAX_SQRT_RATIO =
        1461446703485210103287273052203988822378723970342;

    // WOOFi router on Avalanche
    address constant WOOFI_ROUTER = 0x4c4AF8DBc524681930a27b2F1Af5bcC8062E6fB7;

    // Balancer V3 vault
    IBalancerV3Vault constant BALANCER_VAULT =
        IBalancerV3Vault(0xbA1333333333a1BA1108E8412f11850A5C319bA9);

    // Transient storage for callbacks
    address private _currentTokenIn;

    // Balancer V3 callback params
    address private _balPool;
    address private _balTokenIn;
    address private _balTokenOut;
    uint256 private _balAmountIn;

    constructor() {
        owner = msg.sender;
    }

    /// @notice Swap - pulls tokenIn from caller
    function swap(
        address[] calldata pools,
        uint8[] calldata poolTypes,
        address[] calldata tokens,
        uint256 amountIn
    ) external returns (uint256) {
        IERC20(tokens[0]).transferFrom(msg.sender, address(this), amountIn);
        return _execute(pools, poolTypes, tokens, amountIn);
    }

    /// @notice Quote - tokens must already be on contract (use with state override)
    function quote(
        address[] calldata pools,
        uint8[] calldata poolTypes,
        address[] calldata tokens,
        uint256 amountIn
    ) external returns (uint256) {
        return _execute(pools, poolTypes, tokens, amountIn);
    }

    function _execute(
        address[] calldata pools,
        uint8[] calldata poolTypes,
        address[] calldata tokens,
        uint256 amountIn
    ) internal returns (uint256 amountOut) {
        require(pools.length == poolTypes.length, "len");
        require(tokens.length == pools.length + 1, "tokens");
        require(pools.length >= 1 && pools.length <= 4, "hops");

        amountOut = amountIn;
        for (uint i = 0; i < pools.length; i++) {
            bool zeroForOne = _getDirection(pools[i], poolTypes[i], tokens[i]);
            if (poolTypes[i] == BALANCER_V3 || poolTypes[i] == WOOFI) {
                _balTokenOut = tokens[i + 1];
            }
            amountOut = _swap(
                pools[i],
                poolTypes[i],
                tokens[i],
                zeroForOne,
                amountOut
            );
        }
    }

    /// @notice Owner can withdraw any token
    function withdraw(address token) external {
        require(msg.sender == owner, "not owner");
        uint256 bal = IERC20(token).balanceOf(address(this));
        if (bal > 0) {
            IERC20(token).transfer(owner, bal);
        }
    }

    /// @notice Owner can withdraw ETH/AVAX
    function withdrawETH() external {
        require(msg.sender == owner, "not owner");
        uint256 bal = address(this).balance;
        if (bal > 0) {
            payable(owner).transfer(bal);
        }
    }

    function _getDirection(
        address pool,
        uint8 poolType,
        address tokenIn
    ) internal view returns (bool) {
        if (poolType == UNIV3) {
            return tokenIn == IUniV3Pool(pool).token0();
        } else if (poolType == ALGEBRA) {
            return tokenIn == IAlgebraPool(pool).token0();
        } else if (poolType == LFJ_V1 || poolType == PANGOLIN_V2) {
            return tokenIn == ILFJV1Pair(pool).token0();
        } else if (poolType == LFJ_V2) {
            return tokenIn == ILBPair(pool).getTokenX();
        } else if (poolType == DODO) {
            return tokenIn == IDODOPool(pool)._BASE_TOKEN_();
        } else if (poolType == PHARAOH_V1) {
            (, , , , , address t0, ) = IPharaohV1Pair(pool).metadata();
            return tokenIn == t0;
        }
        // WOOFI and BALANCER_V3 don't use direction
        return true;
    }

    function _swap(
        address pool,
        uint8 poolType,
        address tokenIn,
        bool zeroForOne,
        uint256 amountIn
    ) internal returns (uint256) {
        if (poolType == UNIV3) {
            return _swapUniV3(pool, tokenIn, zeroForOne, amountIn);
        } else if (poolType == ALGEBRA) {
            return _swapAlgebra(pool, tokenIn, zeroForOne, amountIn);
        } else if (poolType == LFJ_V1 || poolType == PANGOLIN_V2) {
            return _swapLFJV1(pool, tokenIn, zeroForOne, amountIn);
        } else if (poolType == LFJ_V2) {
            return _swapLFJV2(pool, tokenIn, zeroForOne, amountIn);
        } else if (poolType == DODO) {
            return _swapDODO(pool, tokenIn, zeroForOne, amountIn);
        } else if (poolType == WOOFI) {
            return _swapWooFi(tokenIn, amountIn);
        } else if (poolType == BALANCER_V3) {
            return _swapBalancerV3(pool, tokenIn, amountIn);
        } else if (poolType == PHARAOH_V1) {
            return _swapPharaohV1(pool, tokenIn, zeroForOne, amountIn);
        }
        revert("bad type");
    }

    // === V3-STYLE (CALLBACK) ===

    function _swapUniV3(
        address pool,
        address tokenIn,
        bool zeroForOne,
        uint256 amountIn
    ) internal returns (uint256) {
        address tokenOut = zeroForOne
            ? IUniV3Pool(pool).token1()
            : IUniV3Pool(pool).token0();
        _currentTokenIn = tokenIn;
        uint256 balBefore = IERC20(tokenOut).balanceOf(address(this));
        IUniV3Pool(pool).swap(
            address(this),
            zeroForOne,
            int256(amountIn),
            zeroForOne ? MIN_SQRT_RATIO + 1 : MAX_SQRT_RATIO - 1,
            ""
        );
        return IERC20(tokenOut).balanceOf(address(this)) - balBefore;
    }

    function _swapAlgebra(
        address pool,
        address tokenIn,
        bool zeroForOne,
        uint256 amountIn
    ) internal returns (uint256) {
        address tokenOut = zeroForOne
            ? IAlgebraPool(pool).token1()
            : IAlgebraPool(pool).token0();
        _currentTokenIn = tokenIn;
        uint256 balBefore = IERC20(tokenOut).balanceOf(address(this));
        IAlgebraPool(pool).swap(
            address(this),
            zeroForOne,
            int256(amountIn),
            zeroForOne ? MIN_SQRT_RATIO + 1 : MAX_SQRT_RATIO - 1,
            ""
        );
        return IERC20(tokenOut).balanceOf(address(this)) - balBefore;
    }

    // === TRANSFER-FIRST STYLE ===

    function _swapLFJV1(
        address pool,
        address tokenIn,
        bool zeroForOne,
        uint256 amountIn
    ) internal returns (uint256) {
        address tokenOut = zeroForOne
            ? ILFJV1Pair(pool).token1()
            : ILFJV1Pair(pool).token0();
        (uint112 r0, uint112 r1, ) = ILFJV1Pair(pool).getReserves();
        uint256 rIn = zeroForOne ? r0 : r1;
        uint256 rOut = zeroForOne ? r1 : r0;
        uint256 amountOut = (amountIn * 997 * rOut) /
            (rIn * 1000 + amountIn * 997);

        uint256 balBefore = IERC20(tokenOut).balanceOf(address(this));
        IERC20(tokenIn).transfer(pool, amountIn);
        if (zeroForOne) {
            ILFJV1Pair(pool).swap(0, amountOut, address(this), "");
        } else {
            ILFJV1Pair(pool).swap(amountOut, 0, address(this), "");
        }
        return IERC20(tokenOut).balanceOf(address(this)) - balBefore;
    }

    function _swapLFJV2(
        address pool,
        address tokenIn,
        bool zeroForOne,
        uint256 amountIn
    ) internal returns (uint256) {
        address tokenOut = zeroForOne
            ? ILBPair(pool).getTokenY()
            : ILBPair(pool).getTokenX();
        uint256 balBefore = IERC20(tokenOut).balanceOf(address(this));
        IERC20(tokenIn).transfer(pool, amountIn);
        ILBPair(pool).swap(zeroForOne, address(this));
        return IERC20(tokenOut).balanceOf(address(this)) - balBefore;
    }

    function _swapDODO(
        address pool,
        address tokenIn,
        bool zeroForOne,
        uint256 amountIn
    ) internal returns (uint256) {
        address tokenOut = zeroForOne
            ? IDODOPool(pool)._QUOTE_TOKEN_()
            : IDODOPool(pool)._BASE_TOKEN_();
        uint256 balBefore = IERC20(tokenOut).balanceOf(address(this));
        IERC20(tokenIn).transfer(pool, amountIn);
        if (zeroForOne) {
            IDODOPool(pool).sellBase(address(this));
        } else {
            IDODOPool(pool).sellQuote(address(this));
        }
        return IERC20(tokenOut).balanceOf(address(this)) - balBefore;
    }

    function _swapPharaohV1(
        address pool,
        address tokenIn,
        bool zeroForOne,
        uint256 amountIn
    ) internal returns (uint256) {
        (, , , , , address t0, address t1) = IPharaohV1Pair(pool).metadata();
        address tokenOut = zeroForOne ? t1 : t0;

        // Use pool's getAmountOut for correct fee handling
        uint256 amountOut = IPharaohV1Pair(pool).getAmountOut(
            amountIn,
            tokenIn
        );

        uint256 balBefore = IERC20(tokenOut).balanceOf(address(this));
        IERC20(tokenIn).transfer(pool, amountIn);
        if (zeroForOne) {
            IPharaohV1Pair(pool).swap(0, amountOut, address(this), "");
        } else {
            IPharaohV1Pair(pool).swap(amountOut, 0, address(this), "");
        }
        return IERC20(tokenOut).balanceOf(address(this)) - balBefore;
    }

    function _swapWooFi(
        address tokenIn,
        uint256 amountIn
    ) internal returns (uint256) {
        address tokenOut = _balTokenOut; // Set before calling
        uint256 balBefore = IERC20(tokenOut).balanceOf(address(this));
        IERC20(tokenIn).approve(WOOFI_ROUTER, amountIn);
        IWooRouter(WOOFI_ROUTER).swap(
            tokenIn,
            tokenOut,
            amountIn,
            0,
            payable(address(this)),
            address(0)
        );
        return IERC20(tokenOut).balanceOf(address(this)) - balBefore;
    }

    // === BALANCER V3 ===

    function _swapBalancerV3(
        address pool,
        address tokenIn,
        uint256 amountIn
    ) internal returns (uint256) {
        _balPool = pool;
        _balTokenIn = tokenIn;
        // _balTokenOut already set
        _balAmountIn = amountIn;

        uint256 balBefore = IERC20(_balTokenOut).balanceOf(address(this));
        BALANCER_VAULT.unlock(abi.encodeCall(this.balancerUnlockCallback, ()));
        return IERC20(_balTokenOut).balanceOf(address(this)) - balBefore;
    }

    function balancerUnlockCallback() external returns (uint256 amountOut) {
        require(msg.sender == address(BALANCER_VAULT), "only vault");
        IERC20(_balTokenIn).transfer(address(BALANCER_VAULT), _balAmountIn);
        BALANCER_VAULT.settle(IERC20(_balTokenIn), _balAmountIn);
        (, , amountOut) = BALANCER_VAULT.swap(
            IBalancerV3Vault.VaultSwapParams({
                kind: IBalancerV3Vault.SwapKind.EXACT_IN,
                pool: _balPool,
                tokenIn: IERC20(_balTokenIn),
                tokenOut: IERC20(_balTokenOut),
                amountGivenRaw: _balAmountIn,
                limitRaw: 0,
                userData: ""
            })
        );
        BALANCER_VAULT.sendTo(IERC20(_balTokenOut), address(this), amountOut);
    }

    // === CALLBACKS ===

    function uniswapV3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata
    ) external {
        uint256 amountToPay = amount0Delta > 0
            ? uint256(amount0Delta)
            : uint256(amount1Delta);
        IERC20(_currentTokenIn).transfer(msg.sender, amountToPay);
    }

    function algebraSwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata
    ) external {
        uint256 amountToPay = amount0Delta > 0
            ? uint256(amount0Delta)
            : uint256(amount1Delta);
        IERC20(_currentTokenIn).transfer(msg.sender, amountToPay);
    }

    function pangolinv3SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata
    ) external {
        uint256 amountToPay = amount0Delta > 0
            ? uint256(amount0Delta)
            : uint256(amount1Delta);
        IERC20(_currentTokenIn).transfer(msg.sender, amountToPay);
    }

    function ramsesV2SwapCallback(
        int256 amount0Delta,
        int256 amount1Delta,
        bytes calldata
    ) external {
        uint256 amountToPay = amount0Delta > 0
            ? uint256(amount0Delta)
            : uint256(amount1Delta);
        IERC20(_currentTokenIn).transfer(msg.sender, amountToPay);
    }

    receive() external payable {}
}
