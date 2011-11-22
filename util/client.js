var program = require('commander')
  , client = require('socket.io-client')
  , async = require('async')
  , logger = require('winston')
;

logger.cli();
logger.default.transports.console.timestamp = true;

var verbose = false;


function connect(url, connections, callback) {
  console.log('Connect to %s (%d connections)', url, connections);
  var clients = []
    , inits = [];

  for (var i = 0; i < connections; ++i) {
    inits.push(function(next) {
      var con = client.connect(url, { 'force new connection': true });
      con.on('connect', function() {
        logger.debug('connected sessionid=' + con.socket.sessionid);
        clients.push(con);
        con.emit("identify", {username:"user-" + (Math.random()*Date.now()).toFixed(0).substring(0, 6)});
        });
    
    con.on('message', function(data) {
        if(data["text"] == "MARCO") {
            con.emit("message", {text:"POLO"});
        }
        });
    
    con.on("identify", function(data) {
        // ignore the response, just blind join a room for now.
        con.emit("room", {"name":"General Chat 1"});
        
        next();
    });
    });
  }

  async.parallel(inits, function(err) {
      if (err) {
        console.log(err);
        process.exit(1);
      }
      console.log('conection setup completed');
      callback(clients);
    }
  );
}

function disconnect(clients) {
  for (var i = 0, l = clients.length; i < l; ++i) {
    var c = clients[i];
    logger.debug('disconnect sessionid=' + c.socket.sessionid);
    c.disconnect();
  }
}

connect("http://localhost:8080/", 1000, function(clients) {
    logger.debug("all clients connected!");
});