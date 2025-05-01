const firstBlock = 212000;

type Tx = {
    unsignedTx: Record<string, any>
    id: string
    tx: any[]
}

async function getHeight(): Promise<{ result: { height: string } }> {
    const response = await fetch('http://127.0.0.1:9654/ext/bc/P', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            jsonrpc: '2.0',
            method: 'platform.getHeight',
            params: {},
            id: 1
        })
    });
    return response.json() as Promise<{ result: { height: string } }>;
}

async function getBlockByHeight(blockHeight: number): Promise<{ result: { block: { txs: Tx[], time: number } } }> {
    const response = await fetch('http://127.0.0.1:9654/ext/bc/P', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            jsonrpc: '2.0',
            method: 'platform.getBlockByHeight',
            params: {
                height: blockHeight,
                encoding: 'json'
            },
            id: 1
        })
    });

    return response.json() as Promise<{ result: { block: { txs: Tx[], time: number } } }>;
}

type ValidatorsResponse = {
    result: Record<string, {
        publicKey: string | null,
        weight: string
    }>
}

async function getValidatorsAt(height: number | "proposed", subnetID?: string): Promise<ValidatorsResponse> {
    const params: { height: number | "proposed", subnetID?: string } = { height };
    if (subnetID) {
        params.subnetID = subnetID;
    }

    const response = await fetch('http://127.0.0.1:9654/ext/bc/P', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            jsonrpc: '2.0',
            method: 'platform.getValidatorsAt',
            params: params,
            id: 1
        })
    });

    return response.json() as Promise<ValidatorsResponse>;
}

const { result: { height: lastBlockStr } } = await getHeight();
const lastBlock = parseInt(lastBlockStr, 10);

console.log(`Processing blocks ${firstBlock} to ${lastBlock}`);


let validatedSubnets = new Set<string>()
for (let i = firstBlock; i <= lastBlock; i++) {
    const subnetIds = await extractSubnetIdsCreatedInABlock(i)
    for (let subnetId of subnetIds) {
        const validators = (await getValidatorsAt("proposed", subnetId)).result
        const ZERO_ID = "NodeID-111111111111111111116DBWJs"
        delete validators[ZERO_ID]
        if (Object.keys(validators).length > 0) {
            validatedSubnets.add(subnetId)
        }
    }
}

console.log(`Validated ${validatedSubnets.size} subnets`)

async function extractSubnetIdsCreatedInABlock(blockHeight: number): Promise<string[]> {
    const block = await getBlockByHeight(blockHeight);
    if (block.result.block.time && !block.result.block.txs) {
        return []//normal, just no txs
    }
    return block.result.block.txs.filter(looksLikeCreateSubnetTx).map(tx => tx.id)
}

function looksLikeCreateSubnetTx(tx: Tx): boolean {
    const fields = Object.keys(tx.unsignedTx);
    const allowedFields = ['networkID', 'blockchainID', 'outputs', 'inputs', "memo", "owner"];

    let extraFields = []
    for (const field of fields) {
        if (!allowedFields.includes(field)) {
            extraFields.push(field);
        }
    }

    if (extraFields.length > 0) {
        return false;
    }

    return true;
}
