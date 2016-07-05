thingproxyplus
==============

A forward proxy server that handles responses that don't support CORS, HTTPS and or JSON.  Also a static web server.  Forked from (https://github.com/Freeboard/thingproxy).

### what?

thingproxyplus allows javascript code on your site to access resources on other domains that would normally be blocked due to the [same-origin policy](http://en.wikipedia.org/wiki/Same_origin_policy). It acts as a proxy between your browser and a remote server and adds the proper CORS headers to the response.

In addition, some browsers don't allow requests for non-encrypted HTTP data if the page itself is loaded from HTTPS. thingproxyplus also allows you to access non-secure HTTP API's from a secure HTTPS url. 

Further, some HTTP endpoints you use may not return JSON.  thingproxyplus can marshal some non-JSON responses into JSON.  The initial implementation of this proxies an HTTP response to JSON containing the HTTP result status.

Finally, you may need a static web server to serve, say, freeboard.  That's included, too.

### why?

Dashboards created with freeboard normally access APIs directly from ajax calls from javascript. Many API providers do not provide the proper CORS headers, or don't support HTTPS, or aren't truly APIs, but other types of HTTP endpoints — thingproxyplus is provided to overcome these limitations.

### how?

For CORS or HTTPS support, just prefix any url with http(s)://your-server:your-port/fetch/

For example:

```
http://my.proxy.server:3000/fetch/http://my.api.com/get/stuff
```

Any HTTP method, headers and body you send, will be sent to the URL you specify and the response will be sent back to you with the proper CORS headers attached.

To get a JSON response with the HTTP result of a "plain" HTTP action, prefix the url with http(s)://your-server:your-port/httpresult/

For example:

```
http://my.proxy.server:3000/httpresult/http://my.web.server/any-path
```

To serve up static content, set config.document_root to point to the directory holding the content.

### caveats

By default, requests and responses are limited to 100,000 characters each, and each client IP is limited to 10 requests/second.

### privacy

The proxy server logs the date, requester's IP address, and URL for each request sent to it. If you use this software internal to an organization, that should not be a problem.  If you use this software to provide a service to others, please respect the privacy of your users.

