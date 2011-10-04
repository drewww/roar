var app = require('express').createServer(),
    io = require('socket.io').listen(app),
    redis = require('redis'),
    client = redis.createClient(),
    crypto = require('crypto'),
    express = require('express'),
    fs = require('fs'),
    program = require('commander');
    // process = require('process');
    

program.version('0.1')
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
    })
    
    // Start the periodic data worker threads.
    // TODO split this into separate settimeouts to stagger them to avoid
    // them all running at the same time and competing?
    setTimeout(function() {
        _processPulse();
        _updateRooms(null);
        _checkShoutExpiration();
        
    }, 5000);

});

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
            console.log("in vote index:  " + voteIndex);
            if (shoutId+"" ===votesList[voteIndex]) {
                inVotesList = true;
                break;
            }
        }
        
        if(inVotesList) {
            socket.emit('message',
                {text:"You've already voted for that shout", admin:"true"});
        } else {
            // Allow the vote.
            socket.get("room", function(err, room) {
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
                        // Mark this socket as having voted.
                        votesList.push(shoutId +"");
                        socket.set("votes", JSON.stringify(votesList));

                        // now check for shout promotion

                        // Do the callback.
                        if(callback!=null) setTimeout(callback, 0);
                    });
                });
            });
        }
    });
}

function releaseNickname(socket) {
    socket.get("nickname", function(err, nickname) {
        client.hdel("global:connectedUsers", nickname);
    });
}

function joinRoom(socket, newRoomName) {
        var population;
        client.hexists("global:rooms", newRoomName, function (err, exists) {
            if(exists) {

                // If we already know about the room, increment the count
                client.hget("global:rooms", newRoomName, function (err, roomData) {
                   var room = JSON.parse(roomData);

                   // gonna need to test this
                   room["population"] = room["population"]+1;

                   client.hset("global:rooms", newRoomName,
                        JSON.stringify(room), function(err, res) {
                       socket.emit('message', {text:
                           "You have joined room '"+newRoomName+
                           "' with " + room["population"] +
                           " total people.", admin:"true"});                           
                   });
                });
            } else {
                // otherwise, make a new hash for this room's info.
                client.incr("global:nextRoomId", function (err, roomId) {

                    var room = {};
                    room["id"] = roomId;
                    room["name"] = newRoomName;
                    room["population"] = 1;

                    client.hset("global:rooms", newRoomName, JSON.stringify(room));

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
                
                if(room["population"]==0) {
                    client.hdel("global:rooms", roomName);
                } else {
                    client.hset("global:rooms", roomName,
                        JSON.stringify(room));
                }
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
    if(socket==null) setTimeout(_updateRooms, 5000);
    
    client.hgetall("global:rooms", function(err, res) {
        var allRoomData = [];
        for(var roomName in res) {
            var room = JSON.parse(res[roomName]);
            allRoomData.push({"name":roomName, "population":room["population"]});
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
        io.sockets.emit('pulse', {"words":dict,
            "activity":{"total":totalActivity, "window":windowActivity,
            "relative":relativeActivity}});
    });
}


//**************************************************************************//
// These methods manage bot text generation. Depends on a model file        //
// generated by util/chat_model_generator.js.                               //
//**************************************************************************//

var bots = {};
var baseRooms = ["General Chat", "Team Liquid", "Reddit", "DRG Fans", "mouz fans", "Zerg Strategy", "Terran Strategy"];
function setupBots(num) {
    var names = model["names"];
    // Generate num names and store them.
    for(var i=0; i<num; i++) {
        var bot = {}
        var randIndex = Math.round(Math.random()*names.length);
        bot["name"] = names[randIndex];
        
        // randIndex = Math.round(Math.random()*baseRooms.length);
        // bot["room"] = 
        bots[bot["name"]] = bot;
    }
    
    console.log("bots=", bots)
}

function generateUtterance(model) {
    
    var utterance = {};
    
    var names = model["names"];
    var words = model["words"];
    
    for(var key in model) {
        console.log("key: " + key);
    }
    
    // pick a name first. Just random the names list.
    var randIndex = Math.round(Math.random()*names.length);
    utterance["name"] = names[randIndex];
    
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
