import path from "path";
import { Fetcher } from "./fetcher.ts";

const rpcUrl = "http://localhost:9650/ext/bc/C/rpc";
const dir = path.join(process.cwd(), "data", "2q9e4r6Mu3U68nU1fYjgbR6JvwrRx36CohpAX5UQxse55x1Q5");

const fetcher = new Fetcher({
    folder: dir,
    rpcUrl,
    includeTraces: true,
    sizeCutoffMB: 128,
});

fetcher.start().catch(console.error);