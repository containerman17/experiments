import { fetchBlockAndReceipts, getCurrentBlockNumber } from "./rpc";

console.log(await fetchBlockAndReceipts(await getCurrentBlockNumber()));
console.log();
