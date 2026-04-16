'use strict';

var http = require('http');

var BLOCKED = new Set([
    'togglemining',
    'discretemining',
    'setloglevel',
    'createauxblock',
    'submitauxblock',
    'submitsidechainillegaldata',
    'signrawtransactionwithkey'
]);

var INDEXER_METHODS = new Set([
    'gethistory',
    'getcrmember'
]);

var ELA_HOST = '127.0.0.1';
var ELA_PORT = 20336;
var RPC_USER = 'cffa728113f0bb14531eb500fcaf5578';
var RPC_PASS = '39d5cd3032c27f3bdd953c1afa12050e';
var AUTH = Buffer.from(RPC_USER + ':' + RPC_PASS).toString('base64');

var INDEXER_HOST = '127.0.0.1';
var INDEXER_PORT = 8337;

var LISTEN_PORT = 8336;
var MAX_BODY = 65536;
var UPSTREAM_TIMEOUT = 30000;

var CR_FIRST_TERM_START = 658930;
var CR_TERM_LENGTH      = 262800;
var CR_VOTING_PERIOD    = 21600;
var CR_CLAIMING_PERIOD  = 10080;

var cachedHeight = 0;

function pollHeight() {
    var payload = JSON.stringify({ jsonrpc: '2.0', method: 'getblockcount', id: 0 });
    forwardRequest(ELA_HOST, ELA_PORT, payload, AUTH, 5000, function (err, status, body) {
        if (err) return;
        try {
            var resp = JSON.parse(body);
            if (typeof resp.result === 'number' && resp.result > 0) {
                cachedHeight = resp.result;
            }
        } catch (e) { /* keep last known height */ }
    });
}

function transformCRRelatedStage(resp) {
    var r = resp.result;
    if (!r || typeof r.ondutystartheight !== 'number' || typeof r.ondutyendheight !== 'number') return;
    if (r.ondutyendheight <= r.ondutystartheight) return;

    var termStart = r.ondutystartheight;
    var termEnd = r.ondutyendheight;

    r.currentsession = Math.floor((termStart - CR_FIRST_TERM_START) / CR_TERM_LENGTH) + 1;

    var votingEnd = termEnd - 1 - CR_CLAIMING_PERIOD;
    var votingStart = votingEnd - CR_VOTING_PERIOD;
    r.votingstartheight = votingStart;
    r.votingendheight = votingEnd;

    r.claimingStartHeight = votingEnd;
    r.claimingEndHeight = termEnd - 1;

    var h = cachedHeight;
    r.inClaiming = (h >= r.claimingStartHeight && h <= r.claimingEndHeight);
}

function transformListProducers(resp) {
    var r = resp.result;
    if (!r || typeof r !== 'object') return;

    if (typeof r.totaldposv1votes === 'string') {
        r.totalvotes = r.totaldposv1votes;
    }

    if (Array.isArray(r.producers)) {
        for (var i = 0; i < r.producers.length; i++) {
            r.producers[i].onduty = r.producers[i].active === true ? 'Valid' : 'Invalid';
        }
    }
}

var TRANSFORMERS = {
    'getcrrelatedstage': transformCRRelatedStage,
    'listproducers': transformListProducers
};

function applyTransform(method, respObj) {
    var fn = TRANSFORMERS[method];
    if (fn && respObj && respObj.result && !respObj.error) {
        fn(respObj);
    }
}

function jsonError(res, id, code, message, status) {
    res.writeHead(status, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
    });
    res.end(JSON.stringify({
        id: id,
        jsonrpc: '2.0',
        error: { code: code, message: message },
        result: null
    }));
}

function forwardRequest(hostname, port, body, auth, timeout, callback) {
    var headers = {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
    };
    if (auth) {
        headers['Authorization'] = 'Basic ' + auth;
    }

    var proxyReq = http.request({
        hostname: hostname,
        port: port,
        path: '/',
        method: 'POST',
        headers: headers,
        timeout: timeout
    }, function (proxyRes) {
        var responseBody = '';
        var maxResponse = 5 * 1024 * 1024;
        var truncated = false;
        proxyRes.on('data', function (chunk) {
            responseBody += chunk;
            if (responseBody.length > maxResponse) {
                truncated = true;
                proxyReq.destroy();
            }
        });
        proxyRes.on('end', function () {
            if (truncated) {
                callback(new Error('response too large'));
                return;
            }
            callback(null, proxyRes.statusCode, responseBody);
        });
    });

    proxyReq.on('timeout', function () {
        proxyReq.destroy();
        callback(new Error('upstream timeout'));
    });

    proxyReq.on('error', function (err) {
        callback(err);
    });

    proxyReq.write(body);
    proxyReq.end();
}

function processSingleRequest(parsed) {
    var method = (parsed && parsed.method) ? String(parsed.method) : '';
    var id = (parsed && parsed.id !== undefined) ? parsed.id : null;

    if (!method) {
        return { error: true, id: id, code: -32600, message: 'Invalid request: missing method' };
    }
    if (BLOCKED.has(method)) {
        return { error: true, id: id, code: -32601, message: 'Method not allowed' };
    }
    if (INDEXER_METHODS.has(method)) {
        return { target: 'indexer', id: id };
    }
    return { target: 'node', id: id };
}

var server = http.createServer(function (req, res) {
    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
            'Access-Control-Max-Age': '86400'
        });
        res.end();
        return;
    }

    if (req.method !== 'POST') {
        res.writeHead(405);
        res.end('Method Not Allowed');
        return;
    }

    if (req.url !== '/' && req.url !== '/ela') {
        res.writeHead(404);
        res.end('Not Found');
        return;
    }

    var body = '';
    var aborted = false;

    req.on('data', function (chunk) {
        body += chunk;
        if (body.length > MAX_BODY) {
            aborted = true;
            req.destroy();
            jsonError(res, null, -32600, 'Request too large', 413);
        }
    });

    req.on('end', function () {
        if (aborted) return;

        var parsed;
        try {
            parsed = JSON.parse(body);
        } catch (e) {
            jsonError(res, null, -32700, 'Parse error: invalid JSON', 400);
            return;
        }

        var isBatch = Array.isArray(parsed);

        if (isBatch) {
            if (parsed.length === 0) {
                jsonError(res, null, -32600, 'Invalid request: empty batch', 400);
                return;
            }
            if (parsed.length > 50) {
                jsonError(res, null, -32600, 'Batch too large: max 50 requests', 400);
                return;
            }

            var indexerBatch = [];
            var nodeBatch = [];
            var errorResponses = [];
            var responseMap = {};
            var orderKeys = [];

            for (var i = 0; i < parsed.length; i++) {
                var item = parsed[i];
                var result = processSingleRequest(item);
                var key = 'req_' + i;
                orderKeys.push(key);

                if (result.error) {
                    responseMap[key] = {
                        id: result.id,
                        jsonrpc: '2.0',
                        error: { code: result.code, message: result.message },
                        result: null
                    };
                } else if (result.target === 'indexer') {
                    indexerBatch.push({ key: key, item: item });
                } else {
                    nodeBatch.push({ key: key, item: item });
                }
            }

            var pending = 0;
            if (indexerBatch.length > 0) pending++;
            if (nodeBatch.length > 0) pending++;

            if (pending === 0) {
                var ordered = orderKeys.map(function (k) { return responseMap[k]; });
                res.writeHead(200, {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                });
                res.end(JSON.stringify(ordered));
                return;
            }

            function checkDone() {
                pending--;
                if (pending > 0) return;

                var ordered = orderKeys.map(function (k) { return responseMap[k]; });
                res.writeHead(200, {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                });
                res.end(JSON.stringify(ordered));
            }

            if (nodeBatch.length > 0) {
                var nodeItems = nodeBatch.map(function (b) { return b.item; });
                var nodeBody = JSON.stringify(nodeItems);
                forwardRequest(ELA_HOST, ELA_PORT, nodeBody, AUTH, UPSTREAM_TIMEOUT, function (err, status, respBody) {
                    if (err) {
                        nodeBatch.forEach(function (b) {
                            responseMap[b.key] = {
                                id: b.item.id || null,
                                jsonrpc: '2.0',
                                error: { code: -32603, message: 'Internal error: node unreachable' },
                                result: null
                            };
                        });
                    } else {
                        try {
                            var responses = JSON.parse(respBody);
                            if (Array.isArray(responses)) {
                                for (var j = 0; j < nodeBatch.length && j < responses.length; j++) {
                                    var batchMethod = nodeBatch[j].item.method ? String(nodeBatch[j].item.method) : '';
                                    applyTransform(batchMethod, responses[j]);
                                    responseMap[nodeBatch[j].key] = responses[j];
                                }
                            }
                        } catch (e) {
                            nodeBatch.forEach(function (b) {
                                responseMap[b.key] = {
                                    id: b.item.id || null,
                                    jsonrpc: '2.0',
                                    error: { code: -32603, message: 'Internal error: bad node response' },
                                    result: null
                                };
                            });
                        }
                    }
                    checkDone();
                });
            }

            if (indexerBatch.length > 0) {
                var idxItems = indexerBatch.map(function (b) { return b.item; });
                var idxBody = JSON.stringify(idxItems);
                forwardRequest(INDEXER_HOST, INDEXER_PORT, idxBody, null, UPSTREAM_TIMEOUT, function (err, status, respBody) {
                    if (err) {
                        indexerBatch.forEach(function (b) {
                            responseMap[b.key] = {
                                id: b.item.id || null,
                                jsonrpc: '2.0',
                                error: { code: -32603, message: 'Internal error: indexer unreachable' },
                                result: null
                            };
                        });
                    } else {
                        try {
                            var responses = JSON.parse(respBody);
                            if (Array.isArray(responses)) {
                                for (var j = 0; j < indexerBatch.length && j < responses.length; j++) {
                                    responseMap[indexerBatch[j].key] = responses[j];
                                }
                            }
                        } catch (e) {
                            indexerBatch.forEach(function (b) {
                                responseMap[b.key] = {
                                    id: b.item.id || null,
                                    jsonrpc: '2.0',
                                    error: { code: -32603, message: 'Internal error: bad indexer response' },
                                    result: null
                                };
                            });
                        }
                    }
                    checkDone();
                });
            }

        } else {
            var result = processSingleRequest(parsed);

            if (result.error) {
                jsonError(res, result.id, result.code, result.message, 403);
                return;
            }

            var targetHost, targetPort, targetAuth;
            if (result.target === 'indexer') {
                targetHost = INDEXER_HOST;
                targetPort = INDEXER_PORT;
                targetAuth = null;
            } else {
                targetHost = ELA_HOST;
                targetPort = ELA_PORT;
                targetAuth = AUTH;
            }

            forwardRequest(targetHost, targetPort, body, targetAuth, UPSTREAM_TIMEOUT, function (err, status, respBody) {
                if (err) {
                    var dest = result.target === 'indexer' ? 'indexer' : 'node';
                    jsonError(res, parsed.id || null, -32603, 'Internal error: ' + dest + ' unreachable', 502);
                    return;
                }
                var method = parsed.method ? String(parsed.method) : '';
                if (result.target === 'node' && TRANSFORMERS[method]) {
                    try {
                        var respObj = JSON.parse(respBody);
                        applyTransform(method, respObj);
                        respBody = JSON.stringify(respObj);
                    } catch (e) { /* forward original on parse failure */ }
                }
                res.writeHead(status, {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*'
                });
                res.end(respBody);
            });
        }
    });
});

pollHeight();
setInterval(pollHeight, 3000);

server.listen(LISTEN_PORT, '127.0.0.1', function () {
    console.log('ELA RPC proxy listening on 127.0.0.1:' + LISTEN_PORT);
});
