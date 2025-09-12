import fs from 'fs';

const data = JSON.parse(fs.readFileSync('nodeIdToLocation.json', 'utf8'));

// Helper to format stake in AVAX (divide by 10^9) using BigInt for precision
const formatStake = (stake: string): number => Number(BigInt(stake) / BigInt(1_000_000_000));

// Aggregate data
const countryStakes = new Map<string, number>();
const regionStakes = new Map<string, number>();
const cityStakes = new Map<string, number>();
const orgStakes = new Map<string, number>();

for (const [nodeId, info] of Object.entries(data)) {
    const stake = formatStake((info as any).stake);
    const loc = (info as any).location;

    // Aggregate by country
    countryStakes.set(loc.country, (countryStakes.get(loc.country) || 0) + stake);

    // Aggregate by region (country + region for clarity)
    const regionKey = `${loc.country} - ${loc.region}`;
    regionStakes.set(regionKey, (regionStakes.get(regionKey) || 0) + stake);

    // Aggregate by city (country + city for clarity)
    const cityKey = `${loc.city}, ${loc.country}`;
    cityStakes.set(cityKey, (cityStakes.get(cityKey) || 0) + stake);

    // Aggregate by org
    orgStakes.set(loc.org, (orgStakes.get(loc.org) || 0) + stake);
}

// Helper to sort and format results
const getTop10 = (map: Map<string, number>) =>
    Array.from(map.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([name, stake], index) => ({
            rank: index + 1,
            name,
            stake: Math.round(stake).toLocaleString(),
            percentage: ((stake / totalStake) * 100).toFixed(2) + '%'
        }));

const totalStake = Array.from(countryStakes.values()).reduce((sum, stake) => sum + stake, 0);

console.log('=== AVALANCHE VALIDATOR STAKE DISTRIBUTION ===\n');
console.log(`Total analyzed nodes: ${Object.keys(data).length}`);
console.log(`Total stake: ${Math.round(totalStake).toLocaleString()} AVAX\n`);

console.log('🌍 TOP 10 COUNTRIES BY STAKE:');
console.log('Rank | Country | Stake (AVAX) | % of Total');
console.log('-----|---------|--------------|----------');
getTop10(countryStakes).forEach(item =>
    console.log(`${item.rank.toString().padStart(4)} | ${item.name.padEnd(20)} | ${item.stake.padStart(12)} | ${item.percentage.padStart(8)}`)
);

console.log('\n🏞️  TOP 10 REGIONS BY STAKE:');
console.log('Rank | Region | Stake (AVAX) | % of Total');
console.log('-----|--------|--------------|----------');
getTop10(regionStakes).forEach(item =>
    console.log(`${item.rank.toString().padStart(4)} | ${item.name.padEnd(30)} | ${item.stake.padStart(12)} | ${item.percentage.padStart(8)}`)
);

console.log('\n🏙️  TOP 10 CITIES BY STAKE:');
console.log('Rank | City | Stake (AVAX) | % of Total');
console.log('-----|------|--------------|----------');
getTop10(cityStakes).forEach(item =>
    console.log(`${item.rank.toString().padStart(4)} | ${item.name.padEnd(25)} | ${item.stake.padStart(12)} | ${item.percentage.padStart(8)}`)
);

console.log('\n🏢 TOP 10 ORGANIZATIONS BY STAKE:');
console.log('Rank | Organization | Stake (AVAX) | % of Total');
console.log('-----|--------------|--------------|----------');
getTop10(orgStakes).forEach(item =>
    console.log(`${item.rank.toString().padStart(4)} | ${item.name.padEnd(25)} | ${item.stake.padStart(12)} | ${item.percentage.padStart(8)}`)
);

// Stake concentration analysis
console.log('\n📊 VALIDATOR STAKE CONCENTRATION:');

// Get individual validator stakes and sort by stake amount
const validatorStakes = Object.values(data).map((info: any) => formatStake(info.stake)).sort((a, b) => b - a);

const concentrationTiers = [1, 3, 10, 20, 50, 100, 400];
console.log('Top N | Cumulative Stake (AVAX) | % of Total Stake');
console.log('------|-------------------------|----------------');

concentrationTiers.forEach(n => {
    if (n <= validatorStakes.length) {
        const cumulativeStake = validatorStakes.slice(0, n).reduce((sum, stake) => sum + stake, 0);
        const percentage = ((cumulativeStake / totalStake) * 100).toFixed(2);
        console.log(`${n.toString().padStart(5)} | ${Math.round(cumulativeStake).toLocaleString().padStart(23)} | ${percentage.padStart(13)}%`);
    }
});

// Individual validator sizes by rank
console.log('\n🎯 INDIVIDUAL VALIDATOR SIZES BY RANK:');
const sizeRanks = [1, 3, 10, 20, 50, 100, 400];
console.log('Rank | Individual Stake (AVAX) | % of Total Stake');
console.log('-----|------------------------|----------------');

sizeRanks.forEach(rank => {
    if (rank <= validatorStakes.length) {
        const individualStake = validatorStakes[rank - 1]; // rank-1 because array is 0-indexed
        const percentage = ((individualStake / totalStake) * 100).toFixed(2);
        console.log(`${rank.toString().padStart(4)} | ${Math.round(individualStake).toLocaleString().padStart(22)} | ${percentage.padStart(13)}%`);
    }
});

console.log(`\nTotal validators: ${validatorStakes.length}`);
console.log(`Median validator stake: ${Math.round(validatorStakes[Math.floor(validatorStakes.length / 2)]).toLocaleString()} AVAX`);
console.log(`Average validator stake: ${Math.round(totalStake / validatorStakes.length).toLocaleString()} AVAX`);
