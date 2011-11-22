var program = require('commander')
  , client = require('socket.io-client')
  , async = require('async')
  , logger = require('winston')
;

logger.cli();
logger.default.transports.console.timestamp = true;
logger.setLevels()

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
            logger.debug("Starting connection ", i);
            var conn = client.connect(program.url, {'force new connection': true});
            conn.on('connect', function() {
               logger.info("connected sessionid=" + conn.socket.sessionid);
               conn.emit("identify", {username:"user-" +
                (Math.random()*Date.now()).toFixed(0).substring(0, 6)});
            });

            conn.on('identify', function(data) {
                if("state" in data && data["state"]=="OK") {
                    logger.debug(conn.socket.sessionid + ": server ACK identify");
                    // For now default to a specific room. 
                    conn.emit("room", {"name":"General Chat 1"});
                    clients.push(conn);
                } else if ("state" in data && data["state"] == "TAKEN") {
                    logger.debug(conn.socket.sessionid + ": server FAIL identify, retry");
                    conn.emit("identify", {username:"user-" +
                     (Math.random()*Date.now()).toFixed(0).substring(0, 6)});
                }
            });

            conn.on('message', function(data) {
                if(data.text=="MARCO") {
                    conn.emit("message", {text:"POLO"});
                } else if(data.text=="CIAO") {
                    conn.disconnect();
                }
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
});


