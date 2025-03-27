export const subnetId = "wtXkXTnEqWzyCb3t9XaV5gNrvhrnWaZoFmGivzKZPJycE424a"

// export const chainID = ""//45m 45000000 0x2AEA540
// export const chainID = ""//50m 50000000 0x2FAF080
// export const chainID = ""//55m 55000000 0x3473BC0
// export const chainID = ""//75m 75000000 0x47868C0
// export const chainID = ""//100m 100000000 0x5F5E100
export const chainID = "2g9dUnxFVuR6xBgMzjaRfRdGgKCbrmMcQ9SVsRZAViqbXZzqTs"//200m 200000000 0xBEBC200
export const githubUsername = "containerman17"
export const delay = "400ms"
export const evmbombardCommit = "b199d0d"
export const batchSize = 50
export const keys = 2000
export const instancesPerRegion = 5
// export const instanceType = "m7i.4xlarge" // 4th gen, for all regions
export const instanceType = "i7ie.4xlarge" // 5th gen, doesn't work everywhere

export const regions = [
    {
        region: "ap-northeast-1",
        regionName: "tokyo",
        ami: "ami-026c39f4021df9abe",
        enabled: true
    },
    {
        region: "eu-central-1",
        regionName: "frankfurt",
        ami: "ami-03250b0e01c28d196",
        enabled: false,
    },
    {
        region: "us-east-2",
        regionName: "ohio",
        ami: "ami-04f167a56786e4b09",
        enabled: false
    },
    {
        region: "us-west-2",
        regionName: "oregon",
        ami: "ami-075686beab831bb7f",
        enabled: false
    },
    {
        region: "ap-south-1",
        regionName: "mumbai",
        ami: "ami-0e35ddab05955cf57",
        enabled: false
    },
    {
        region: "ap-southeast-1",
        regionName: "singapore",
        ami: "ami-01938df366ac2d954",
        enabled: false
    },
    {
        region: "sa-east-1",
        regionName: "sao_paulo",
        ami: "ami-0d866da98d63e2b42",
        enabled: false
    },
    {
        region: "ap-southeast-2",
        regionName: "sydney",
        ami: "ami-0f5d1713c9af4fe30",
        enabled: false
    },
    {
        region: "eu-west-2",
        regionName: "london",
        ami: "ami-0a94c8e4ca2674d5a",
        enabled: false
    },
    {
        region: "eu-north-1",
        regionName: "stockholm",
        ami: "ami-0c1ac8a41498c1a9c",
        enabled: false
    }
];
