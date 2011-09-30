var app = require('express').createServer(),
    io = require('socket.io').listen(app),
    redis = require('redis'),
    client = redis.createClient(),
    crypto = require('crypto'),
    express = require('express');
    // process = require('process');
        
app.listen(8080);

app.get('/', function(req, res) {
    res.sendfile(__dirname + '/templates/index.html');
});

app.use(app.router);
app.use("/static", express.static(__dirname + '/static'));

// TODO Do some sort of blocking on accepting connections until the redis
// conneciton is actually alive.
io.sockets.on('connection', function(socket) {
    
    
    // Do some user welcoming stuff. 
    
    
    // Sets up all the per-connection events that we need to think about.
    // For now, this is just a response to chat messages.   
    
    socket.on('identify', function(data) {
        
        // Check and see if this socket already has a nick. If they do,
        // log it out and THEN add the new one in.
        socket.get("nickname", function(err, nickname) {
            
            var hasPrevNickname = nickname!=null;
            if(hasPrevNickname) {
                releaseNickname(socket);
            }
            
            // eventually check this against redis to see if the name is taken
            client.hexists("global:connectedUsers", data["username"], function (err, res) {
                
                // if this is true, then the hash doesn't contain that name
                // and it's free to be used.
                if(res == 0) { 
                    socket.set('nickname', data.username, function() {
                        
                        var isRename = false;
                        if(hasPrevNickname) isRename=true;

                        socket.emit("identify", {state:"OK",
                            username:data["username"], rename:isRename});

                        // Eventually, put a pointer to the user id in here, or something.
                        client.hset("global:connectedUsers", data["username"], true);

                        // Only send welcome messages if this is a logging-in
                        // user, not if they're just changing their nick.
                        if(!hasPrevNickname) {
                            // TODO Need to fix this in light of the room model.
                            // Either we're going to need to keep separate recent
                            // lists for every room, or going to ditch this
                            // feature.
                            // client.lrange("room.messages", -10, -1, function (err, res) {
                            //     console.log("lrange returned");
                            //     console.log(res);
                            //     for(msgIndex in res) {
                            //         console.log(res[msgIndex]);
                            //         msgObj = JSON.parse(res[msgIndex]);
                            //         msgObj["past"] = true;
                            //         socket.emit('message', msgObj);
                            //     }
                            // Doing it here ensures that it appears after the past messages.
                                socket.emit('message', {text:"Welcome to roar!", admin:"true"});
                            }
                            
                            // push an initial room state down.
                            _updateRooms(socket);
                        });
                } else {
                    socket.emit("identify", {state:"TAKEN", username:data["username"]});
                }
            });
        });
    });
        
    
    socket.on('message', function(data) {

        // Get the username.
        socket.get('nickname', function(err, nickname) {
            socket.get("room" ,function(err, roomName) {
                messageDict = {text:data.text, from:nickname,
                    timestamp:Date.now(), room:roomName};

                io.sockets.in(roomName).emit('message', messageDict);

                // By pushing and trimming, we keep it from growing indefinitely 
                client.rpush("room.messages", JSON.stringify(messageDict));
                client.ltrim("room.messages", -100, -1);
            });
        });
    });
    
    // Handle change room commands.
    socket.on('room', function(data) {
        // Messages will be of the form: {"name":"room_name"}.
        var newRoomName = data["name"];

        leaveRoom(socket, newRoomName);
        
        socket.set("room", newRoomName, function() {
            
            var population;
            client.hexists("global:rooms", newRoomName, function (err, exists) {
                if(exists) {
                    // If we already know about this room, get the id and 
                    // then increment the count.
                    client.hget("global:rooms", newRoomName, function(err, roomId) {
                        client.hincrby("rooms:" + roomId, "population", 1,
                            function(err, population) {
                                socket.emit('message', {text:
                                    "You have joined room '"+newRoomName+
                                    "' with " + population +
                                    " total people.", admin:"true"});
                            });
                    });
                    
                } else {
                    // otherwise, make a new hash for this room's info.
                    client.incr("global:nextRoomId", function (err, roomId) {
                        // Add an entry in the global rooms hash mapping the
                        // room name to its id.
                        client.hset("global:rooms", newRoomName, roomId);
                        
                        // Add a hash for the specific room id with room
                        // metadata.
                        client.hset("rooms:" + roomId, "name",newRoomName);
                        client.hset("rooms:" + roomId, "population",1);
                        
                        socket.emit('message', {text:
                            "You have joined room '"+newRoomName+
                            "' with 1 total person.", admin:"true"});
                        
                    });
                }
                
                socket.get("nickname", function(err, nickname) {
                    // Kinda wanted to say where they came from here, but
                    // that turns out to be a little tedious with the callback
                    // structure. Figure out some way to cache that to make it
                    // accessible?
                    io.sockets.in(newRoomName).emit("message",
                    {text:nickname + " has arrived.",
                    admin:"true"});
                });
                
                // doing this after the arrival broadcast message means
                // it doens't go to that user, which is nice. We have separate
                // arrival messages for them.
                socket.join(newRoomName);
            });
        });
        
    });
    
    socket.on('disconnect', function() {
        leaveRoom(socket, null);
        releaseNickname(socket);
    });
});

// Redis setup.
client.on("error", function(err) {
    console.log("ERR REDIS: " + err);
});


// Clean up some stateful variables that need to be empty on start.
// Ideally, it'd be nice if this stuff could persist some but it seems
// risky to me, so I don't really do it at all yet. Also, I'd like to
// do this on shutdown, but I haven't found a way to capture that event
// yet. 
client.once("ready", function(err) {
    client.hgetall("global:connectedUsers", function(err, res) {
        for(key in res) {
            client.hdel("global:connectedUsers", key);
        }
    });
    
    client.hgetall("global:rooms", function(err, res) {
        for(key in res) {
            client.hdel("global:rooms", key);
            client.del("rooms:" + res[key]);
        }
    })
    
    // Start the periodic data worker threads.
    setTimeout(function() {
        _processPulse();
        _updateRooms(null);
    }, 5000);

});

function releaseNickname(socket) {
    socket.get("nickname", function(err, nickname) {
        client.hdel("global:connectedUsers", nickname);
    });
}

function leaveRoom(socket, newRoomName) {
    // See if this socket is in a room already.
    socket.get("room", function(err, roomName) {
        if(roomName!=null) {
            // We need to leave that room first.
            // 1. Unsubscribe the socket.
            // 2. Decrement the population count.
            // 3. Potentially delete the channel if there's no one left.
            socket.leave(roomName);
            
            socket.emit('message', {text:
                "You have left room '"+roomName+"'.", admin:"true"});
            
            socket.get("nickname", function(err, nickname) {
                if(newRoomName == null) {
                    io.sockets.in(roomName).emit("message",
                    {text:nickname + " has logged off.",
                    admin:"true"});
                } else {
                    io.sockets.in(roomName).emit("message",
                    {text:nickname + " has moved to " + newRoomName + ".",
                    admin:"true"});
                }
            });
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
}

// Send an update with summary information about the current roomlist
// to populate client side room autocomplete information. 
function _updateRooms(socket) {
    // For each room we want to include the room name and the number
    // of people in each room. This is all stored in redis, so we can
    // just dump the contents of global:rooms and format it into one
    // big JSON message to distribute.
    
    // if there's a socket passed in, it's a request to do a one-shot
    // update.
    if(socket==null) setTimeout(_updateRooms, 5000);
    
    client.hgetall("global:rooms", function(err, res) {
        var allRoomData = [];
        for(var roomName in res) {
            var roomPop = res[roomName];
            allRoomData.push({"name":roomName, "population":roomPop});
        }

        // Now broadcast this message to all clients.
        if(socket==null) io.sockets.emit("rooms", allRoomData);
        else socket.emit("rooms", allRoomData);
    });
}

function _processPulse() {
    
    setTimeout(_processPulse, 5000);
    
    // In each loop, grab the whole message history (in room.messages) and
    // generate a new pulse command.
    
    // The first phase is to measure relative volume. We do this by figuring
    // out the messages/second across the entire data set. Then we look only
    // at the last 5 seconds.
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
