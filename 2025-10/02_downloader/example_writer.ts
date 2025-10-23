import path from "path";
import { Fetcher } from "./fetcher.ts";

const rpcUrl = "https://node00.solokhin.com/ext/bc/TT2vQnjSF9VZfjaA5dB1VNKVdqkVCDzSncxaMcGVwYedGaMG3/rpc";
const dir = path.join(process.cwd(), "data", "TT2vQnjSF9VZfjaA5dB1VNKVdqkVCDzSncxaMcGVwYedGaMG3");

const fetcher = new Fetcher({
    folder: dir,
    rpcUrl,
    includeTraces: true,
    sizeCutoffMB: 128,
});

fetcher.start().catch(console.error);