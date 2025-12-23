The goal of this experiment is to show a dollar equvalent prices of tokens.

First we have to discover all tokens and their 1 dollar values.

We will use up to 3 hops quotes to gauge 1 dollar value of the token.

This one dollar amount doesnt have to be precise, this is just a rough gauge of a minimum valuable amount. usually if we find good pprices for $1 worth of a token, it's a pretty high chance that there is some depth in the pool and quotes for 50-100 bucks would be somehow adequate.

For sstarters lets try finding this 1 dollar volume for wavax, then for all tokens.

Then once we have volumes, let's play with dollarStream. Do not do that yet

## Design Notes

**Why dollar quoting?** We will multiply dollar quotes to estimate the best routes, then test those routes with real values.

Dollar amount quoting can be brute force - doesn't matter for initial discovery.

Once we get amounts, cache them for hours. For pool price quoting:
- Quote particular pools for particular directions
- Just 2 requests per 2-token pool (6 for 3-token pools)

The code-heavy part is finding all possible routes for brute force quoting. 

### Implementation Progress:
- [x] Verified state override for balance injection works on high-performance RPC. <!-- id: progress_1 -->
- [x] Found 27 USDC-WAVAX pools for initial testing. <!-- id: progress_2 -->
- [x] Updated `quote_wavax.ts` to use the new RPC and exit after the first success. <!-- id: progress_3 -->
- [x] Identified that `ROUTER_CONTRACT` 0x8452 is missing functions. Switching to old 0xcc57. <!-- id: progress_4 -->

### Next Steps:
- Execute `quote_wavax.ts` using 0xcc57 router.
- Once WAVAX 1 dollar value is found, expand to all tokens.
- Implement the `DollarQuoter.ts` abstraction.