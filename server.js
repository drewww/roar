var app = require('express').createServer()
    , io = require('socket.io').listen(app);
    
app.listen(8080);

app.get('/', function(req, res) {
    console.log("Request: " + req);
    
    res.sendfile(__dirname + '/index.html');
});

io.sockets.on('connection', function(socket) {
    console.log("Connection on socket: " + socket.id);
    socket.emit('chat-message', {message:"Welcome to swarm!"});
    socket.on('chat-message', function(data) {
        console.log(data);
    })
});