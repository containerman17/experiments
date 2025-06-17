#!/usr/bin/env -S bun
import { Table } from "console-table-printer";

export { }; // Make this file a module to allow top-level await

interface ServerDiskData {
    nvme: number[];
    sata: number[];
    hdd: number[];
    general: number[];
}

interface IpPrice {
    Monthly: number;
    Hourly: number;
    Amount: number;
}

interface Server {
    id: number;
    key: number;
    name: string;
    description: string[];
    information: string[];
    category: string;
    cat_id: number;
    cpu: string;
    cpu_count: number;
    is_highio: boolean;
    traffic: string;
    bandwidth: number;
    ram: string[];
    ram_size: number;
    price: number;
    setup_price: number;
    hourly_price: number;
    hdd_arr: string[];
    hdd_hr: string[];
    hdd_size: number;
    hdd_count: number;
    serverDiskData: ServerDiskData;
    is_ecc: boolean;
    datacenter: string;
    datacenter_hr: string;
    specials: string[];
    dist: string[];
    fixed_price: boolean;
    next_reduce: number;
    next_reduce_hr: boolean;
    next_reduce_timestamp: number;
    ip_price: IpPrice;
}

interface HetznerData {
    server: Server[];
}

const response = await fetch("https://www.hetzner.com/_resources/app/data/app/live_data_sb_USD.json");
const data: HetznerData = await response.json();

// Sort servers by total NVMe + SATA disk size in descending order
data.server.sort((a, b) => {
    const totalDiskA = a.serverDiskData.nvme.reduce((sum, size) => sum + size, 0) + a.serverDiskData.sata.reduce((sum, size) => sum + size, 0);
    const totalDiskB = b.serverDiskData.nvme.reduce((sum, size) => sum + size, 0) + b.serverDiskData.sata.reduce((sum, size) => sum + size, 0);


    // if (totalDiskA > totalDiskB) {
    //     return -1;
    // } else if (totalDiskA < totalDiskB) {
    //     return 1;
    // } else {
    //     return a.price - b.price;
    // }

    const coefA = totalDiskA / a.price;
    const coefB = totalDiskB / b.price;

    return coefB - coefA;
});

// Create table
const table = new Table({
    title: "Top 20 Hetzner Servers by Disk/Price Ratio",
    columns: [
        { name: 'datacenter', title: 'Datacenter', alignment: 'left' },
        { name: 'cpu', title: 'CPU', alignment: 'left' },
        { name: 'ram', title: 'RAM (GB)', alignment: 'right' },
        { name: 'totalDisk', title: 'Total Disk (GB)', alignment: 'right' },
        { name: 'price', title: 'Price ($)', alignment: 'right' },
        { name: 'ratio', title: 'GB/$', alignment: 'right' },
        { name: 'allDisks', title: 'All Disks', alignment: 'left' }
    ]
});

const desiredCpus = ["AMD Ryzen 9 5950X", "Intel Core i9-12900K", "Intel Core i5-12500"];

data.server.forEach(server => {
    if (!desiredCpus.includes(server.cpu)) {
        return;
    }

    const totalDiskSize = server.serverDiskData.nvme.reduce((sum, size) => sum + size, 0)
        + server.serverDiskData.sata.reduce((sum, size) => sum + size, 0);

    // Helper function to format disk arrays
    const formatDisks = (disks: number[], type: string) => {
        if (disks.length === 0) return '';

        const counts = new Map<number, number>();
        disks.forEach(size => {
            counts.set(size, (counts.get(size) || 0) + 1);
        });

        const formatted = Array.from(counts.entries())
            .map(([size, count]) => count === 1 ? `${size}` : `${size} x${count}`)
            .join(',');

        return `${type} ${formatted}`;
    };

    const nvmeDisks = formatDisks(server.serverDiskData.nvme, 'nvme');
    const sataDisks = formatDisks(server.serverDiskData.sata, 'sata');
    const hddDisks = formatDisks(server.serverDiskData.hdd, 'hdd');

    const allDisks = [nvmeDisks, sataDisks, hddDisks].filter(Boolean).join(" + ");
    const ratio = (totalDiskSize / server.price).toFixed(1);

    table.addRow({
        datacenter: server.datacenter,
        cpu: server.cpu,
        ram: server.ram_size,
        totalDisk: totalDiskSize,
        price: server.price,
        ratio: ratio,
        allDisks: allDisks
    });
});

table.printTable();



const allCpus = [...new Set(data.server.map(server => server.cpu))].sort();
console.log(`Desired CPUs: ${desiredCpus.join(", ")}. Undesired CPUs: ${allCpus.join(", ")}`);
