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

function writeResponse(res, httpCode, body) {
	res.statusCode = httpCode;
	res.end(body);
}

function sendInvalidURLResponse(res) {
	return writeResponse(res, 404, "url must be in the form of /(fetch|httpresult)/{some_url_here}");
}

function sendTooBigResponse(res) {
	return writeResponse(res, 413, "the content in the request or response cannot exceed " + config.max_request_length + " characters.");
}

function getClientAddress(req) {
	return (req.headers['x-forwarded-for'] || '').split(',')[0]
		|| req.connection.remoteAddress;
}

function processRequest(req, res)
{
	addCORSHeaders(req, res);

	// Return options pre-flight requests right away
	if (req.method.toUpperCase() === "OPTIONS")
	{
		return writeResponse(res, 204);
	}

	var result = config.fetch_regex.exec(req.url);

	if (result && result.length == 3 && result[2]) {
		var remoteURL;

		try {
			remoteURL = url.parse(decodeURI(result[2]));
		}
		catch (e) {
			return sendInvalidURLResponse(res);
		}

		// We don't support relative links
		if(!remoteURL.host)
		{
			return writeResponse(res, 404, "relative URLS are not supported");
		}

		// Naughty, naughty— deny requests to blacklisted hosts
		if(config.blacklist_hostname_regex.test(remoteURL.hostname))
		{
			return writeResponse(res, 400, "host is blacklisted");
		}

		// We only support http and https
		if (remoteURL.protocol != "http:" && remoteURL.protocol !== "https:") {
			return writeResponse(res, 400, "only http and https are supported");
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
		}

        // Make sure the host header is to the URL we're requesting, not thingproxy
        if(req.headers["host"]) {
            req.headers["host"] = remoteURL.host;
        }

		var proxyRequest = request({
			url: remoteURL,
			headers: req.headers,
			method: req.method,
			timeout: config.proxy_request_timeout_ms,
			strictSSL : false
		});

		proxyRequest.on('error', function(err){

			if(err.code === "ENOTFOUND")
			{
				return writeResponse(res, 502, "host cannot be found.")
			}
			else
			{
				console.log("Proxy Request Error: " + err.toString());
				return writeResponse(res, 500);
			}

		});

		if (result[1] == 'httpresult') {
			proxyRequest.on('response', function(response) {
				console.log("Response code: " + response.statusCode);
				res.setHeader('content-type', 'application/json');
				proxyResponse = {statusCode: response.statusCode, isSuccess: (response.statusCode >= 200 && response.statusCode < 300)};
				return writeResponse(res, 200, JSON.stringify(proxyResponse));
			});
		}

		var requestSize = 0;
		var proxyResponseSize = 0;

		req.pipe(proxyRequest).on('data', function(data){

			requestSize += data.length;

			if(requestSize >= config.max_request_length)
			{
				proxyRequest.end();
				return sendTooBigResponse(res);
			}
		});

		if (result[1] == 'httpresult') {
			return;
		}

		proxyRequest.pipe(res).on('data', function (data) {

			proxyResponseSize += data.length;

			if(proxyResponseSize >= config.max_request_length)
			{
				proxyRequest.end();
				return sendTooBigResponse(res);
			}
		});
	}
	else {
		var fullpath = path.join(config.document_root, req.url);
		console.info('Open ' + fullpath);
		try {
			var rs = fs.createReadStream(fullpath);
			rs.on('end', function () {
				res.end();
			})
			res.statusCode = 200;
			rs.pipe(res);
		} catch (e) {
			console.error(e);
			return sendInvalidURLResponse(res);
		}
	}
}

http.createServer(function (req, res) {

	// Process AWS health checks
	if(req.url === "/health")
	{
		return writeResponse(res, 200);
	}

	var clientIP = getClientAddress(req);

	req.clientIP = clientIP;

	// Log our request
	if(config.enable_logging)
	{
		console.log("%s %s %s", (new Date()).toJSON(), clientIP, req.method, req.url);
	}

	if(config.enable_rate_limiting)
	{
		throttle.rateLimit(clientIP, function(err, limited) {
			if (limited)
			{
				return writeResponse(res, 429, "enhance your calm");
			}

			processRequest(req, res);
		})
	}
	else
	{
		processRequest(req, res);
	}

}).listen(port);

console.log("listening on port " + port);
