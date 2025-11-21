#!/usr/bin/env node

const { execSync } = require('child_process');
const fs = require('fs');

// Read examples.txt
const lines = fs.readFileSync('examples.txt', 'utf-8').trim().split('\n');

console.log(`Testing ${lines.length} examples...\n`);

let passCount = 0;
let failCount = 0;
const failures = [];

for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const [blockNum, hexData] = line.split('\t');
    if (!hexData) {
        console.log(`Line ${i + 1}: Invalid format, skipping`);
        continue;
    }

    try {
        // Run Go decoder
        const goOutput = execSync(`go run decode_extra.go ${hexData}`, {
            encoding: 'utf-8',
            cwd: __dirname
        });

        // Run Java decoder
        const javaOutput = execSync(`java BlockExtraDataDemo.java ${hexData}`, {
            encoding: 'utf-8',
            cwd: __dirname
        });

        // Extract transaction IDs for comparison
        const goIdMatch = goOutput.match(/ID: (0x[0-9a-f]{64})/);
        const javaIdMatch = javaOutput.match(/ID: (0x[0-9a-f]{64})/);

        if (!goIdMatch || !javaIdMatch) {
            console.log(`❌ Line ${i + 1} (Block ${blockNum}): Failed to parse transaction IDs`);
            failCount++;
            failures.push({ line: i + 1, blockNum, reason: 'Failed to parse IDs' });
            continue;
        }

        const goId = goIdMatch[1];
        const javaId = javaIdMatch[1];

        if (goId === javaId) {
            console.log(`✓ Line ${i + 1} (Block ${blockNum}): PASS - ID ${goId.substring(0, 16)}...`);
            passCount++;
        } else {
            console.log(`❌ Line ${i + 1} (Block ${blockNum}): FAIL`);
            console.log(`   Go:   ${goId}`);
            console.log(`   Java: ${javaId}`);
            failCount++;
            failures.push({ line: i + 1, blockNum, goId, javaId });
        }
    } catch (error) {
        console.log(`❌ Line ${i + 1} (Block ${blockNum}): ERROR - ${error.message.split('\n')[0]}`);
        failCount++;
        failures.push({ line: i + 1, blockNum, reason: 'Execution error', error: error.message });
    }
}

console.log(`\n${'='.repeat(60)}`);
console.log(`RESULTS: ${passCount} passed, ${failCount} failed out of ${lines.length} tests`);
console.log(`Success rate: ${((passCount / lines.length) * 100).toFixed(2)}%`);

if (failures.length > 0) {
    console.log(`\nFailed tests:`);
    failures.forEach(f => {
        console.log(`  Line ${f.line} (Block ${f.blockNum}): ${f.reason || 'ID mismatch'}`);
    });
}

