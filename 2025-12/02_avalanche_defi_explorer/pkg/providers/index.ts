import { type PoolProvider } from './_types.ts'
import { algebra } from './algebra.ts'
import { arenaV2 } from './arena_v2.ts'
import { balancerV3 } from './balancer_v3.ts'
import { dodo } from './dodo.ts'
import { lfjV1 } from './lfj_v1.ts'
import { lfjV2 } from './lfj_v2.ts'
import { pangolinV2 } from './pangolin_v2.ts'
import { pharaohV1 } from './pharaoh_v1.ts'
import { pharaohV3 } from './pharaoh_v3.ts'
import { uniswapV3 } from './uniswap_v3.ts'
import { woofiV2 } from './woofi_v2.ts'

export const providers: PoolProvider[] = [
    algebra,
    arenaV2,
    balancerV3,
    dodo,
    lfjV1,
    lfjV2,
    pangolinV2,
    pharaohV1,
    pharaohV3,
    uniswapV3,
    woofiV2,
]
