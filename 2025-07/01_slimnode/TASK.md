The task is to create an API that starts a node for every subnet ID it receives through an API.

**Code style**
Typescript only. Light on comments, but some needed. Files 50-200 lines, try to not create tiny 5 line files. Functions over objects if possible. 

**API**
Simple api with a static password in .env (loaded via dotenv module).
The request should be idempotent. request takes password and subnetId in the url.
/node_admin/registerSubnet/$subnetId?password=abcabc
Protect the whole /node_admin/ with this password

On registerSubnet request, checks in db if this subnet is registered, check if it is a real subnet, then searches for an empty slot, and if found, gets the oldest subnet, removes it and places the new subnet instead. each node hosts exactly 16 subnets. When filling, select a node with the lowest amount of subnets registered (empty nodes - first).

To check that subnet exists check if this request returns a result, and not error field. No cache here please. 
```
curl -X POST --data '{
    "jsonrpc": "2.0",
    "method": "platform.getSubnet",
    "params": {"subnetID":"FWbUFNjYSpZeSXkDmL8oCCEH3Ks735etnoyicoihpMxAVd1U1"},
    "id": 1
}' -H 'content-type:application/json;' 127.0.0.1:9650/ext/bc/P 
```

**DB structure**
{
    "node001": {
        "FWbUFNjYSpZeSXkDmL8oCCEH3Ks735etnoyicoihpMxAVd1U1": 1753101451446,
        "otherSubnetId": 1753101451000,
    },
    "node002": {}
}
Env variable NODE_COUNT (can not be over 999). For each node store ab object of subnetId to when it was created.
On start of the server, make sure that db has at least an empty object for each of NODE_COUNT nodes. Node numbers should be exactly 3 digits.


**Proxy**
On the same server as API, publicly available. 
On request to /ext/bc/{98qnjenm7MBd8G2cPZoRvZrgJC33JGSAAKghsQ6eojbLCeRNp}/rpc
Where 98qnjenm7MBd8G2cPZoRvZrgJC33JGSAAKghsQ6eojbLCeRNp - chain ID
```
curl -X POST --data '{
    "jsonrpc": "2.0",
    "method": "platform.getTx",
    "params": {
        "txID":"98qnjenm7MBd8G2cPZoRvZrgJC33JGSAAKghsQ6eojbLCeRNp",
        "encoding": "json"
    },
    "id": 1
}' -H 'content-type:application/json;'  127.0.0.1:9650/ext/bc/P | jq -r ".result.tx.unsignedTx.subnetID"
```
This will give you a subnetID. Cache for 10 minutes in memory is successful. You search in the db on which node do you keep this subnetId, and respond ether with code 404 and words like this subnet is not tracked by this node, or actually forward request. On forward only on actual errors like port is not accessible or message that this node is npt done bootstraping (move this string into a const and leave `TODO: fix` comment near it).

Fastify is good, but any other simple to make proxy nodejs server is fine.  Popular enough.


**Rate limits**

Everywhere actual rate limit of 2 requests per second with some decent size bursts. I guess better to count per minute or what's nicer ui? Or just queue those requests. Whatever is easy with your Nodejs server if choice. 
Limit  by IP (taken from cloudflare).

**Tunnel in compose**
Read whatever needed from .env to start a tunnel in docker connecting cloudflare. 

**Readme**
Document everythyng well from a user standpoint with examples and explain about cloudflare. This app also runs in docker, so make sure to set it up in the compose file. 

**Compose**
The first node has to have ports 9650 and 9651. Every other node gets 2 next ports. AVAGO_TRACK_SUBNETS is just all subnets of this node ordered by alphabet. On any changes in the database you reform the compose file and call docker compose up -d. Should contain exactly NODE_COUNT nodes (control this via db). Leave the current compose template file with 2 nodes and add there this app (add Dockerfile and zero build npx tsx run) Also add to this initial compose file the tunnel.
