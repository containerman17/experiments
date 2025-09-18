async function pollBlockNumber(name: string, url: string) {
    while (true) {
        try {
            const res = await fetch(url, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    jsonrpc: "2.0",
                    id: 1,
                    method: "eth_blockNumber",
                    params: [],
                }),
            });

            const json = await res.json();
            const hex = json.result as string;
            const block = parseInt(hex, 16);

            console.log(`${name} | ${block}`);
        } catch (err) {
            console.error(`${name} error:`, err);
        }

        await new Promise((r) => setTimeout(r, 50));
    }
}

async function main() {
    // replace with your real URLs
    const url1 = "http://127.0.0.1:9650/ext/bc/C/rpc";
    const url2 = "https://avalanche-c-chain-rpc.publicnode.com/d65da4791d939238880c8d59498111ac256e524e0ff94f9981e92c8014548f03";

    pollBlockNumber("local", url1);
    pollBlockNumber("publicnode", url2);
}

main();
