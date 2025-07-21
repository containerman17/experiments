interface NodeData {
    [subnetId: string]: number; // timestamp
}

interface Database {
    [nodeId: string]: NodeData;
}

class NodeDatabase {
    private data: Database = {};
    private readonly nodeCount: number;

    constructor() {
        this.nodeCount = Number(process.env.NODE_COUNT) || 3;
        this.initialize();
    }

    private initialize(): void {
        // Initialize empty objects for NODE_COUNT nodes with 3-digit format (001-999)
        for (let i = 1; i <= this.nodeCount; i++) {
            const nodeId = `node${i.toString().padStart(3, '0')}`;
            this.data[nodeId] = {};
        }
        console.log(`Initialized ${this.nodeCount} nodes: ${Object.keys(this.data).join(', ')}`);
    }

    getNodeWithLowestSubnetCount(): string {
        let minCount = Infinity;
        let selectedNode = '';

        for (const [nodeId, nodeData] of Object.entries(this.data)) {
            const subnetCount = Object.keys(nodeData).length;
            if (subnetCount < minCount) {
                minCount = subnetCount;
                selectedNode = nodeId;
            }
        }

        return selectedNode;
    }

    getOldestSubnetAcrossAllNodes(): { nodeId: string; subnetId: string; timestamp: number } | null {
        let oldestTimestamp = Infinity;
        let oldestEntry: { nodeId: string; subnetId: string; timestamp: number } | null = null;

        for (const [nodeId, nodeData] of Object.entries(this.data)) {
            for (const [subnetId, timestamp] of Object.entries(nodeData)) {
                if (timestamp < oldestTimestamp) {
                    oldestTimestamp = timestamp;
                    oldestEntry = { nodeId, subnetId, timestamp };
                }
            }
        }

        return oldestEntry;
    }

    isSubnetRegistered(subnetId: string): { isRegistered: boolean; nodeId?: string } {
        for (const [nodeId, nodeData] of Object.entries(this.data)) {
            if (subnetId in nodeData) {
                return { isRegistered: true, nodeId };
            }
        }
        return { isRegistered: false };
    }

    addSubnetToNode(nodeId: string, subnetId: string): void {
        if (!(nodeId in this.data)) {
            throw new Error(`Node ${nodeId} does not exist`);
        }
        this.data[nodeId][subnetId] = Date.now();
    }

    removeSubnetFromNode(nodeId: string, subnetId: string): void {
        if (nodeId in this.data && subnetId in this.data[nodeId]) {
            delete this.data[nodeId][subnetId];
        }
    }

    getNodeSubnets(nodeId: string): string[] {
        return Object.keys(this.data[nodeId] || {});
    }

    getAllNodes(): string[] {
        return Object.keys(this.data);
    }

    getDatabase(): Database {
        return JSON.parse(JSON.stringify(this.data)); // deep copy
    }

    isNodeFull(nodeId: string): boolean {
        return Object.keys(this.data[nodeId] || {}).length >= 16;
    }

    areAllNodesFull(): boolean {
        return this.getAllNodes().every(nodeId => this.isNodeFull(nodeId));
    }
}

export const database = new NodeDatabase();
export type { Database, NodeData }; 
