var program = require('commander')
  , io = require('socket.io-client')
  , async = require('async')
  , winston = require('winston')
;


var logger = new (winston.Logger)({
    transports: [
      new (winston.transports.Console)({timestamp:true, level:"verbose", colorize:true}),
    ]
  });


var verbose = false;

program.version('0.1')
    .option('-u, --url <url>', 'base URL of the server to test')
    .option('-c, --connections <connections>', 'number of connections, default 1', Number, 1)
    .option('-f, --flood', 'enable flood mode, which will generate chat messages as fast as possible. implies -c 1.')
    .parse(process.argv)


if(program.flood) {
    logger.warn("ENGAGING FLOOD MODE. FIRE IN THE HOLE");
}

clients = [];

function connect(url, connections, callback) {
    
    logger.info("Connect to " + url + "x" + connections);
    
    // try doing this serially for now.
    var inits = [];
    
    if(program.flood) 
        connections = 1;
    
    for(var i=0; i<connections; ++i) {
        inits.push(function(next) {
            logger.verbose("Starting connection ", i);
            var conn = io.connect(program.url, {'force new connection': true});
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
                logger.warn(conn.socket.sessionid + ": disconnected ", data);
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
   
   if(program.flood) {
       setTimeout(_floodChat, 50);
   } else {
       setTimeout(_processChat, 250);
   }
});


function _floodChat() {
    
    setTimeout(_floodChat, 50);
    for(var index in clients) {
        var client = clients[index];
        
        client.emit("chat", {text:"SPAM SPAM SPAM"});
    }
}

function _processChat() {
    
    logger.verbose("processing chat");
    setTimeout(_processChat, 250);

    for (var index in clients) {
        
        
        var client = clients[index];

        if(index % 50==0) {
            logger.verbose("on client " + index + " " + client.socket.sessionid);
        }


        if(client.socket.disconnected) {
            logger.warn(client.socket.sessionid + " disconnected");
            continue;
        }

        // var random = Math.random();
        // 
        // if (random < 0.005)
        //     client.emit("chat", {text:"robot chat testing throughput"});
    }

}
