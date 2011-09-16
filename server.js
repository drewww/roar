var app = require('express').createServer()
    , io = require('socket.io').listen(app);
    
app.listen(8080);

app.get('/', function(req, res) {
    res.sendfile(__dirname + '/index.html');
});

io.sockets.on('connection', function(socket) {
    
    // Sets up all the per-connection events that we need to think about.
    // For now, this is just a response to chat messages.   
    socket.emit('chat.message', {message:"----Welcome to swarm!---------", from:"admin"});
    
    
    socket.on('chat.message', function(data) {
        // Mirror the message.
        io.sockets.emit('chat.message', {message:data.message, from:socket.name});
    });
    
    socket.on('chat.identity', function(data) {
        socket.name = data.name;
        io.sockets.emit('chat.message', {message: socket.name + " has entered.", from:"admin"});
    });
    
    socket.on('disconnect', function() {
       io.sockets.emit('chat.message', {message:"Someone has left.", from:"admin"});
    });
});

