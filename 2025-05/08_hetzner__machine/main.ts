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
    if (totalDiskA > totalDiskB) {
        return -1;
    } else if (totalDiskA < totalDiskB) {
        return 1;
    } else {
        return a.price - b.price;
    }
});

// Slice to get the top 20 servers
const top20Servers = data.server.slice(0, 20);
top20Servers.forEach(server => {
    const totalDiskSize = server.serverDiskData.nvme.reduce((sum, size) => sum + size, 0)
        + server.serverDiskData.sata.reduce((sum, size) => sum + size, 0);

    const nvmeDisks = server.serverDiskData.nvme.length > 0 ? `nvme ${server.serverDiskData.nvme.join(",")}` : '';
    const sataDisks = server.serverDiskData.sata.length > 0 ? `sata ${server.serverDiskData.sata.join(",")}` : '';
    const hddDisks = server.serverDiskData.hdd.length > 0 ? `hdd ${server.serverDiskData.hdd.join(",")}` : '';

    const allDisks = [nvmeDisks, sataDisks, hddDisks].filter(Boolean).join(" + ");

    console.log(`${server.datacenter} ${server.cpu}, RAM: ${server.ram_size}GB, Disk (NVMe+SATA): ${totalDiskSize}GB, Price: ${server.price}, All Disks: ${allDisks}`);
});



