var app = require('express').createServer(),
    io = require('socket.io').listen(app),
    redis = require('redis'),
    client = redis.createClient(),
    crypto = require('crypto');
    // process = require('process');
        
app.listen(8080);

app.get('/', function(req, res) {
    res.sendfile(__dirname + '/index.html');
});

// TODO Do some sort of blocking on accepting connections until the redis
// conneciton is actually alive.



io.sockets.on('connection', function(socket) {
    
    
    // Do some user welcoming stuff. 
    
    
    // Sets up all the per-connection events that we need to think about.
    // For now, this is just a response to chat messages.   
    socket.emit('admin.message', {message:"Welcome to roar!", from:"admin"});
    
    // Is the number of sockets really the number of people? I guess so.
    // socket.emit('admin.message', {message: io.sockets.length + " people chatting."});
    
    socket.on('identify', function(data) {
        
        
        // eventually check this against redis to see if the name is taken
        client.hexists("global:connectedUsers", data["username"], function (err, res) {
            if(res == 0) { 
                socket.emit("identify", {state:"OK", username:data["username"]});

                socket.name = data.username;
                
                // Eventually, put a pointer to the user id in here, or something.
                client.hset("global:connectedUsers", data["username"], true);

                socket.broadcast.emit('admin.message', {message: socket.name + " has entered.", from:"admin"});

                client.lrange("room.messages", -10, -1, function (err, res) {
                    console.log("lrange returned");
                    console.log(res);
                    for(msgIndex in res) {
                        console.log(res[msgIndex]);
                        msgObj = JSON.parse(res[msgIndex]);
                        msgObj["past"] = true;
                        socket.emit('chat.message', msgObj);
                    }

                    // Doing it here ensures that it appears after the past messages.
                    socket.emit('admin.message', {message: "You have joined the chat.", from:"admin"});
                });
            } else {
                socket.emit("identify", {state:"TAKEN", username:data["username"]});
            }
        });        
    });
    
    socket.on('chat.message', function(data) {
        // Mirror the message.
        messageDict = {message:data.message, from:socket.name, timestamp:Date.now()};
        
        io.sockets.emit('chat.message', messageDict);
        
        // By pushing and trimming, we keep it from growing indefinitely 
        client.rpush("room.messages", JSON.stringify(messageDict));
        client.ltrim("room.messages", 0, 100);
    });
    
    socket.on('disconnect', function() {
        // If they haven't registered a name yet, ignore them.
        if(socket.name != undefined) {
            io.sockets.emit('admin.message', {message:socket.name + " has left.", from:"admin"});
            client.hdel("global:connectedUsers", socket.name);
        }
    });
});

// Redis setup.
client.on("error", function(err) {
    console.log("ERR REDIS: " + err);
});

client.once("ready", function(err) {
    console.log("Connected to redis.");
    
    client.hgetall("global:connectedUsers", function(err, res) {
        for(key in res) {
            client.hdel("global:connectedUsers", key);
        }
    });
    
    console.log("Done cleaning up connected users list.");
})

// We're going to need a list that's got recent chat messages in it so we
// can run analytics on it. Shouts are going to need to be a separate list
// 