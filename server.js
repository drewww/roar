var app = require('express').createServer(),
    io = require('socket.io').listen(app),
    redis = require('redis'),
    client = redis.createClient(),
    crypto = require('crypto');
        
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
        // If it's got an auth section, check it. If not, generate a new 
        // auth string and send it back.
        if("auth" in data && "id" in data) {
            // Check auth. Using the uid, see if it matches the auth key 
            // for that user.
            client.hgetall("users:" + data["id"], function (err, res) {
                if(res["auth"] == data["auth"]) {
                    // Good to go!
                    socket.emit("identify", {username:res["username"]});
                } else {
                    socket.emit("identify", {username:null});
                }
                
            });
            
            
            
        } else if("username" in data) {
            // At this point, the user is requesting this name. Generate
            // an auth string and send it down. 
            // This is really awful security practice, but doesn't matter
            // for this demo. 
            hash = crypto.createHash('sha1');
            hash.update(data["username"]);
            hash.update('' + Date.now());
            authString = hash.digest();
            
            // Now push this all into the database.
            client.incr("global:nextUserId", function (err, res) {
                
                client.hset("users:" + res, "auth", authString);
                client.hset("users:" + res, "username", data["username"]);
                
                socket.emit("identify", {"username":data["username"], "userId":res, "auth":authString});
            });
        } else {
            console.log("Malformed 'identify' message. Missing username and auth.");
        }
        
    })
    
    socket.on('chat.message', function(data) {
        // Mirror the message.
        messageDict = {message:data.message, from:socket.name, timestamp:Date.now()};
        
        io.sockets.emit('chat.message', messageDict);
        
        // By pushing and trimming, we keep it from growing indefinitely 
        client.rpush("room.messages", JSON.stringify(messageDict));
        client.ltrim("room.messages", 0, 100);
    });
    
    socket.on('chat.identity', function(data) {
        socket.name = data.name;

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
        
        
        // Send the last 10 messages.
    });
    
    socket.on('disconnect', function() {
        io.sockets.emit('admin.message', {message:socket.name + " has left.", from:"admin"});
    });
});


// Redis setup.
client.on("error", function(err) {
    console.log("ERR REDIS: " + err);
})


// We're going to need a list that's got recent chat messages in it so we
// can run analytics on it. Shouts are going to need to be a separate list
// 