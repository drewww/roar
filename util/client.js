var program = require('commander')
  , client = require('socket.io-client')
  , async = require('async')
  , winston = require('winston')
;


var logger = new (winston.Logger)({
    transports: [
      new (winston.transports.Console)({timestamp:true, level:"info", colorize:true}),
    ]
  });


var verbose = false;

program.version('0.1')
    .option('-u, --url <url>', 'base URL of the server to test')
    .option('-c, --connections <connections>', 'number of connections, default 1', Number, 1)
    .parse(process.argv)


clients = [];

function connect(url, connections, callback) {
    
    logger.info("Connect to " + url + "x" + connections);
    
    // try doing this serially for now.
    var inits = [];
    for(var i=0; i<connections; ++i) {
        inits.push(function(next) {
            logger.verbose("Starting connection ", i);
            var conn = client.connect(program.url, {'force new connection': true});
            conn.on('connect', function() {
               logger.verbose("connected sessionid=" + conn.socket.sessionid);
               conn.emit("identify", {username:"user-" +
                (Math.random()*Date.now()).toFixed(0).substring(0, 6)});
            });

            conn.on('identify', function(data) {
                if("state" in data && data["state"]=="OK") {
                    logger.verbose(conn.socket.sessionid + ": server ACK identify");
                    // For now default to a specific room. 
                    conn.emit("room", {"name":"General Chat 1"});
                    clients.push(conn);
                } else if ("state" in data && data["state"] == "TAKEN") {
                    logger.verbose(conn.socket.sessionid + ": server FAIL identify, retry");
                    conn.emit("identify", {username:"user-" +
                     (Math.random()*Date.now()).toFixed(0).substring(0, 6)});
                }
            });
            
            conn.on('disconnect', function(data) {
                logger.warning(conn.socket.sessionid + ": disconnected ", data);
            });
                        
            next();
        });
    }
    
    async.series(inits, function(err) {
        if(err) {
            logger.error("Error initing connections: " + err);
            process.exit(1);
        }
        
        logger.info("Connection setup complete.");
        callback(clients);
    });
}

connect(program.url, program.connections, function() {
   logger.info("Initialized all connections!");
   
   
   // Now periodically run through all the clients and make them say things
   setTimeout(_processChat, 100);
});


function _processChat() {
    
    setTimeout(_processChat, 100);

    for (var index in clients) {
        var client = clients[index];

        var random = Math.random();

        if (random < 0.002)
            client.emit("chat", {text:"robot chat testing throughput"});
    }

}
