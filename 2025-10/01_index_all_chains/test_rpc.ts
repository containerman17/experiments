import { fetchBlockData } from "./rpc.ts";

console.log(await fetchBlockData('http://localhost:9650/ext/bc/C/rpc', 1000000, true));