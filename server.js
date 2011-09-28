var app = require('express').createServer(),
    io = require('socket.io').listen(app),
    redis = require('redis'),
    client = redis.createClient(),
    crypto = require('crypto');
    // process = require('process');
        
app.listen(8080);

app.get('/', function(req, res) {
    res.sendfile(__dirname + '/templates/index.html');
});

app.get('/static/:file', function(req, res) {
    res.sendfile(__dirname + '/static/' + req.params.file);
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
                
                socket.set('nickname', data.username, function() {
                    socket.emit("identify", {state:"OK", username:data["username"]});
                
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
                        socket.emit('message', msgObj);
                    }

                    // Doing it here ensures that it appears after the past messages.
                    socket.emit('admin.message', {message: "You have joined the chat.", from:"admin"});
                });
            });
                
            } else {
                socket.emit("identify", {state:"TAKEN", username:data["username"]});
            }
        });        
    });
    
    socket.on('message', function(data) {

        // Get the username.
        socket.get('nickname', function(err, nickname) {
            messageDict = {text:data.text, from:nickname, timestamp:Date.now()};

            io.sockets.emit('message', messageDict);

            // By pushing and trimming, we keep it from growing indefinitely 
            client.rpush("room.messages", JSON.stringify(messageDict));
            client.ltrim("room.messages", -100, -1);
        });
    });
    
    // Handle change room commands.
    socket.on('room', function(data) {
        // Messages will be of the form: {"name":"room_name"}.
        
        // See if this socket is in a room already.
        socket.get("room", function(err, roomName) {
            if(roomName!=null) {
                // We need to leave that room first.
                // 1. Unsubscribe the socket.
                // 2. Decrement the population count.
                // 3. Potentially delete the channel if there's no one left.
                socket.leave(roomName);
                
                client.hget("global:rooms", roomName, function (err, roomId) {
                    
                    client.hincrby("rooms:" + roomId, "population", -1,
                        function (err, newPopulation) {
                            if(newPopulation==0) {
                                
                                // Remove the room records.
                                client.hdel("global:rooms", roomName);
                                client.del("rooms:" + roomId);
                            }
                        });
                });
            }
        });
        
        var roomName = data["name"];
        socket.set("room", roomName, function() {
            socket.join(roomName);
           
            // TODO send a room-change message.
            
            client.hexists("global:rooms", roomName, function (err, exists) {
                if(exists) {
                    // If we already know about this room, get the id and 
                    // then increment the count.
                    client.hget("global:rooms", roomName, function(err, roomId) {
                        client.hincrby("rooms:" + roomId, "population", 1);
                    })
                    
                } else {
                    // otherwise, make a new hash for this room's info.
                    client.incr("global:nextRoomId", function (err, roomId) {
                        // Add an entry in the global rooms hash mapping the
                        // room name to its id.
                        client.hset("global:rooms", roomName, roomId);
                        
                        // Add a hash for the specific room id with room
                        // metadata.
                        client.hset("rooms:" + roomId, "name",roomName);
                        client.hset("rooms:" + roomId, "population",1);
                    });
                }
            });
        });
        
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
    client.hgetall("global:connectedUsers", function(err, res) {
        for(key in res) {
            client.hdel("global:connectedUsers", key);
        }
    });
    
    // Start the periodic data worker threads.
    setTimeout(_processPulse, 5000);
});


function _processPulse() {
    // In each loop, grab the whole message history (in room.messages) and
    // generate a new pulse command.
    
    // The first phase is to measure relative volume. We do this by figuring
    // out the messages/second across the entire data set. Then we look only
    // at the last 5 seconds.
    setTimeout(_processPulse, 5000);

    
    client.lrange("room.messages", 0, -1, function (err, res) {
        
        var totalMessages = 0;
        var messagesInWindow = 0;
        
        var startTime = Date.now();
        
        var popularWordsInWindow = {};
        
        // data contains all the messages in the room queue.
        for(msgKey in res) {
            var msg = JSON.parse(res[msgKey]);

            // exclude messages that are older than ten minutes. This helps
            // with cases where the server has been running for a while
            // and chat stops, then restarts much later.
            if(Date.now() - msg["timestamp"] > 60*10*1000) continue;

            totalMessages = totalMessages+1;
            
            // This will find the earliest item in the group. I think it's
            // guaranteed to be the first, but whatever. Be safe.
            if(msg["timestamp"] < startTime) startTime = msg["timestamp"];
            
            if(Date.now() - msg["timestamp"] < 10000) {
                // The message is in our window.
                messagesInWindow = messagesInWindow + 1;
                
                wordsInMessage = msg["text"].split(/[\s,.!?]+/);
                
                // For each word in the message 
                for(var wordIndex in wordsInMessage) {
                    var word = wordsInMessage[wordIndex];
                    
                    
                    isStopWord = word in stopWords;
                    isTooShort = word.length==1;
                    if (isStopWord || isTooShort)  {
                        console.log("skipping word: " + word);
                        continue;
                    }
                    
                    if(word in popularWordsInWindow) {
                        popularWordsInWindow[word] = popularWordsInWindow[word] + 1;
                    } else {
                        popularWordsInWindow[word] = 1;
                    }
                }
            }
        }


        var popularWordsList = [];
        for(var word in popularWordsInWindow) {
            var wordScore = popularWordsInWindow[word];
            
            
            // Knock out words that are mentioned once, just for cleaner
            // data.
            if(wordScore > 1) {
                popularWordsList.push({"word":word, "score":wordScore/20});
            }
        }
        
        // Now sort the list by word score, so it's frequency sorted.
        popularWordsList.sort(function(a, b) {
            return a["score"] - b["score"];
        });
        popularWordsList.reverse();
        
        // In a later pass, we'll use this to decide how many words to 
        // send total.
        var totalActivity = (totalMessages / (Date.now() - startTime)) * 1000;
        var windowActivity = messagesInWindow / 5;
        var relativeActivity = windowActivity / totalActivity;
        
        // Hardcoding this for now. Eventually we want to include more words
        // when it's louder, and fewer words when it's quiet. 
        dict = popularWordsList.slice(0, 5);
        
        // dict = {"total":totalActivity, "inWindow":windowActivity, "relative":relativeActivity, "word":topWord, "word-score":bestScore};
        // console.log(dict);
        io.sockets.emit('pulse', dict);
        
    });
}

var stopWords = ["a","about","above","after","again","against","all","am","an"
,"and","any","are","aren't","as","at","be","because","been","before","being",
"below","between","both","but","by","can't","cannot","could","couldn't","did",
"didn't","do","does","doesn't","doing","don't","down","during","each","few",
"for","from","further","had","hadn't","has","hasn't","have","haven't",
"having","he","he'd","he'll","he's","her","here","here's","hers","herself",
"him","himself","his","how","how's","i","i'd","i'll","i'm","i've","if","in",
"into","is","isn't","it","it's","its","itself","let's","me","more","most",
"mustn't","my","myself","no","nor","not","of","off","on","once","only","or",
"other","ought","our","ours"," ourselves","out","over","own","same","shan't",
"she","she'd","she'll","she's","should","shouldn't","so","some","such","than",
"that","that's","the","their","theirs","them","themselves","then","there",
"there's","these","they","they'd","they'll","they're","they've","this",
"those","through","to","too","under","until","up","very","was","wasn't","we",
"we'd","we'll","we're","we've","were","weren't","what","what's","when",
"when's","where","where's","which","while","who","who's","whom","why","why's",
"with","won't","would","wouldn't","you","you'd","you'll","you're","you've",
"your","yours","yourself","yourselves"];
