import { createServer } from './server.js';

async function start() {
    try {
        const server = await createServer();

        // Generate OpenAPI documentation
        await server.ready();

        // Start the server
        await server.listen({ port: 3454, host: '0.0.0.0' });

        console.log('Server listening on port 3454');
        console.log('API documentation available at: http://localhost:3454/docs');
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
}

start(); 
