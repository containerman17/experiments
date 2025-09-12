import fs from 'fs';

interface Geolocation {
    city: string;
    country: string;
    countryCode: string;
    latitude: number;
    longitude: number;
}

interface ValidatorStake {
    nodeId: string;
    geolocation: Geolocation;
    amountStaked: string;
}

interface ApiResponse {
    validators: ValidatorStake[];
    nextPageToken?: string;
}

async function fetchAllValidators(): Promise<Map<string, string>> {
    const baseUrl = 'https://glacier-api.avax.network/v1/networks/mainnet/validators';
    const params = new URLSearchParams({
        pageSize: '100',
        validationStatus: 'active',
        subnetId: '11111111111111111111111111111111LpoYY'
    });

    const validatorMap = new Map<string, string>();
    let pageToken: string | undefined = undefined;
    let pageCount = 0;

    try {
        do {
            const url = new URL(baseUrl);
            url.search = params.toString();
            if (pageToken) {
                url.searchParams.set('pageToken', pageToken);
            }

            console.log(`Fetching page ${pageCount + 1}...`);

            const response = await fetch(url.toString());
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const data: ApiResponse = await response.json();
            console.log(`Page ${pageCount + 1}: Found ${data.validators.length} validators`);

            // Process validators
            data.validators.forEach(validator => {
                validatorMap.set(validator.nodeId, validator.amountStaked);
            });

            pageToken = data.nextPageToken;
            pageCount++;

            // Small delay to be respectful to the API
            if (pageToken) {
                await new Promise(resolve => setTimeout(resolve, 100));
            }

        } while (pageToken);

        console.log(`Completed fetching ${pageCount} pages`);
        return validatorMap;

    } catch (error) {
        console.error('Error fetching validator data:', error);
        throw error;
    }
}

console.log('Starting to fetch validator stake data...');
const validatorMap = await fetchAllValidators();

console.log(`\nFetched data for ${validatorMap.size} validators:`);

// Show first few entries as example
let count = 0;
for (const [nodeId, stake] of validatorMap) {
    console.log(`${nodeId}: ${stake} AVAX`);
    if (++count >= 5) break; // Show only first 5
}

if (validatorMap.size > 5) {
    console.log(`... and ${validatorMap.size - 5} more validators`);
}

// Save to JSON file
const jsonData = JSON.stringify(Object.fromEntries(validatorMap), null, 2);
fs.writeFileSync('nodeIdToStake.json', jsonData);
console.log(`\nSaved validator stake data to nodeIdToStake.json`);
