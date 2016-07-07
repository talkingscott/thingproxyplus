var http = require('http');
var fs = require('fs');
var path = require('path');
var config = require("./config");
var url = require("url");
var request = require("request");
var throttle = require("tokenthrottle")({rate: config.max_requests_per_second});

var publicAddressFinder = require("public-address");
var publicIP;

// Get our public IP address
publicAddressFinder(function(err, data){
	if(!err && data)
	{
		publicIP = data.address;
	}
});

var port = config.port;

function addCORSHeaders(req, res)
{
	if (req.method.toUpperCase() === "OPTIONS")
	{
		if(req.headers["access-control-request-headers"])
		{
			res.setHeader("Access-Control-Allow-Headers", req.headers["access-control-request-headers"]);
		}

		if(req.headers["access-control-request-method"])
		{
			res.setHeader("Access-Control-Allow-Methods", req.headers["access-control-request-method"]);
		}
	}

	if(req.headers["origin"])
	{
		res.setHeader("Access-Control-Allow-Origin", req.headers["origin"]);
	}
	else
	{
		res.setHeader("Access-Control-Allow-Origin", "*");
	}
}

function writeResponse(res, httpCode, body, logger) {
	res.statusCode = httpCode;
	res.end(body);
	logger(httpCode);
}

function sendNotFoundResponse(res, logger) {
	return writeResponse(res, 404, "", logger);
}

function sendTooBigResponse(res, logger) {
	return writeResponse(res, 413, "the content in the request or response cannot exceed " + config.max_request_length + " characters.", logger);
}

function trace(msg) {
	if (config.enable_tracing) {
		console.log(msg);
	}
}

function getClientAddress(req) {
	return (req.headers['x-forwarded-for'] || '').split(',')[0]
		|| req.connection.remoteAddress;
}

function processRequest(req, res, logger)
{
	trace('Request URL: ' + req.url);

	addCORSHeaders(req, res);

	// Return options pre-flight requests right away
	if (req.method.toUpperCase() === "OPTIONS")
	{
		trace('OPTIONS request');
		return writeResponse(res, 204, logger);
	}

	var result = config.fetch_regex.exec(req.url);

	if (result && result.length == 3 && result[2]) {
		var remoteURL;

		trace('Unparsed remote URL: ' + result[2]);
		try {
			remoteURL = url.parse(decodeURI(result[2]));
			trace('RemoteURL: ' + url.format(remoteURL));
		}
		catch (e) {
			trace('URL parsing failed: ' + e);
			return sendInvalidURLResponse(res, logger);
		}

		// We don't support relative links
		if(!remoteURL.host)
		{
			trace('Relative URL: ' + remoteURL);
			return writeResponse(res, 404, "relative URLS are not supported", logger);
		}

		// Naughty, naughty— deny requests to blacklisted hosts
		if(config.blacklist_hostname_regex.test(remoteURL.hostname))
		{
			trace('Blacklisted host: ' + remoteURL.hostname);
			return writeResponse(res, 400, "host is blacklisted", logger);
		}

		// We only support http and https
		if (remoteURL.protocol != "http:" && remoteURL.protocol !== "https:") {
			trace('Unsupported scheme: ' + remoteURL.protocol);
			return writeResponse(res, 400, "only http and https are supported", logger);
		}

		if(publicIP)
		{
			// Add an X-Forwarded-For header
			if(req.headers["x-forwarded-for"])
			{
				req.headers["x-forwarded-for"] += ", " + publicIP;
			}
			else
			{
				req.headers["x-forwarded-for"] = req.clientIP + ", " + publicIP;
			}
			trace('x-forwarded-for set: ' + req.headers['x-forwarded-for']);
		}

        // Make sure the host header is to the URL we're requesting, not thingproxy
        if(req.headers["host"]) {
            req.headers["host"] = remoteURL.host;
			trace('host set: ' + req.headers['host']);
        }

		var proxyRequest = request({
			url: remoteURL,
			headers: req.headers,
			method: req.method,
			timeout: config.proxy_request_timeout_ms,
			strictSSL : false
		});

		proxyRequest.on('error', function(err){
			trace('Error on proxy request: ' + err);

			if (res.headersSent) {
				trace('Headers already sent, just end response');
				res.end();
				return;
			}

			if (result[1] === 'httpresult') {
				res.setHeader('content-type', 'application/json');
				proxyResponse = {statusCode: err.code === "ENOTFOUND" ? 502 : 500, isSuccess: false};
				return writeResponse(res, 200, JSON.stringify(proxyResponse), logger);
			} else {
				if(err.code === "ENOTFOUND")
				{
					return writeResponse(res, 502, "host cannot be found.", logger)
				}
				else
				{
					console.log("Proxy Request Error: " + err.toString());
					return writeResponse(res, 500, "", logger);
				}
			}
		});

		if (result[1] === 'httpresult') {
			proxyRequest.on('response', function (response) {
				trace('Response on proxy request: ' + response.statusCode);
				res.setHeader('content-type', 'application/json');
				proxyResponse = {statusCode: response.statusCode, isSuccess: (response.statusCode >= 200 && response.statusCode < 300)};
				return writeResponse(res, 200, JSON.stringify(proxyResponse), logger);
			});
		}

		var requestSize = 0;
		var proxyResponseSize = 0;

		req.pipe(proxyRequest);
		req.on('data', function (data) {
			trace('Data piped from request to proxy request; length: ' + data.length);

			requestSize += data.length;

			if (requestSize >= config.max_request_length) {
				trace('Request too large: ' + requestSize);
				proxyRequest.end();
				return sendTooBigResponse(res, logger);
			}
		});

		if (result[1] === 'httpresult') {
			return;
		}

		proxyRequest.pipe(res);
		proxyRequest.on('data', function (data) {
			trace('Data piped from proxy request to result; length: ' + data.length);

			proxyResponseSize += data.length;

			if(proxyResponseSize >= config.max_request_length)
			{
				trace('Response too large: ' + proxyResponseSize);
				proxyRequest.end();
				return sendTooBigResponse(res, logger);
			}
		});
		proxyRequest.on('end', function () {
			trace('Done piping from proxy request to result');
			res.end();
			logger(200);
		});
	}
	else {
		var fullpath = path.join(config.document_root, req.url);
		if (fullpath.endsWith("/")) {
			fullpath = path.join(fullpath, config.default_doc);
		}

		trace('Static content requested: ' + fullpath);

		var rs = fs.createReadStream(fullpath);
		rs.on('error', function (err) {
			console.error('Piping ' + fullpath + ': ' + err);
			return sendNotFoundResponse(res, logger);
		});
		rs.on('end', function () {
			trace('Piped: ' + fullpath);
			res.end();
			logger(200);
		});
		res.statusCode = 200;
		rs.pipe(res);
	}
}

http.createServer(function (req, res) {

	var clientIP = getClientAddress(req);

	var logger = function (resultCode) {
		if(config.enable_logging)
		{
			console.log("%s %s %s %s %s", (new Date()).toJSON(), clientIP, resultCode, req.method, req.url);
		}
	};

	// Process AWS health checks
	if(req.url === "/health")
	{
		trace('Health check');
		return writeResponse(res, 200, logger);
	}

	req.clientIP = clientIP;

	if(config.enable_rate_limiting)
	{
		throttle.rateLimit(clientIP, function(err, limited) {
			if (limited)
			{
				trace('Limited');
				return writeResponse(res, 429, "enhance your calm", logger);
			}

			resultCode = processRequest(req, res, logger);
		})
	}
	else
	{
		resultCode = processRequest(req, res, logger);
	}

}).listen(port);

console.log("listening on port " + port);
