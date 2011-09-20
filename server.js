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
        
        if(true) { 
            socket.emit("identify", {state:"OK", username:data["username"]});
            
            socket.name = data.username;    
            
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
            socket.emit("identify", {state:"TAKEN"})
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
    
    // socket.on('chat.identity', function(data) {
    //     
    //     // this will check to see if it's free or not, eventually)
    //     if(true) 
    //     
    //     
    //     
    //     socket.name = data.name;
    // 
    //     socket.broadcast.emit('admin.message', {message: socket.name + " has entered.", from:"admin"});
    //     
    //     client.lrange("room.messages", -10, -1, function (err, res) {
    //         console.log("lrange returned");
    //         console.log(res);
    //         for(msgIndex in res) {
    //             console.log(res[msgIndex]);
    //             msgObj = JSON.parse(res[msgIndex]);
    //             msgObj["past"] = true;
    //             socket.emit('chat.message', msgObj);
    //         }
    //         
    //         // Doing it here ensures that it appears after the past messages.
    //         socket.emit('admin.message', {message: "You have joined the chat.", from:"admin"});
    //     });
    //     
    //     
    //     // Send the last 10 messages.
    // });
    
    socket.on('disconnect', function() {
        io.sockets.emit('admin.message', {message:socket.name + " has left.", from:"admin"});
    });
});

// Redis setup.
client.on("error", function(err) {
    console.log("ERR REDIS: " + err);
});

// We're going to need a list that's got recent chat messages in it so we
// can run analytics on it. Shouts are going to need to be a separate list
// 