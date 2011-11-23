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

            conn.on("chat", function(data) {
                if(data.text=="MARCO") {
                    setTimeout(function() {
                        conn.emit("chat", {text:"POLO"});                        
                    }, Math.random()*45000);
                } else if(data.text=="CIAO") {
                    conn.disconnect();
                } else if(data.text!="POLO" && !("admin" in data)){
                    //logger.info("chat: " + data.text);
                }
            });
            
            conn.on('disconnect', function(data) {
                logger.warning(conn.socket.sessionid + ": disconnected ", data);
            });
            
            conn.on('heartbeat', function(data) {
                logger.verbose("heartbeat");
            })
            
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


