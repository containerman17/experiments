import fs from 'fs';

// Read input files
const stakeData = JSON.parse(fs.readFileSync('nodeIdToStake.json', 'utf8'));
const ipData = JSON.parse(fs.readFileSync('nodeIdToIP.json', 'utf8'));

// Load existing results if they exist
let existingResults = {};
const resultsFile = 'nodeIdToLocation.json';
if (fs.existsSync(resultsFile)) {
    existingResults = JSON.parse(fs.readFileSync(resultsFile, 'utf8'));
}

// Find nodeIds that exist in both files
const nodeIds = Object.keys(stakeData).filter(nodeId => ipData[nodeId]);

console.log(`Found ${nodeIds.length} nodes with both stake and IP data`);
console.log(`Already have location data for ${Object.keys(existingResults).length} nodes`);

// Filter out nodes we already have location data for
const nodesToProcess = nodeIds.filter(nodeId => !existingResults[nodeId]);

console.log(`Need to fetch location data for ${nodesToProcess.length} nodes`);

// Process in batches of 10
const batchSize = 10;
for (let i = 0; i < nodesToProcess.length; i += batchSize) {
    const batch = nodesToProcess.slice(i, i + batchSize);
    console.log(`Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(nodesToProcess.length / batchSize)}`);

    for (const nodeId of batch) {
        const ipWithPort = ipData[nodeId];
        const ip = ipWithPort.split(':')[0]; // Remove port

        console.log(`Fetching location for ${nodeId}: ${ip}`);

        const response = await fetch(`http://ip-api.com/json/${ip}`);
        const locationData = await response.json();

        existingResults[nodeId] = {
            stake: stakeData[nodeId],
            ip: ipWithPort,
            location: {
                country: locationData.country,
                countryCode: locationData.countryCode,
                region: locationData.regionName,
                city: locationData.city,
                lat: locationData.lat,
                lon: locationData.lon,
                isp: locationData.isp,
                org: locationData.org
            }
        };

        // Save after each IP to avoid losing progress
        fs.writeFileSync(resultsFile, JSON.stringify(existingResults, null, 2));

        // Rate limit - wait 100ms between requests to be nice to the API
        await new Promise(resolve => setTimeout(resolve, 100));
    }

    console.log(`Completed batch ${Math.floor(i / batchSize) + 1}, saved ${Object.keys(existingResults).length} total results`);
}

console.log('All done! Final results saved to nodeIdToLocation.json');
console.log(`Total nodes with complete data: ${Object.keys(existingResults).length}`);
