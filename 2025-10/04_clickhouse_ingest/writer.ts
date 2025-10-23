import path from "path";
import { Fetcher } from "./lib/fetcher.ts";
import { LocalBlockWriter } from "./lib/LocalBlockWriter.ts";

const rpcUrl = "https://node00.solokhin.com/ext/bc/2tig763SuFas5WGk6vsjj8uWzTwq8DKvAN8YgeouwFZe28XjNm/rpc";
const dir = path.join(process.cwd(), "data", "2tig763SuFas5WGk6vsjj8uWzTwq8DKvAN8YgeouwFZe28XjNm");

const writer = new LocalBlockWriter(dir, 128);

const fetcher = new Fetcher({
    writer,
    rpcUrl,
    includeTraces: true,
});

fetcher.start().catch(console.error);