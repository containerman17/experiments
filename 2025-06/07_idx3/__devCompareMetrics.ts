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

async function compareResponses(queryString: string, pages: number = 1) {
    let glacierUrl = `https://metrics.avax.network/v2/chains/${evmChainId}/metrics/txCount${queryString}`;
    let localUrl = `http://localhost:3000/metrics/txCount${queryString}`;

    try {
        let allGlacierResults: any[] = [];
        let allLocalResults: any[] = [];
        let glacierPageToken: string | undefined;
        let localPageToken: string | undefined;

        for (let page = 1; page <= pages; page++) {
            console.log(`\n--- PAGE ${page} ---`);

            // Build URLs with pageToken if available
            const glacierPageUrl = glacierPageToken
                ? `${glacierUrl}&pageToken=${glacierPageToken}`
                : glacierUrl;
            const localPageUrl = localPageToken
                ? `${localUrl}&pageToken=${localPageToken}`
                : localUrl;

            console.log('Fetching from Glacier API...');
            const glacierResponse = await fetch(glacierPageUrl);
            const glacierData = await glacierResponse.json() as MetricsResponse;

            console.log('Fetching from local API...');
            const localResponse = await fetch(localPageUrl);
            const localData = await localResponse.json() as MetricsResponse;

            // Collect results
            allGlacierResults.push(...glacierData.results);
            allLocalResults.push(...localData.results);

            // Update page tokens for next iteration
            glacierPageToken = glacierData.nextPageToken;
            localPageToken = localData.nextPageToken;

            console.log(`Glacier page ${page}: ${glacierData.results.length} results, nextToken: ${glacierPageToken}`);
            console.log(`Local page ${page}: ${localData.results.length} results, nextToken: ${localPageToken}`);

            // Break if no more pages
            if (!glacierPageToken && !localPageToken) break;
        }

        console.log('\n=== OVERALL COMPARISON ===');
        console.log(`Query: ${queryString}, Pages: ${pages}`);
        console.log(`Glacier total results: ${allGlacierResults.length}`);
        console.log(`Local total results: ${allLocalResults.length}`);

        // Deep comparison of all results
        const resultsMatch = JSON.stringify(allGlacierResults) === JSON.stringify(allLocalResults);
        console.log(`Results match: ${resultsMatch}`);

        if (!resultsMatch) {
            console.log('\n--- DIFFERENCES ---');
            const maxLength = Math.max(allGlacierResults.length, allLocalResults.length);

            for (let i = 0; i < maxLength; i++) {
                const glacier = allGlacierResults[i];
                const local = allLocalResults[i];

                if (!glacier && local) {
                    console.log(`Index ${i}: Glacier=missing, Local=${local.timestamp}(${local.value})`);
                } else if (glacier && !local) {
                    console.log(`Index ${i}: Glacier=${glacier.timestamp}(${glacier.value}), Local=missing`);
                } else if (glacier && local && (glacier.timestamp !== local.timestamp || glacier.value !== local.value)) {
                    console.log(`Index ${i}: Glacier=${glacier.timestamp}(${glacier.value}), Local=${local.timestamp}(${local.value})`);
                }
            }
        }

    } catch (error) {
        console.error('Error comparing responses:', error);
    }
}

await compareResponses('?pageSize=5', 3);
await compareResponses('?pageSize=10&startTimestamp=1');
await compareResponses('?pageSize=10&endTimestamp=1751248800');
await compareResponses('?pageSize=10&timeInterval=month')
await compareResponses('?pageSize=10&timeInterval=week')
await compareResponses('?pageSize=10&timeInterval=day')
await compareResponses('?pageSize=10&timeInterval=hour')



export { }
