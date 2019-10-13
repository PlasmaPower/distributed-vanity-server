const child_process = require("child_process");
const restify = require("restify");

const config = require("./config.json");
const maxBits = config.maxBits || (1 + config.maxCharacters*32);

const validKeyRegex = /^[0-9a-fA-F]{64}$/;
function validateBasePublicKey(publicKey) {
    if (typeof publicKey !== "string" || !validKeyRegex.test(publicKey)) {
        throw new Error("Invalid basePublicKey");
    }
}

function validatePrefix(prefix) {
    if (typeof prefix !== "string" || !/^[13*.][13456789abcdefghijkmnopqrstuwxyz*.]{0,59}$/.test(prefix)) {
        throw new Error("Invalid prefix");
    }
}

function processRequest(basePublicKey, prefix) {
    validateBasePublicKey(basePublicKey);
    // These mean the same thing, and the latter is more safe.
    prefix = prefix.replace(/\*/g, '.');
    validatePrefix(prefix);
    return new Promise((resolve, reject) => {
        try {
            const args = config.nanoVanityCommand.slice(1);
            args.push("--simple-output");
            args.push(prefix);
            args.push("--public-offset");
            args.push(basePublicKey);
            const child = child_process.spawn(config.nanoVanityCommand[0], args, {
                stdio: ["ignore", "pipe", "inherit"]
            });
            let result = "";
            child.stdout.on("data", function(data) {
                result += data.toString();
            });
            child.on("close", function(code) {
                let key = result.slice(0, result.indexOf(" "));
                if (!validKeyRegex.test(key)) {
                    reject(new Error("nano-vanity returned invalid key. Result: " + result));
                }
                console.error("Mining complete!");
                resolve(key);
            });
            child.on("error", function(err) {
                reject(err);
            });
        } catch(err) {
            reject(err);
        }
    });
}

const requestStatuses = {};
const requestQueue = [];
let processingRequests = false;

async function queueRequest(basePublicKeyParam, prefixParam) {
    requestQueue.push([basePublicKeyParam, prefixParam]);
    if (!processingRequests) {
        processingRequests = true;
        while (requestQueue.length > 0) {
            const [basePublicKey, prefix] = requestQueue.shift();
            try {
                validateBasePublicKey(basePublicKey);
                validatePrefix(prefix);
            } catch (err) {
                console.log("Request in queue failed validation!");
                continue;
            }
            const statusKey = basePublicKey + prefix;
            try {
                const result = await processRequest(basePublicKey, prefix);
                requestStatuses[statusKey] = { result };
            } catch (err) {
                console.error(err);
                requestStatuses[statusKey] = {
                    error: "Internal mining error"
                };
            }
        }
        processingRequests = false;
    }
}

function countBitsInPrefix(prefix) {
    let bits = 0;
    if (prefix[0] !== "*") {
        bits++;
    }
    for (let c of prefix.slice(1)) {
        if (c !== "*") {
            bits += 32;
        }
    }
    return bits;
}

function info(req, res, next) {
    res.json({
        name: "miner name",
        demand: "none",
        maxBits
    });
    return next();
}

function poll(req, res, next) {
    const {basePublicKey, prefix} = req.query;
    try {
        validateBasePublicKey(basePublicKey);
        validatePrefix(prefix);
    } catch (err) {
        return res.json({
            error: err.toString()
        });
    }
    if (countBitsInPrefix(prefix) > maxBits) {
        return res.json({
            error: "Too many bits in prefix"
        });
    }
    const statusKey = basePublicKey + prefix;
    if (!requestStatuses.hasOwnProperty(statusKey)) {
        requestStatuses[statusKey] = {};
        queueRequest(basePublicKey, prefix);
    }
    res.json(requestStatuses[statusKey]);
    return next();
}

const server = restify.createServer();

server.pre(restify.plugins.pre.dedupeSlashes());

server.use((req,res,next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "X-Requested-With");
    return next();
});
server.use(restify.plugins.queryParser());

server.get("/v1/info", info);
server.get("/v1/poll", poll);

server.listen(config.port, () => console.log("Started up"));
