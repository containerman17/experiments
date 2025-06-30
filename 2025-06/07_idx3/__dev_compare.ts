const evmChainId = 13322//await getEvmChainId('http://localhost:3000/rpc');
console.log(evmChainId);

type MetricsResponse = {
    results: {
        value: number;
        timestamp: number;
    }[];
    nextPageToken: string;
}

// async function getEvmChainId(url: string) {
//     const response = await fetch(url, {
//         method: 'POST',
//         headers: {
//             'Content-Type': 'application/json',
//         },
//         body: JSON.stringify({
//             jsonrpc: '2.0',
//             method: 'eth_chainId',
//             params: [],
//             id: 1,
//         }),
//     });

//     if (!response.ok) {
//         throw new Error(`HTTP error! status: ${response.status}`);
//     }

//     const data = await response.json() as { result: string, error?: { message: string } };

//     if (data.error) {
//         throw new Error(`RPC error: ${data.error.message}`);
//     }

//     // Convert hex string to number
//     return parseInt(data.result, 16);
// }

async function compareResponses(queryString: string) {
    const glacierUrl = `https://metrics.avax.network/v2/chains/${evmChainId}/metrics/txCount${queryString}`;
    const localUrl = `http://localhost:3000/metrics/txCount${queryString}`;

    try {
        console.log('Fetching from Glacier API...');
        const glacierResponse = await fetch(glacierUrl);
        const glacierData = await glacierResponse.json() as MetricsResponse;

        console.log('Fetching from local API...');
        const localResponse = await fetch(localUrl);
        const localData = await localResponse.json() as MetricsResponse;

        // Compare results arrays
        const glacierResults = glacierData.results;
        const localResults = localData.results;

        console.log('\n=== COMPARISON ===');
        console.log(`Query: ${queryString}`);
        console.log(`Glacier results count: ${glacierResults.length}`);
        console.log(`Local results count: ${localResults.length}`);

        // Deep comparison of results arrays
        const resultsMatch = JSON.stringify(glacierResults) === JSON.stringify(localResults);
        console.log(`Results match: ${resultsMatch}`);

        if (!resultsMatch) {
            console.log('\n--- DIFFERENCES ---');
            console.log(`Glacier timestamps: ${glacierResults.map(r => r.timestamp).join(', ')}`);
            console.log(`Local timestamps: ${localResults.map(r => r.timestamp).join(', ')}`);
            console.log(`Glacier values: ${glacierResults.map(r => r.value).join(', ')}`);
            console.log(`Local values: ${localResults.map(r => r.value).join(', ')}`);
        }

        // Show nextPageToken values (but don't compare them)
        console.log(`\nGlacier nextPageToken: ${glacierData.nextPageToken}`);
        console.log(`Local nextPageToken: ${localData.nextPageToken}`);

    } catch (error) {
        console.error('Error comparing responses:', error);
    }
}

compareResponses('?pageSize=10&startTimestamp=1');
compareResponses('?pageSize=10&endTimestamp=1751248800');

export { }
