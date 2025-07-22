import fastify from 'fastify';
import dotenv from 'dotenv';
import { database } from './database.js';
import { checkSubnetExists, getSubnetIdFromChainId, getNodeInfo } from './avalanche.js';
import { generateDockerCompose, restartContainersAsync } from './docker-composer.js';
import { checkRateLimit, extractClientIP } from './rate-limiter.js';

dotenv.config();

const server = fastify({ logger: true });

// TODO: fix - move bootstrap error message to const as required
const BOOTSTRAP_ERROR_MESSAGE = 'Node is not ready or still bootstrapping';

// Initialize Docker containers on startup
console.log('Starting Docker containers...');
generateDockerCompose(); // Generate compose file and start containers on initial startup

// Rate limiting middleware
server.addHook('preHandler', (req, reply, done) => {
    const clientIP = extractClientIP(req.headers);
    const { allowed, retryAfter } = checkRateLimit(clientIP);

    if (!allowed) {
        console.log(`Rate limit exceeded for IP: ${clientIP}`);
        reply.code(429)
            .header('Retry-After', retryAfter?.toString() || '1')
            .send({
                error: 'Rate limit exceeded',
                retryAfter: retryAfter
            });
        return;
    }

    done();
});

// Authentication middleware for admin endpoints
server.addHook('preHandler', (req, reply, done) => {
    if (req.url.startsWith('/node_admin/')) {
        const { password } = req.query as { password?: string };
        if (!password || password !== process.env.ADMIN_PASSWORD) {
            console.log(`Unauthorized admin access from ${extractClientIP(req.headers)}`);
            reply.code(401).send({ error: 'Unauthorized' });
            return;
        }
    }
    done();
});

server.get('/node_admin/registerSubnet/:subnetId', async (req, reply) => {
    const { subnetId } = req.params as { subnetId: string };

    try {
        // Validate subnet exists on Avalanche network
        const subnetExists = await checkSubnetExists(subnetId);
        if (!subnetExists) {
            return reply.code(400).send({
                success: false,
                error: `Subnet ${subnetId} does not exist on Avalanche network`
            });
        }

        // Assign subnet to appropriate node (database handles all the logic)
        const { nodeId, replacedSubnet, isNewAssignment } = database.assignSubnetToNode(subnetId);

        // Get node port and cached info
        const nodes = database.getAllNodes();
        const nodeIndex = nodes.indexOf(nodeId);
        const nodePort = 9650 + (nodeIndex * 2);

        // Get node info
        const nodeInfo = (await getNodeInfo(nodePort)).result;
        if (isNewAssignment) {
            generateDockerCompose();
        }

        return nodeInfo
    } catch (error) {
        console.error('Error registering subnet:', error);
        return reply.code(500).send({
            success: false,
            error: error instanceof Error ? error.message : 'Failed to register subnet'
        });
    }
});

// Debug endpoint to view database state
server.get('/node_admin/status', async () => {
    return {
        nodes: database.getDatabase(),
        nodeCount: database.getAllNodes().length
    };
});

// Proxy endpoint - forwards RPC requests to appropriate node
server.post('/ext/bc/:chainId/rpc', async (req, reply) => {
    const { chainId } = req.params as { chainId: string };

    try {
        // Get subnetId from chainId using cached lookup
        const subnetId = await getSubnetIdFromChainId(chainId);
        if (!subnetId) {
            return reply.code(404).send({
                error: `Chain ${chainId} not found or invalid`
            });
        }

        // Find which node hosts this subnet
        const { isRegistered, nodeId } = database.isSubnetRegistered(subnetId);
        if (!isRegistered || !nodeId) {
            return reply.code(404).send({
                error: `Subnet ${subnetId} for chain ${chainId} is not hosted by any node`
            });
        }

        // Calculate node port (9650 + index * 2)
        const nodes = database.getAllNodes();
        const nodeIndex = nodes.indexOf(nodeId);
        const nodePort = 9650 + (nodeIndex * 2);

        // Forward request to node
        const targetUrl = `http://localhost:${nodePort}/ext/bc/${chainId}/rpc`;

        const response = await fetch(targetUrl, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...Object.fromEntries(
                    Object.entries(req.headers).filter(([key]) =>
                        key.startsWith('x-') || key === 'user-agent'
                    )
                )
            },
            body: JSON.stringify(req.body)
        });

        // Forward response as-is
        const data = await response.text();
        reply.code(response.status)
            .header('Content-Type', response.headers.get('Content-Type') || 'application/json')
            .send(data);

    } catch (error) {
        console.error('Error proxying request:', error);

        if (error instanceof Error && error.message.includes('ECONNREFUSED')) {
            return reply.code(503).send({
                error: BOOTSTRAP_ERROR_MESSAGE,
                chainId,
                retry: true
            });
        }

        return reply.code(500).send({
            error: 'Internal proxy error',
            chainId
        });
    }
});

server.listen({ port: 3000, host: '0.0.0.0' }, (err) => {
    if (err) {
        console.error(err);
        process.exit(1);
    }
    console.log('Server listening on port 3000');
}); 
