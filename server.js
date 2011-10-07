var app = require('express').createServer(),
    io = require('socket.io').listen(app),
    redis = require('redis'),
    client = redis.createClient(),
    crypto = require('crypto'),
    express = require('express'),
    fs = require('fs'),
    program = require('commander'),
    sets = require('simplesets');
    // process = require('process');
    

program.version('0.2')
    .option('-V, --verbose', 'Enable verbose logging.')
    .option('-p, --port [num]', 'Set the server port (default 8080)')
    .option('-b, --bots [num]', 'Creates [num] server-side chat bots.')
    .option('-m, --model [filename]', "Specifies a specific chat model to load for bots. No effect without -b.")
    .parse(process.argv);
    

var server = "localhost";
if(program.args.length==1) {
    server = program.args[0];
} else if(program.args.length==0) {
    console.log("Defaulting to 'localhost' for server.");
} else {
    console.log("Too many command line arguments. Expected 0 or 1.")
}
var port = 8080;
if(program.port) {
    console.log("Setting port to " + program.port);
    port = program.port;
}

io.set("log level", 2);
if(program.verbose) {
    io.set("log level", 3);
}

var modelFilename = __dirname + "/chat_model.json";
if(program.model) {
    modelFilename = program.model;
}

var model = null;
if(program.bots) {
    // Load in the model file. When it's done, kick off bot setup callbacks.
    fs.readFile(modelFilename, 'utf-8', function (err, data) {
        model = JSON.parse(data);
        console.log("Loaded model: " + modelFilename);
        
        setupBots(program.bots);
    });
}


app.listen(port);

app.get('/', function(req, res) {
    res.render('index.ejs', {layout:false, locals:{"server":server,
        "port":port}});
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
                            // client.lrange("messages.recent", -10, -1, function (err, res) {
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
        // setup some internal commands so I can easily manipulate state
        // from messages.
        if(data.text[0]=="/") {
            
            var args = data.text.split(" ");
            var command = args[0];
            args = args.slice(1);
            command = command.slice(1);
            
            switch(command) {
                case "level":
                    if(args[0]=="vary") {
                        varyBotParticipation = true;
                        return;
                    } else {
                        varyBotParticipation = false;
                    }
                
                    // Look at the next number.
                    // Scale it 0-100 -> BASE_CHAT_ODDS -> -BASE_CHAT_ODDS
                    botChatOddsOffset = (1-(parseInt(args[0])/100))* 2 * BASE_CHAT_ODDS
                        - BASE_CHAT_ODDS;
                    break;
                    
                case "spike":
                    spikeProgress=0;
                    break;
                default:
                    sendAdminMessage(socket,
                            "Unknown command '" + command + "'.");
                    break;
            }
            
            return;
        }
        
        // Get the username.
        socket.get('nickname', function(err, nickname) {
            socket.get("room" ,function(err, roomName) {
                sendChatToRoom(roomName, nickname, data.text);
            });
        });
    });
    
    // Handle change room commands.
    socket.on('room', function(data) {
        // Messages will be of the form: {"name":"room_name"}.
        var newRoomName = data["name"];

        socket.get("room", function (err, oldRoomName) {
            leaveRoom(socket, oldRoomName);
            
            socket.set("room", newRoomName, function() {
                joinRoom(socket, newRoomName);
            });
        });
    });
    
    
    socket.on('shout', function (data) {
        // {text:(shout_text)}
        
        // create the shout datastructure
        client.incr("global:nextShoutId", function (err, shoutId) {
            
            var shoutKey = "shout:" + shoutId;
            var shoutInfo = {};
            
            client.hset(shoutKey, "id", shoutId);
            client.hset(shoutKey, "text", data["text"]);
            client.hset(shoutKey, "timestamp", Date.now());
            
            // Set expiration five seconds out - that'll give the 
            client.hset(shoutKey, "votes", 0);
            client.hset(shoutKey, "room-votes", "{}");
            socket.get("nickname", function(err, nickname) {
                client.hset(shoutKey, "from", nickname, function(err, res) {
                    
                    // Now that the whole datastructure is saved, push it to
                    // the room.
                    
                    // 1. Update the datastructure to show how many votes it
                    //    has from each room.
                    // 2. Send the message to people in that room about the
                    //    shout.
                    voteForShout(socket, shoutId, function() {
                        socket.get("room", function(err, room) {
                            spreadShoutToRoom(room, shoutId);
                        });
                    });
                    
                });
            });
        });
    });
    
    socket.on('shout.vote', function (data) {
        // {shout_id:(id)}
        voteForShout(socket, data["shout_id"], null);
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
        }
    });
    
    client.hgetall("global:room_populations", function(err, res) {
        for(key in res) {
            client.hdel("global:room_populations", key);
        }
    });
    
    // Start the periodic data worker threads.
    // TODO split this into separate settimeouts to stagger them to avoid
    // them all running at the same time and competing?
    setTimeout(function() {
        _processPulse();
        _updateRooms(null);
        _checkShoutExpiration();
        _chatBotTick();
    }, 0);

});


function broadcastAdminMessage(room, message) {
    if(room==null || typeof room == 'undefined') {
        // broadcast to EVERYONE.
        io.sockets.emit('message', {text:message, admin:"true"});
    } else {
        io.sockets.in(room).emit('message', {text:message, admin:"true"});
    }
}

function sendAdminMessage(socket, message) {
    socket.emit('message', {text:message, admin:"true"});
}

function sendChatToRoom(roomName, nickname, messageText) {
    messageDict = {text:messageText, from:nickname,
        timestamp:Date.now(), room:roomName};

    io.sockets.in(roomName).emit('message', messageDict);

    // By pushing and trimming, we keep it from growing indefinitely 
    // We don't need to trim; pulse will trim for us, to avoid having to
    // push more data around than is strictly necessary.
    client.rpush("messages.recent", JSON.stringify(messageDict));
    // client.ltrim("messages.recent", -5000, -1);
}

function spreadShoutToRoom(room, shoutId) {
    // now spread the shout
    var shoutKey = "shout:" + shoutId;
    client.hgetall(shoutKey, function(err, res) {
        // Feels silly to bounce off redis like this,
        // but whatever.
        io.sockets.in(room).emit("shout", res);
        
        // Join everyone in that room to future shout notifications.
        //// This little dance is a way to get at the actual sockets in a
        //// given room to do something with them. Kinda want to abstract
        //// this into some kind of syntactic sugar, but not sure how exactly.
        var socketsInRoom = io.sockets.in(room).sockets;
        for(socketId in socketsInRoom) {
            var socket = socketsInRoom[socketId];
            socket.join("shout:" + shoutId);
        }
        
        // Manage the timeouts. If no expiration is set, set it to now+1 min.
        // If a timeout is set (and we're expanding to a new room), give the
        // shout another minute of life.
        client.hget(shoutKey, "expiration", function (err, res) {
           if(res==null) {
               client.hset(shoutKey, "expiration", Date.now() + 60000);
           } else {
               client.hincrby(shoutKey, "expiration", 60000);
           }
        });
    });
}

function voteForShout(socket, shoutId, callback) {
    var shoutKey = "shout:" + shoutId;
    
    // TODO Need to make sure asking for invalid shouts doesn't bring the
    // house down.
    // TODO if we're worried about memory at some point, clean out this
    // socket attribute. Could do it on-vote sometimes - check against a list
    // of current valid shouts. For now, though, it's NBD.
    socket.get("votes", function(err, votes) {
        var votesList = JSON.parse(votes);

        // If this socket hasn't voted for anything yet, init it.
        if( votesList == null) votesList = [];
        
        // Figure out if the shoutId they're trying to vote for is in this
        // list.
        var inVotesList = false;
        for(var voteIndex in votesList) {
            if (shoutId+"" ===votesList[voteIndex]) {
                inVotesList = true;
                break;
            }
        }
        
        if(inVotesList) {
            sendAdminMessage(socket, "You've already voted for that shout");
        } else {
            // Allow the vote.
            socket.get("room", function(err, room) {
                writeShoutFromRoom(room, shoutId, callback);
                
                // Mark this socket as having voted.
                votesList.push(shoutId +"");
                socket.set("votes", JSON.stringify(votesList));
                
            });
        }
    });
}

function writeShoutFromRoom(room, shoutId, callback) {
    
    var shoutKey = "shout:" + shoutId;
    
    client.hget(shoutKey, "room-votes", function(err, res) {
        var roomVotes = JSON.parse(res);

        var roomVoteCount = 0;
        if(room in roomVotes) {
            roomVoteCount = roomVotes[room];
        }

        roomVotes[room] = roomVoteCount+1;

        client.hset(shoutKey, "room-votes",
            JSON.stringify(roomVotes));

        // boost the total vote count by 1.
        client.hincrby(shoutKey, "votes", 1,
            function (err, curVoteCount){
                // notify everyone listening to that shout of the vote.

                // don't need to send this if this is the first vote.
            if(curVoteCount > 1) {
                io.sockets.in(shoutKey).emit("shout.vote",
                    {"id":shoutId, "votes":curVoteCount});
            }

            // Do the callback.
            setTimeout(function() {
                // Check for shout promotion here. The question is, have more 
                // than half the people in the room it was just voted for in
                // vote for it. If they did, spread it. 
                
                client.hget("global:room_populations", room,
                    function(err, pop) {
                        console.log("checking shout promotion: " + roomVotes[room] + " > " + (pop/4) + "?");
                        if(roomVotes[room] > (pop/4)) {
                            console.log("promoting shout!");
                            
                            // flip the bit on room votes that says don't use
                            // this room to cause a promotion anymore.
                            // (DO THIS NEXT)
                            
                            client.hkeys("global:room_populations",
                                function(err, roomNames) {
                                    var roomNameSet = new sets.Set(roomNames);
                                    for(roomName in roomVotes) {
                                        roomNameSet.remove(roomName);
                                    }
                                    
                                    if(roomNameSet.size==0) {
                                        console.log("Shout has reached max promotion.");
                                        // TODO tell the client who shouted
                                        // that it's maxxed out.
                                    }
                                    
                                    // now roomNameSet has all the rooms that
                                    // haven't seen this shout yet. roll the
                                    // dice and expand to two of them.
                                    // (this is not quite a fair search, but
                                    // since we're going to take two adjacent
                                    // rooms, it'll do for now.)
                                    var index = Math.floor(Math.random()* 
                                        roomNameSet.size()-1.0000001);
                                    
                                    console.log("spreading to new rooms: " +
                                        roomNameSet.array()[index] + " and " +
                                        roomNameSet.array()[index+1]);
                                    
                                    // Spread to two adjacent rooms in the
                                    // list.
                                    spreadShoutToRoom(
                                        roomNameSet.array()[index], shoutId);
                                    spreadShoutToRoom(
                                        roomNameSet.array()[index+1],
                                        shoutId);
                                })
                            

                            
                        }
                });
                
                
                if(callback!=null&&typeof callback != 'undefined') callback();
            }, 0);
        });
    });
}

function releaseNickname(socket) {
    socket.get("nickname", function(err, nickname) {
        client.hdel("global:connectedUsers", nickname);
    });
}

function joinRoom(socket, newRoomName) {
    var population;
        

    client.hincrby("global:room_populations", newRoomName, 1,
        function(err, roomPopulation) {
        // start by incrementing the value. If the resulting value is 1, we need
        // to do the create-new-room-structure code. Otherwise, update using
        // this proper population number.
        if (roomPopulation == 1) {
            // create the room in the other data structure.
            client.incr("global:nextRoomId",
            function(err, roomId) {

                var room = {};
                room["id"] = roomId;
                room["name"] = newRoomName;
                
                client.hget("global:room_populations", newRoomName,
                    function(err, population) {
                        room["population"] = population;
                        
                        client.hset("global:rooms", newRoomName, JSON.stringify(room));
                        if (socket) {
                            sendAdminMessage(socket,
                                "You have joined room '" + newRoomName +
                                "' with "+population+" total person.");
                        }
                });
            });
        } else {
            client.hget("global:rooms", newRoomName,
                function(err, roomData) {
                    if (roomData != null) {
                        var room = JSON.parse(roomData);

                        // other option is to run a separate query to get the
                        // current population from global:room_populations at
                        // this point.
                        client.hget("global:room_populations", newRoomName,
                            function(err, population) {
                                room["population"] = population;

                                client.hset("global:rooms", newRoomName,
                                    JSON.stringify(room),
                                    function(err, res) {
                                        if (socket) sendAdminMessage(socket, 
                                            "You have joined room '" + newRoomName +
                                            "' with " + room["population"] +
                                            " total people.");
                                });
                            });
                    }
                });
            }
        
        if(socket) socket.get("nickname", function(err, nickname) {
            // Kinda wanted to say where they came from here, but
            // that turns out to be a little tedious with the callback
            // structure. Figure out some way to cache that to make it
            // accessible?
            broadcastAdminMessage(newRoomName, nickname + " has arrived.");
        });

        // doing this after the arrival broadcast message means
        // it doens't go to that user, which is nice. We have separate
        // arrival messages for them.
        if(socket) socket.join(newRoomName);
        
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

            client.hget("global:rooms", roomName, function(err, roomData) {
                var room = JSON.parse(roomData);
                
                room["population"] = room["population"] - 1;
                
                // decrement the other counter, too.
                client.hincrby("global:room_populations", roomName, -1,
                    function(err, population) {
                        if(population==0) {
                            client.hdel("global:rooms", roomName);
                        } else {
                            client.hset("global:rooms", roomName,
                                JSON.stringify(room));
                        }
                    });
            });
        }
    });
}

function _checkShoutExpiration() {
    
    setTimeout(_checkShoutExpiration, 5000);
    // Loop through each of the shout keys. See if they've passed their 
    // expiration. If they have, send a message on that shout channel to 
    // expire that shout. Remove all its associated keys + info + transition
    // the data to a backup queue.
    client.keys("shout:*", function (err, res) {
        for(var index in res) {
            var shoutKey = res[index];
            
            client.hget(shoutKey, "expiration", function(err, expirationDate){
                if(Date.now() > expirationDate) {
                    // Do the expiration process:
                    // 1. notify clients
                    // 2. copy record of shout to shout history
                    // 3. delete original keys
                    // 4. remove all sockets listening to that shout
                    var shoutId = shoutKey.split(":")[1];
                    io.sockets.in(shoutKey).emit("shout.expire",
                        {"id":shoutId});
                    
                    client.hgetall(shoutKey, function(err, shoutData) {
                        client.rpush("global:shouts",
                            JSON.stringify(shoutData), function (err, res) {
                                client.del(shoutKey);
                                
                                // Keeps max shout history at 100 to avoid
                                // accumulating infinite data.
                                client.ltrim("global:shouts", -100, -1);
                            });
                    });
                    
                    // Remove the sockets listening to that shout.
                    // Probably not strictly necessary but keeps the socket.io
                    // datastructures clean from stuff that we're not using
                    // at all.
                    var subscribedSockets = io.sockets.in(shoutKey).sockets;
                    for(var index in subscribedSockets) {
                        var socket = subscribedSockets[index];
                        socket.leave(shoutKey);
                    }
                }
            });
        }
    });
}

// TODO Switch this to an on-demand sort of thing to save on bandwidth. Also,
// think about heavily caching the room list in a dedicated key at some point.
// Send an update with summary information about the current roomlist
// to populate client side room autocomplete information. 
function _updateRooms(socket) {
    // For each room we want to include the room name and the number
    // of people in each room. This is all stored in redis, so we can
    // just dump the contents of global:rooms and format it into one
    // big JSON message to distribute.
    
    // if there's a socket passed in, it's a request to do a one-shot
    // update.
    if(socket==null || typeof socket == 'undefined') setTimeout(_updateRooms, 5000);
    
    client.hgetall("global:rooms", function(err, res) {
        var allRoomData = [];
        for(var roomName in res) {
            var room = JSON.parse(res[roomName]);
            allRoomData.push({"name":roomName, "population":room["population"]});
        }

        // sort the rooms by population
        allRoomData.sort(function(a, b) {
            return a["population"] - b["population"];
        });
        allRoomData.reverse();

        // Now broadcast this message to all clients.
        if(socket==null  || typeof socket == 'undefined') {
            io.sockets.emit("rooms", allRoomData);
        } else socket.emit("rooms", allRoomData);
    });
}

var lastDocumentProcessed = Date.now();
var WINDOW_SIZE = 10;

function _processPulse() {
    
    setTimeout(_processPulse, 2000);
    
    // In each loop, grab the whole message history (in recent_messages) and
    // generate a new pulse command.
    
    // The first phase is to measure relative volume. We do this by figuring
    // out the messages/second across the entire data set. Then we look only
    // at the last 5 seconds.
    client.lrange("messages.recent", 0, -1, function (err, res) {
        var messagesInWindow = 0;
        
        var popularWordsInWindow = {};
        
        // data contains all the messages in the room queue.
        var foundFirstMessageInWindow = false;
        for(msgKey in res) {
            var msg = JSON.parse(res[msgKey]);


            // exclude messages that are older than ten minutes. This helps
            // with cases where the server has been running for a while
            // and chat stops, then restarts much later.
            if(Date.now() - msg["timestamp"] > 60*10*1000) continue;
            
            if(Date.now() - msg["timestamp"] < WINDOW_SIZE*1000) {
                
                if(!foundFirstMessageInWindow) {
                    foundFirstMessageInWindow = true;
                    
                    // trim any messages before this one. but for now, just
                    // write it out to make sure this'll work.
                    client.ltrim("messages.recent", msgKey, -1);
                }
                
                // The message is in our window.
                messagesInWindow = messagesInWindow + 1;
                
                wordsInMessage = msg["text"].split(/[\s]+/);
                
                // For each word in the message 
                for(var wordIndex in wordsInMessage) {
                    var word = wordsInMessage[wordIndex];
                    
                    isStopWord = word in stopWords;
                    isTooShort = word.length==1;
                    isTooLong = word.length>15;
                    isURL = word.search(/http/i)!=-1;
                    if (isStopWord || isTooShort || isTooLong || isURL)  {
                        continue;
                    }
                    
                    // now strip out stuff that would make the word hard to
                    // compare
                    word = word.toLowerCase();
                    word = word.replace(/[\(\)!?,.\"\'\*;]/g, "");
                    word = word.replace(/\/\//g, "");
                    if(word == "") continue;
                    
                    if(word[word.length-1]==":") word=word.slice(0, -1);
                    
                    if(word in popularWordsInWindow) {
                        popularWordsInWindow[word] = popularWordsInWindow[word] + 1;
                    } else {
                        popularWordsInWindow[word] = 1;
                    }
                }
            }
        }
        
        // if it's been a full windowsize worth of chat since we
        // last produced a document, do it now.
        if(Date.now()-lastDocumentProcessed > WINDOW_SIZE*1000) {
            lastDocumentProcessed = Date.now();
            // the keys in popularWordsInWindow are naturally a set
            // beacuse of the way we construct them. So we can just save
            // the keys and that will be our set for IDF measurement.
            var documentWords = [];
            for(word in popularWordsInWindow) {
                documentWords.push(word);
                
                // increment the document frequency hash
                client.hincrby("messages.doc_freq", word, 1);
            }
            var documentMetadata = {"timestamp":Date.now(),
                "words":documentWords, "total-messages":messagesInWindow};
            
            client.incrby("messages.total",
                documentMetadata["total-messages"]);
            
            // tradeoff here is that larger document count is clearly better
            // data, but if we have to grab it out of redis every pulse,
            // is that really expensive?
            client.rpush("messages.summary", JSON.stringify(documentMetadata));

            // Limit the length of the history we maintain, and keep the
            // doc_freq value up to date as we expire old documents.
            client.llen("messages.summary", function(err, length) {
                if(length > 1000) {
                    var numPops = length - 1000;
                    
                    for(var i=0; i<numPops; i++) {
                        // pop summaries off and reverse them from
                        // the DF count.
                        client.lpop("messages.summary",function(err, summary){
                            summary = JSON.parse(summary);
                            
                            // for each key in summary, decrement the DF by
                            // 1.
                            for(var wordIndex in summary["words"]) {
                                var word = summary["words"][wordIndex];
                                client.hincrby("messages.doc_freq", word, -1);
                            }
                            
                            client.incrby("messages.total", -1*summary["total-messages"]);
                        });
                    }
                }
            });
        }
        
        // This is NOT going to include the one that we just pushed in, in all
        // likelyhood. That's not necessarily that big a deal. Or any super
        // recent updates to messages.doc_freq if we actually did pop
        // documents off. 
        client.hgetall("messages.doc_freq", function(err, docFreq) {
            client.llen("messages.summary", function(err, numDocs) {
                client.get("messages.total", function(err, totalMessages) {
                    client.lrange("messages.summary",0,0,
                        function(err, oldestWindow) {

                        // there's a race condition on first document process
                        // where even though we've just saved it, the saves
                        // haven't gone through by the time we're fetching here
                        // so we need to use reasonable default values.
                        
                        var startTime;
                        
                        if(totalMessages == null) totalMessages = 0;
                        if(docFreq == null) docFreq = {};
                        if(numDocs == null) numDocs = 1;
                        
                        if(typeof oldestWindow[0] == 'undefined' ||
                            oldestWindow[0].length < 10) {
                            startTime = Date.now();
                        } else {
                            oldestWindow = JSON.parse(oldestWindow[0]);
                            startTime = oldestWindow["timestamp"];
                        }

                        // we have all the tools we need: popularWordsInWindow is
                        // TF, and the DF terms are in docFreq + numDocs. So,
                        // for each word in the window calcuate its TF*IDF score.

                        // first, calculate term frequency within the current document (
                        // eg within the 10 second analysis window)
                        var popularWordsList = [];
                        for(var word in popularWordsInWindow) {
                            var tf = popularWordsInWindow[word];
                            
                            // Drop words that were only mentioned once in
                            // the window. With typos, lots of single-mentions
                            // have a super high idf (basically infinity) 
                            // which shoots them to the top. This REALLY 
                            // harshly limits the length of popularWords in
                            // bot mode, and means you gotta run lots of bots
                            // to make sure you're not constantly bottoming
                            // out on the list in high load situations. 
                            if(tf==1) {
                                continue;
                            }
                            
                            // get the IDF term looking at the doc_freq value.
                            // second log is to correct for the fact that Math.log
                            // is really ln
                            var df = 1;
                            if(word in docFreq) df = docFreq[word];
                        
                            var idf = Math.log(numDocs/df)/Math.log(10);
                        
                            popularWordsList.push({"word":word, "score":tf*idf});
                            // Knock out words that are mentioned once, just for cleaner
                            // data.
                            // TODO turn this back on when we know what the range
                            // on tf-idf scores looks like.
                            // if(wordScore > 1) {
                            //     popularWordsList.push({"word":word,
                            //         "score":wordFreq * idf});
                            // }
                        }
                        
                        // console.log("\t popWordsList.length=" + popularWordsList.length);

                        // In a later pass, we'll use this to decide how many words to 
                        // send total.
                        // totalActivity is in messages/second
                        // console.log("totalMessages: " + totalMessages);
                        // console.log("timeSinceStart: " + (Date.now() - startTime));
                        
                        var totalActivity = (totalMessages / ((Date.now() - startTime)/1000));
                        var windowActivity = messagesInWindow / WINDOW_SIZE;
                        var relativeActivity = windowActivity / totalActivity;

                        // so with current settings, relativeActivity goes from about 0 to 
                        // 2.0, so lets scale that way.

                        var activityFactor = relativeActivity/2.0;
                        if(activityFactor > 1) {
                            activityFactor = 1;
                        }

                        // Now sort the list by word score, so it's frequency sorted.
                        popularWordsList.sort(function(a, b) {
                            return a["score"] - b["score"];
                        });
                        popularWordsList.reverse();

                        console.log("activityFactor: " + activityFactor.toFixed(2) + " totalActivity: " + totalActivity.toFixed(1) + "; windowActivity: " + windowActivity.toFixed(1) + "; relativeActivity: " + relativeActivity.toFixed(3) + " messagesInWindow: " + messagesInWindow + " botChatOddsOffset: " + botChatOddsOffset.toFixed(4));
                        
                        // square the activity factor to make it more nonlinear
                        dict = popularWordsList.slice(0, activityFactor*40.0);
                        
                        // rescore all the words to make the point decline
                        // sharper than it is in reality (with the bot
                        // distribution, anyway)
                        var rescaledDict = [];
                        for(var key in dict) {
                            var entry = dict[key];
                            
                            var keyInt = parseInt(key);
                            
                            // the key is an int so we can use that to rescale
                            // off. We want an exponential falloff in scores
                            // so there are lots of really low score words.

                            // we'll make the max score 1, min score 0.
                            // we'll try doing it against an absolute curve,
                            // where the max length (for max activity) is 
                            // 30

                            entry["score"] = Math.pow(((dict.length-keyInt) / dict.length), 2);
                            rescaledDict.push(entry);
                        }
                        dict = rescaledDict;
                        
                        // console.log(dict);
                        
                        // dict = {"total":totalActivity, "inWindow":windowActivity, "relative":relativeActivity, "word":topWord, "word-score":bestScore};
                        // console.log(dict);
                        io.sockets.emit('pulse', {"words":dict,
                            "activity":{"total":totalActivity, "window":windowActivity,
                            "relative":relativeActivity,
                            "messages-per-min-instant":messagesInWindow*(60/WINDOW_SIZE)}});
                    });
                });
            });
        });
    });
}


//**************************************************************************//
// These methods manage bot text generation. Depends on a model file        //
// generated by util/chat_model_generator.js.                               //
//**************************************************************************//

var bots = {};
var baseRooms = ["General Chat 1","General Chat 2", "General Chat 3",
    "General Chat 4", "General Chat 5", "General Chat 6", "General Chat 7",
    "Team Liquid 1", "Team Liquid 2", "Team Liquid 3", "Team Liquid 4",
    "Reddit 1", "Reddit 2", "Reddit 3", "Reddit 4",
    "Wellplayed.org 1", "Wellplayed.org 2", "Wellplayed.org 3",
    "col.MVP Fans", "mouz fans", "Zerg Strategy",
    "Terran Strategy", "Protoss Strategy",
    "Francais", "Deutch", "Espangol"];
var botChatOddsOffset = 0.0;

var BASE_CHAT_ODDS = 0.003;

var varyBotParticipation = true;

function setupBots(num) {
    // Generate num names and store them.
    for(var i=0; i<num; i++) {
        var bot = generateBot();
        bots[bot["name"]] = bot;
    }
}

function generateBot() {
    var bot = {}
    var names = model["names"];
    
    var randIndex = Math.floor(Math.random()*names.length);
    bot["name"] = names[randIndex];
    
    randIndex = Math.floor(Math.random()*baseRooms.length);
    bot["room"] = baseRooms[randIndex];
    bot["chat_odds"] = BASE_CHAT_ODDS;
    bot["shouts_voted_for"] = {};
    
    joinRoom(null, bot["room"]);
    
    return bot;
}


var spikeProgress = -1;
function _chatBotTick() {
    
    setTimeout(_chatBotTick, 200);
    
    // Make it a sine wave with period 2 minutes.
    if(varyBotParticipation) {
        var timeFactor = ((Date.now()/1000)%60)/60;
        botChatOddsOffset = 0.6*BASE_CHAT_ODDS
            * Math.sin((2.0*Math.PI) * timeFactor);
    }
    
    if(spikeProgress>-1) {
        // for the first 20 ticks, decrease talking over time.
        // then spike to super high for 10 ticks, then stop.
        spikeProgress++;
        
        if(spikeProgress < 100) {
            botChatOddsOffset = BASE_CHAT_ODDS * (spikeProgress/100);
        } else if(spikeProgress < 120) {
            botChatOddsOffset = BASE_CHAT_ODDS;
        } else if(spikeProgress < 145) {
            botChatOddsOffset = -BASE_CHAT_ODDS;
        } else {
            varyBotParticipation = true;
            spikeProgress=-1;
        }
    }

    // Each tick, run through the list and see if that bot wants to say
    // something to its room.
    processBotChat();
    
    // get a list of active shouts (keys shout:*)
    // hgetall for each one, put them in a hash based on what rooms each
    // one is visible too. then for each bot, loop through the shouts
    // visible to their room and roll dice to decide on voting. 
    var shoutsByRoom = {};
    var currentKey = 0;
    var maxKeys = 0;
    client.keys("shout:*", function(err, keys) {

        // when we've accumulated this many, do the callback.
        maxKeys = keys.length;
        
        for(var keyIndex in keys) {
            var shoutKey = keys[keyIndex];
            
            
            client.hgetall(shoutKey, function(err, shoutData) {
                shoutData["room-votes"] = JSON.parse(shoutData["room-votes"]);
                
                // loop through all the rooms this shout has been sent to
                for(var roomName in shoutData["room-votes"]) {
                    
                    var list = []
                    if(roomName in shoutsByRoom) {
                        list = shoutsByRoom[roomName];
                    }
                    list.push(shoutData)
                    shoutsByRoom[roomName] = list;
                }
                
                currentKey++
                if(currentKey == maxKeys) {

                    // process bot voting now
                    for(var botName in bots) {
                        var bot = bots[botName];
                        // now process shouts. get the list of shouts in this
                        // bot's room and roll the dice on each one to see
                        // if you want to vote for it.
                        var shoutsInMyRoom = shoutsByRoom[bot["room"]];
                        for(var shoutIndex in shoutsInMyRoom) {
                            var shout = shoutsInMyRoom[shoutIndex];

                            if(shout["id"] in bot["shouts_voted_for"])
                                continue;

                            var shoutVoteOdds = Math.random();
                            if(shoutVoteOdds < 0.02) {
                                writeShoutFromRoom(bot["room"], shout["id"],
                                    null);
                            }
                        }
                    }
                }
            });
        }
    });
}


function processBotChat() {
    // do the next step with accumulated data in shoutsByRoom
    for(var botName in bots) {
        var bot = bots[botName];

        var chatOdds = Math.random() + botChatOddsOffset;

        if(chatOdds < bot["chat_odds"]) {
            // chat!
            var utterance = generateUtterance(model);
            sendChatToRoom(bot["room"], botName,
                utterance["text"]);
        }
    }
}

function generateUtterance(model) {
    
    var utterance = {};
    
    var words = model["words"];
    
    var currentWindowStart = -1;
    while(true) {
        // console.log("currentWindowStart=", currentWindowStart);
        
        var wordList;
        if(currentWindowStart==-1) {
            wordList = words[""];
        } else {
            var nextKey=utterance["text"]
                .split(/[\s]+/)
                .slice(currentWindowStart, currentWindowStart+2);
                
            nextKey = nextKey.join(" ");
            // console.log("nextKey=", nextKey);
            wordList = words[nextKey];
        }
        
        // console.log("wordlist=",wordList);
        
        var newWord = pickWordFromList(wordList);
        
        if(newWord=='undefined') {
            return utterance;
        }
        
        if(currentWindowStart==-1) {
            utterance["text"] = newWord;
            
            if(utterance["text"].split(/[\s]+/).length==1) return utterance;
            
        } else {
            utterance["text"] = utterance["text"] + " " + newWord;
        }
        
        // console.log("\t" + utterance);
        currentWindowStart++;
    }
}

function pickWordFromList(wordList) {
    
    var rand = Math.random();
    
    // run through the list until we hit that value.
    var prevScore = 0.0;
    for(var index in wordList) {
        var word = wordList[index];
        
        if(rand > prevScore && rand < word["prob"]) {
            // console.log("\tpicking: " + word["word"]);
            return word["word"];
        } else {
            prevScore = word["prob"];
            // console.log("prevScore=", prevScore);
        }
    }
}


// TOD try getting rid of these - tf-idf should handle all this stuff.
var stopWords = {"a":1,"about":1,"above":1,"after":1,"again":1,"against":1,"all":1,"am":1,"an":1
,"and":1,"any":1,"are":1,"aren't":1,"as":1,"at":1,"be":1,"because":1,"been":1,"before":1,"being":1,
"below":1,"between":1,"both":1,"but":1,"by":1,"can't":1,"cannot":1,"could":1,"couldn't":1,"did":1,
"didn't":1,"do":1,"does":1,"doesn't":1,"doing":1,"don't":1,"down":1,"during":1,"each":1,"few":1,
"for":1,"from":1,"further":1,"had":1,"hadn't":1,"has":1,"hasn't":1,"have":1,"haven't":1,
"having":1,"he":1,"he'd":1,"he'll":1,"he's":1,"her":1,"here":1,"here's":1,"hers":1,"herself":1,
"him":1,"himself":1,"his":1,"how":1,"how's":1,"i":1,"i'd":1,"i'll":1,"i'm":1,"i've":1,"if":1,"in":1,
"into":1,"is":1,"isn't":1,"it":1,"it's":1,"its":1,"itself":1,"let's":1,"me":1,"more":1,"most":1,
"mustn't":1,"my":1,"myself":1,"no":1,"nor":1,"not":1,"of":1,"off":1,"on":1,"once":1,"only":1,"or":1,
"other":1,"ought":1,"our":1,"ours":1," ourselves":1,"out":1,"over":1,"own":1,"same":1,"shan't":1,
"she":1,"she'd":1,"she'll":1,"she's":1,"should":1,"shouldn't":1,"so":1,"some":1,"such":1,"than":1,
"that":1,"that's":1,"the":1,"their":1,"theirs":1,"them":1,"themselves":1,"then":1,"there":1,
"there's":1,"these":1,"they":1,"they'd":1,"they'll":1,"they're":1,"they've":1,"this":1,
"those":1,"through":1,"to":1,"too":1,"under":1,"until":1,"up":1,"very":1,"was":1,"wasn't":1,"we":1,
"we'd":1,"we'll":1,"we're":1,"we've":1,"were":1,"weren't":1,"what":1,"what's":1,"when":1,
"when's":1,"where":1,"where's":1,"which":1,"while":1,"who":1,"who's":1,"whom":1,"why":1,"why's":1,
"with":1,"won't":1,"would":1,"wouldn't":1,"you":1,"you'd":1,"you'll":1,"you're":1,"you've":1,
"your":1,"yours":1,"yourself":1,"yourselves":1};
