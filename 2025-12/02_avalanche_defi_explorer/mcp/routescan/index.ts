import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import * as fs from "fs";
import * as path from "path";

const BASE_URL = "https://api.routescan.io/v2/network/mainnet/evm/43114/etherscan/api";
const API_KEY = "YourApiKeyToken";
const CACHE_DIR = "/tmp/routescan";

async function fetchAbi(address: string): Promise<string> {
    const cacheDir = path.join(CACHE_DIR, address);
    const abiPath = path.join(cacheDir, "abi.json");

    if (fs.existsSync(abiPath)) {
        return abiPath;
    }

    const url = `${BASE_URL}?module=contract&action=getabi&address=${address}&apikey=${API_KEY}`;
    const response = await fetch(url);
    const data = await response.json() as { status: string; message: string; result: string };

    if (data.status !== "1") {
        throw new Error(`API error: ${data.message}`);
    }

    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(abiPath, data.result);

    return abiPath;
}

async function fetchSourceCode(address: string): Promise<string[]> {
    const cacheDir = path.join(CACHE_DIR, address);
    const markerPath = path.join(cacheDir, ".source_fetched");

    if (fs.existsSync(markerPath)) {
        return listSourceFiles(cacheDir);
    }

    const url = `${BASE_URL}?module=contract&action=getsourcecode&address=${address}&apikey=${API_KEY}`;
    const response = await fetch(url);
    const data = await response.json() as {
        status: string;
        message: string;
        result: Array<{
            SourceCode: string;
            ABI: string;
            ContractName: string;
            CompilerVersion: string;
            OptimizationUsed: string;
            Runs: string;
            ConstructorArguments: string;
            Proxy: string;
            Implementation: string;
        }>;
    };

    if (data.status !== "1") {
        throw new Error(`API error: ${data.message}`);
    }

    fs.mkdirSync(cacheDir, { recursive: true });

    const result = data.result[0];
    const files: string[] = [];

    // Save ABI
    const abiPath = path.join(cacheDir, "abi.json");
    fs.writeFileSync(abiPath, result.ABI);
    files.push(abiPath);

    // Save metadata
    const metaPath = path.join(cacheDir, "metadata.json");
    fs.writeFileSync(metaPath, JSON.stringify({
        ContractName: result.ContractName,
        CompilerVersion: result.CompilerVersion,
        OptimizationUsed: result.OptimizationUsed,
        Runs: result.Runs,
        ConstructorArguments: result.ConstructorArguments,
        Proxy: result.Proxy,
        Implementation: result.Implementation,
    }, null, 2));
    files.push(metaPath);

    // Parse source code
    let sourceCode = result.SourceCode;

    // Handle double-braced JSON format (Solidity standard JSON input)
    if (sourceCode.startsWith("{{")) {
        sourceCode = sourceCode.slice(1, -1);
    }

    try {
        const parsed = JSON.parse(sourceCode);

        if (parsed.sources) {
            // Standard JSON input format
            for (const [filePath, content] of Object.entries(parsed.sources as Record<string, { content: string }>)) {
                const fullPath = path.join(cacheDir, "sources", filePath);
                fs.mkdirSync(path.dirname(fullPath), { recursive: true });
                fs.writeFileSync(fullPath, content.content);
                files.push(fullPath);
            }
        }
    } catch {
        // Plain solidity source, save as single file
        const solPath = path.join(cacheDir, "sources", `${result.ContractName}.sol`);
        fs.mkdirSync(path.dirname(solPath), { recursive: true });
        fs.writeFileSync(solPath, sourceCode);
        files.push(solPath);
    }

    // Mark as fetched
    fs.writeFileSync(markerPath, new Date().toISOString());

    return files;
}

function listSourceFiles(dir: string): string[] {
    const files: string[] = [];

    function walk(currentDir: string) {
        for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
            const fullPath = path.join(currentDir, entry.name);
            if (entry.isDirectory()) {
                walk(fullPath);
            } else if (!entry.name.startsWith(".")) {
                files.push(fullPath);
            }
        }
    }

    walk(dir);
    return files;
}

const server = new Server(
    { name: "routescan", version: "1.0.0" },
    { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
        {
            name: "get_abi",
            description: "Fetch contract ABI from Routescan and cache it locally. Returns path to cached ABI JSON file.",
            inputSchema: {
                type: "object" as const,
                properties: {
                    address: {
                        type: "string",
                        description: "Contract address (0x...)",
                    },
                },
                required: ["address"],
            },
        },
        {
            name: "get_source_code",
            description: "Fetch contract source code from Routescan and save all source files locally. Returns list of all saved file paths.",
            inputSchema: {
                type: "object" as const,
                properties: {
                    address: {
                        type: "string",
                        description: "Contract address (0x...)",
                    },
                },
                required: ["address"],
            },
        },
    ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    if (name === "get_abi") {
        const address = (args as { address: string }).address;
        const filePath = await fetchAbi(address);
        return {
            content: [{ type: "text", text: filePath }],
        };
    }

    if (name === "get_source_code") {
        const address = (args as { address: string }).address;
        const files = await fetchSourceCode(address);
        return {
            content: [{ type: "text", text: files.join("\n") }],
        };
    }

    throw new Error(`Unknown tool: ${name}`);
});

async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
}

main();

