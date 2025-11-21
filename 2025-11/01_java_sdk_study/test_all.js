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

        // Compare full outputs
        if (goOutput.trim() === javaOutput.trim()) {
            console.log(`✓ Line ${i + 1} (Block ${blockNum}): PASS`);
            passCount++;
        } else {
            console.log(`❌ Line ${i + 1} (Block ${blockNum}): FAIL - Outputs differ`);
            failCount++;
            failures.push({ line: i + 1, blockNum, goOutput, javaOutput });
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
    console.log(`\nFirst 5 failed tests (showing diff):`);
    failures.slice(0, 5).forEach(f => {
        console.log(`\n--- Line ${f.line} (Block ${f.blockNum}) ---`);
        if (f.goOutput && f.javaOutput) {
            console.log('Go output:');
            console.log(f.goOutput.split('\n').slice(0, 15).join('\n'));
            console.log('\nJava output:');
            console.log(f.javaOutput.split('\n').slice(0, 15).join('\n'));
        } else {
            console.log(`  ${f.reason || 'Unknown error'}`);
        }
    });
}

