import Image from "next/image";

// Updated Data Interfaces
interface Block {
  blockNumber: string; // Changed from id
  hash: string;
  timestamp: number; // Keep for age calculation
  age: string;       // Calculated
  transactionsCount: number; // Changed from txnCount
  fee: number;
  feeCurrency: string; // e.g., AVAX
}

interface Transaction {
  txHash: string; // Changed from id
  timestamp: number; // Keep for age calculation
  age: string;       // Calculated
  fromAddress: string; // Changed from from
  toAddress: string;   // Changed from to
  valueTotal: number;
  valueCurrency: string; // e.g., AVAX
}

const randomHex = (lengthBytes: number) => {
  return "0x" + Array.from({ length: lengthBytes }, () => Math.floor(Math.random() * 16).toString(16)).join('');
}

// Updated Mock Data
const mockBlocksData: Omit<Block, 'age'>[] = [
  { blockNumber: "61837788", hash: randomHex(20), timestamp: Date.now() - 9 * 1000, transactionsCount: 81, fee: 0.0367, feeCurrency: "AVAX" },
  { blockNumber: "61837787", hash: randomHex(20), timestamp: Date.now() - 14 * 1000, transactionsCount: 19, fee: 0.0047, feeCurrency: "AVAX" },
  { blockNumber: "61837786", hash: randomHex(20), timestamp: Date.now() - 15 * 1000, transactionsCount: 15, fee: 0.0085, feeCurrency: "AVAX" },
  { blockNumber: "61837785", hash: randomHex(20), timestamp: Date.now() - 17 * 1000, transactionsCount: 8, fee: 0.0042, feeCurrency: "AVAX" },
  { blockNumber: "61837784", hash: randomHex(20), timestamp: Date.now() - 18 * 1000, transactionsCount: 13, fee: 0.0042, feeCurrency: "AVAX" },
  { blockNumber: "61837783", hash: randomHex(20), timestamp: Date.now() - 19 * 1000, transactionsCount: 22, fee: 0.0146, feeCurrency: "AVAX" },
];

const mockTransactionsData: Omit<Transaction, 'age'>[] = [
  { txHash: randomHex(32), fromAddress: randomHex(20), toAddress: randomHex(20), timestamp: Date.now() - 9 * 1000, valueTotal: 0, valueCurrency: "AVAX" },
  { txHash: randomHex(32), fromAddress: randomHex(20), toAddress: randomHex(20), timestamp: Date.now() - 9 * 1000, valueTotal: 0, valueCurrency: "AVAX" },
  { txHash: randomHex(32), fromAddress: randomHex(20), toAddress: randomHex(20), timestamp: Date.now() - 9 * 1000, valueTotal: 0, valueCurrency: "AVAX" },
  { txHash: randomHex(32), fromAddress: randomHex(20), toAddress: randomHex(20), timestamp: Date.now() - 9 * 1000, valueTotal: 0.1, valueCurrency: "AVAX" },
  { txHash: randomHex(32), fromAddress: randomHex(20), toAddress: randomHex(20), timestamp: Date.now() - 9 * 1000, valueTotal: 0, valueCurrency: "AVAX" },
  { txHash: randomHex(32), fromAddress: randomHex(20), toAddress: randomHex(20), timestamp: Date.now() - 9 * 1000, valueTotal: 0.000398, valueCurrency: "AVAX" },
];

// Helper Functions
function formatTimeAgo(timestamp: number): string {
  const now = Date.now();
  const seconds = Math.round((now - timestamp) / 1000);

  if (seconds < 60) return `${seconds}s ago`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function truncateAddr(address: string, startChars = 6, endChars = 4): string {
  if (!address) return "";
  if (address.startsWith("0x") && address.length > 10) {
    return `${address.substring(0, startChars)}...${address.substring(address.length - endChars)}`;
  }
  return address;
}

async function getLatestBlocks(): Promise<Block[]> {
  await new Promise(resolve => setTimeout(resolve, 10));
  return mockBlocksData.map(block => ({
    ...block,
    age: formatTimeAgo(block.timestamp),
  }));
}

async function getLatestTransactions(): Promise<Transaction[]> {
  await new Promise(resolve => setTimeout(resolve, 10));
  return mockTransactionsData.map(tx => ({
    ...tx,
    age: formatTimeAgo(tx.timestamp),
  }));
}

// Main Page Component
export default async function Home() {
  const latestBlocks = await getLatestBlocks();
  const latestTransactions = await getLatestTransactions();

  return (
    <div className="min-h-screen bg-white p-6 max-w-7xl mx-auto font-sans">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        <BlocksTable blocks={latestBlocks} />
        <TransactionsTable transactions={latestTransactions} />
      </div>
    </div>
  );
}

// Table Components
function BlocksTable({ blocks }: { blocks: Block[] }) {
  return (
    <div className="w-full">
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-xl font-semibold text-gray-900">Latest Blocks</h2>
        <a href="/blocks" className="text-blue-600 hover:text-blue-800 text-sm flex items-center">
          View All Blocks <span className="ml-1">→</span>
        </a>
      </div>

      <div className="overflow-hidden border border-gray-200 rounded-lg">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Block
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Hash
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Age
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Transactions
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Fee
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {blocks.map((block) => (
                <tr key={block.blockNumber} className="hover:bg-gray-50">
                  <td className="px-6 py-4 whitespace-nowrap">
                    <a href={`/block/${block.blockNumber}`} className="text-blue-600 hover:underline font-medium">
                      {block.blockNumber}
                    </a>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <a href={`/block/${block.hash}`} className="text-blue-600 hover:underline">
                      {truncateAddr(block.hash)}
                    </a>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-gray-600">
                    {block.age}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <a href={`/block/${block.blockNumber}/txs`} className="text-blue-600 hover:underline">
                      {block.transactionsCount}
                    </a>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-gray-600">
                    {block.fee.toFixed(4)} {block.feeCurrency}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function TransactionsTable({ transactions }: { transactions: Transaction[] }) {
  return (
    <div className="w-full">
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-xl font-semibold text-gray-900">Latest Successful Transactions</h2>
        <a href="/transactions" className="text-blue-600 hover:text-blue-800 text-sm flex items-center">
          View All Transactions <span className="ml-1">→</span>
        </a>
      </div>

      <div className="overflow-hidden border border-gray-200 rounded-lg">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Tx Hash
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  From
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  To
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Age
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  Value Total
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {transactions.map((tx) => (
                <tr key={tx.txHash} className="hover:bg-gray-50">
                  <td className="px-6 py-4 whitespace-nowrap">
                    <a href={`/tx/${tx.txHash}`} className="text-blue-600 hover:underline">
                      {truncateAddr(tx.txHash)}
                    </a>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <a href={`/address/${tx.fromAddress}`} className="text-blue-600 hover:underline">
                      {truncateAddr(tx.fromAddress)}
                    </a>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap">
                    <a href={`/address/${tx.toAddress}`} className="text-blue-600 hover:underline">
                      {truncateAddr(tx.toAddress)}
                    </a>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-gray-600">
                    {tx.age}
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-gray-600">
                    {tx.valueTotal === 0 ? "0.0" : tx.valueTotal.toString()} {tx.valueCurrency}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// Ensure Geist Sans variables are available or fallback
// The current font application is on the outer div in the Home component.
