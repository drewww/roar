var app = require('express').createServer(),
    io = require('socket.io').listen(app),
    redis = require('redis'),
    client = redis.createClient(),
    crypto = require('crypto'),
    express = require('express'),
    fs = require('fs'),
    program = require('commander');
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


function sendChatToRoom(roomName, nickname, messageText) {
    messageDict = {text:messageText, from:nickname,
        timestamp:Date.now(), room:roomName};

    io.sockets.in(roomName).emit('message', messageDict);

    // By pushing and trimming, we keep it from growing indefinitely 
    client.rpush("room.messages", JSON.stringify(messageDict));
    client.ltrim("room.messages", -2000, -1);
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
                        if (socket) socket.emit('message', {
                            text:
                            "You have joined room '" + newRoomName +
                            "' with "+population+" total person.",
                            admin: "true"
                        });
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
                                console.log("internal callback pop: " + population);
                                room["population"] = population;

                                client.hset("global:rooms", newRoomName,
                                    JSON.stringify(room),
                                    function(err, res) {

                                    if (socket) socket.emit('message', {
                                        text:
                                        "You have joined room '" + newRoomName +
                                        "' with " + room["population"] +
                                        " total people.",
                                        admin: "true"
                                });
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
            io.sockets.in(newRoomName).emit("message",
            {text:nickname + " has arrived.",
            admin:"true"});
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
    if(socket==null || typeof socket == 'undefined') setTimeout(_updateRooms, 5000);
    
    client.hgetall("global:rooms", function(err, res) {
        var allRoomData = [];
        for(var roomName in res) {
            var room = JSON.parse(res[roomName]);
            allRoomData.push({"name":roomName, "population":room["population"]});
        }

        // Now broadcast this message to all clients.
        if(socket==null  || typeof socket == 'undefined') {
            io.sockets.emit("rooms", allRoomData);
        } else socket.emit("rooms", allRoomData);
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
            "relative":relativeActivity,
            "messages-per-min-instant":messagesInWindow*(60/10)}});
    });
}


//**************************************************************************//
// These methods manage bot text generation. Depends on a model file        //
// generated by util/chat_model_generator.js.                               //
//**************************************************************************//

var bots = {};
var baseRooms = ["General Chat 1","General Chat 2", "General Chat 3",
    "General Chat 4", "General Chat 5", "General Chat 6", "General Chat 7",
    "Team Liquid", "Reddit", "col.MVP Fans", "mouz fans", "Zerg Strategy",
    "Terran Strategy"];
var botChatOddsOffset = 0.0;
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
    bot["chat_odds"] = 0.02;
    
    joinRoom(null, bot["room"]);
    
    return bot;
}

function _chatBotTick() {
    
    setTimeout(_chatBotTick, 200);
    
    // varry the chat odds slightly over time. clamp at +0.019 (near silence)
    // and -0.02 (doubling odds); max change per cycle is +/-0.0005
    var changeToOdds = (Math.random() * 0.0010) - 0.0005;
    botChatOddsOffset += changeToOdds;
    if(botChatOddsOffset > 0.019) {
        botChatOddsOffset == 0.019;
    } else if (botChatOddsOffset < -0.02) {
        botChatOddsOffset = -0.02;
    }
    
    // Each tick, run through the list and see if that bot wants to say
    // something to its room.
    for(var botName in bots) {
        var bot = bots[botName];
        
        var chatOdds = Math.random() + botChatOddsOffset;

        if(Math.random() < bot["chat_odds"]) {
            // chat!
            var utterance = generateUtterance(model);
            sendChatToRoom(bot["room"], botName, utterance["text"]);
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
