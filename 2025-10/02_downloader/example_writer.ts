import path from "path";
import { Fetcher } from "./downloader.ts";

const rpcUrl = "http://localhost:9650/ext/bc/C/rpc";
const dir = path.join(process.cwd(), "data", "C-Chain");

const fetcher = new Fetcher({
    folder: dir,
    rpcUrl,
    includeTraces: true,
    sizeCutoffMB: 128,
});

fetcher.start().catch(console.error);