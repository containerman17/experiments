import fastify from 'fastify';
import { database } from './database.js';
import { checkSubnetExists, getSubnetIdFromChainId, getNodeInfo, NodeInfoResult, NodeInfoResponse } from './node_apis.js';
import { generateDockerCompose } from './docker-composer.js';
import { checkRateLimit, extractClientIP } from './rate-limiter.js';
import { ADMIN_PASSWORD } from './config.js';

const server = fastify({ logger: true });

// TODO: fix - move bootstrap error message to const as required
const BOOTSTRAP_ERROR_MESSAGE = 'Node is not ready or still bootstrapping';

// Initialize Docker containers on startup
async function initializeContainers() {
    console.log('Starting Docker containers...');
    await generateDockerCompose(); // Generate compose file and start containers on initial startup
}

// Start initialization
setInterval(() => initializeContainers().catch(e => {
    console.error('Error initializing containers:', e);
}), 5 * 1000);

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
        if (!password || password !== ADMIN_PASSWORD) {
            console.log(`Unauthorized admin access from ${extractClientIP(req.headers)}`);
            reply.code(401).send({ error: 'Unauthorized' });
            return;
        }
    }
    done();
});

server.get('/node_admin/subnets/status/:subnetId', async (req, reply) => {
    const { subnetId } = req.params as { subnetId: string };
    const subnet = database.getSubnet(subnetId);
    if (!subnet) {
        return reply.code(404).send({
            error: `Subnet ${subnetId} not found in database`
        });
    }

    const nodes: NodeInfoResponse[] = [];

    for (const nodeId of subnet.nodeIds.sort()) {
        const nodeInfo = await getNodeInfo(9652 + nodeId * 2);
        if (!nodeInfo.result) {
            return reply.code(404).send({
                error: `Nodeinfo call failed for node ${nodeId} with error: ${JSON.stringify(nodeInfo.error || "Unknown error")}`
            });
        }
        nodes.push(nodeInfo);
    }

    return reply.send({
        nodes: nodes,
        expiresAt: subnet.expiresAt,
        subnetId: subnetId,
        nodeCount: subnet.nodeIds.length,
    });
});

server.get('/node_admin/subnets/scale/:subnetId/:count', async (req, reply) => {
    const { subnetId, count: stringCount } = req.params as { subnetId: string, count: string };
    const count = stringCount ? parseInt(stringCount) : 1;

    if (isNaN(count) || count < 0 || count > 5) {
        return reply.code(400).send({
            success: false,
            error: 'Invalid count parameter, must be a number between 0 and 5'
        });
    }

    // Validate subnet exists on Avalanche network
    const subnetExists = await checkSubnetExists(subnetId);
    if (!subnetExists) {
        return reply.code(400).send({
            success: false,
            error: `Subnet ${subnetId} does not exist on Avalanche network`
        });
    }

    // Assign subnet to appropriate node (database handles all the logic)
    database.addOrAdjustSubnet(subnetId, count);
    await generateDockerCompose();

    return reply.send({
        success: true,
        message: `Subnet ${subnetId} assigned to nodes, count: ${count}`,
    });
});


// OPTIONS handler for CORS preflight
server.options('/ext/bc/:chainId/rpc', async (req, reply) => {
    reply.header('Access-Control-Allow-Origin', '*');
    reply.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    reply.header('Access-Control-Allow-Headers', '*');
    reply.code(200).send();
});

server.get('/ext/bc/:chainId/rpc', async (req, reply) => {
    const { chainId } = req.params as { chainId: string };

    // Add CORS headers
    reply.header('Access-Control-Allow-Origin', '*');
    reply.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    reply.header('Access-Control-Allow-Headers', '*');

    try {
        // Get subnetId from chainId using cached lookup
        const subnetId = await getSubnetIdFromChainId(chainId);
        if (!subnetId) {
            return reply.code(404).send({
                error: `Chain ${chainId} not found or invalid`
            });
        }

        const subnet = database.getSubnet(subnetId);
        if (!subnet) {
            return reply.code(404).send({
                error: `Subnet ${subnetId} not found in database`
            });
        }

        const nodeId = subnet.nodeIds[0]; // Get the first node hosting this subnet
        if (typeof nodeId !== 'number') {
            return reply.code(500).send({
                error: `No nodes found for subnet ${subnetId}. This is an implementation error, please report it.`
            });
        }

        const nodePort = 9652 + (nodeId * 2);

        let status = 'not healthy - node is not ready or still bootstrapping';
        let evmChainIdText = '';

        // Test if node is alive and get chain ID
        try {
            const targetUrl = `http://localhost:${nodePort}/ext/bc/${chainId}/rpc`;
            const chainIdResponse = await fetch(targetUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    method: 'eth_chainId',
                    params: [],
                    id: 1
                })
            });

            if (chainIdResponse.ok) {
                const chainIdData = await chainIdResponse.json();
                if (chainIdData.result) {
                    const evmChainId = parseInt(chainIdData.result, 16);
                    status = 'healthy';
                    evmChainIdText = `, EVM Chain ID: ${evmChainId}`;
                }
            }
        } catch (error) {
            // status already set to not healthy
        }

        if (status === 'healthy') {
            return reply.code(200).send(`Blockchain ID: ${chainId}, Subnet ID: ${subnetId}, Status: ${status}${evmChainIdText}. To do actual RPC requests you need to issue a POST request.`);
        } else {
            return reply.code(503).send(`Blockchain ID: ${chainId}, Subnet ID: ${subnetId}, Status: ${status}`);
        }

    } catch (error) {
        console.error('Error testing node health:', error);
        return reply.code(500).send({
            error: 'Internal proxy error',
            chainId
        });
    }
});

// Proxy endpoint - forwards RPC requests to appropriate node
server.post('/ext/bc/:chainId/rpc', async (req, reply) => {
    const { chainId } = req.params as { chainId: string };

    // Add CORS headers
    reply.header('Access-Control-Allow-Origin', '*');
    reply.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    reply.header('Access-Control-Allow-Headers', '*');

    try {
        const subnetId = await getSubnetIdFromChainId(chainId);
        if (!subnetId) {
            return reply.code(404).send({
                error: `Chain ${chainId} not found or invalid`
            });
        }

        const subnet = database.getSubnet(subnetId);
        if (!subnet) {
            return reply.code(404).send({
                error: `Subnet ${subnetId} not found in database`
            });
        }

        const nodeId = subnet.nodeIds[0]; // Get the first node hosting this subnet
        if (typeof nodeId !== 'number') {
            return reply.code(500).send({
                error: `No nodes found for subnet ${subnetId}. This is an implementation error, please report it.`
            });
        }

        const nodePort = 9652 + (nodeId * 2);

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
