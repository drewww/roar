var app = require('express').createServer(),
    io = require('socket.io').listen(app),
    redis = require('redis'),
    client = redis.createClient(),
    crypto = require('crypto'),
    express = require('express'),
    fs = require('fs'),
    program = require('commander'),
    sets = require('simplesets'),
    _ = require('underscore')._;
    // process = require('process');
    

program.version('0.2')
    .option('-V, --verbose', 'Enable verbose logging.')
    .option('-p, --port [num]', 'Set the server port (default 8080)')
    .option('-b, --bots [num]', 'Creates [num] server-side chat bots.')
    .option('-m, --model [filename]', "Specifies a specific chat model to load for bots. No effect without -b.")
    .option('-d, --disable', "Disables the shout system.")
    .option('-D, --database [num]', "Set the redis database index (default 0)")
    .option('-H, --disableheartbeats', "Disable heartbeats.")
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

io.set("log level", 0);
if(program.verbose) {
    io.set("log level", 3);
}

if(program.disableheartbeats) {
    io.set("heartbeats", false)
}
// Will need to swap these out for soccer, too.
var baseRooms;
    

var roomOptions = {"soccer":["Chelsea 1", "Chelsea 2", "Chelsea 3", "Chelsea 4",
        "Barcelona 1", "Barcelona 2", "Barcelona 3", "Barcelona 4",
        "Arsenal 1", "Arsenal 2", "Reds 1", "Reds 2", "Reds 3", "Reds 4",
        "City 1", "City 2", "City 3", "City 4",
        "reddit 1", "reddit 2",
        "france", "deutchland", "italia", "UK 1", "UK 2",
        "MIT", "Google", "Cambridge"],
        
        "starcraft":["Thorzain 1", "Thorzain 2", "Thorzain 3",
        "Naniwa 1", "Naniwa 2", "Naniwa 3",
        "Team Liquid 1", "Team Liquid 2",
        "EG 1", "EG 2",
        "Day9",
        "reddit 1", "reddit 2",
        "france", "deutchland", "italia",
        "MIT", "Google", "Cambridge",
        "dummy1", "dummy2", "dummy3", "dummy4", "dummy5", "dummy6", "dummy7"]}

var modelName = "";
var modelBaseDirectory = __dirname + "/chat_model/";
if(program.model) {
    modelBaseDirectory = modelBaseDirectory+program.model +"/";
    modelName = program.model;
    
    baseRooms = roomOptions[program.model];
} else {
    modelBaseDirectory = modelBaseDirectory+"starcraft_old/";
    modelName = "starcraft";
}
// GLOBALS
var numConnectedUsers = 0;




var model = {};

var autoKeywords = true;
var keywords = [null, null, null];

var bots = {};

var botChatOddsOffset = 0.0;

var BASE_CHAT_ODDS = 0.002;

var varyBotParticipation = true;
var botsMuted = false;


if(program.bots) {
    // Load in the model file. When it's done, kick off bot setup callbacks.
    
    model.index = JSON.parse(fs.readFileSync(modelBaseDirectory + "index.json"));
    model.names = JSON.parse(fs.readFileSync(modelBaseDirectory + "names.json"));
    model.messages = JSON.parse(fs.readFileSync(modelBaseDirectory + "messages.json"));
    model.keywords = JSON.parse(fs.readFileSync(modelBaseDirectory + "keywords.json"));
    console.log("Loaded model. " + model.messages.length + " messages available.");
    
    setupBots(program.bots);
}

app.listen(port);

// Setup the index page.
app.get('/', function(req, res) {
    res.render('index.ejs', {layout:false, locals:{"server":server,
        "port":port, "modelName":modelName}});
});

// Setup static serving from the static directory.
app.use(app.router);
app.use("/static", express.static(__dirname + '/static'));



// TODO Do some sort of blocking on accepting connections until the redis
// conneciton is actually alive.
io.sockets.on('connection', function(socket) {
    numConnectedUsers++;
    
    // Do some user welcoming stuff. 
    socket.emit("bots", {"mute":botsMuted});
    
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
                // if(res == 0) { 
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
                        socket.emit("chat", {text:"Welcome to ROAR!", admin:"true"});
                    }
                    
                    // push an initial room state down.
                    _updateRooms(socket);
                });
            });
        });
    });
        
    
    socket.on('chat', function(data) {
        // setup some internal commands so I can easily manipulate state
        // from messages.
        if(data.text[0]=="/") {
            
            var args = data.text.split(" ");
            var command = args[0];
            args = args.slice(1);
            command = command.slice(1);
            
            switch(command) {
                case "l":
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
                    
                case "k":
                case "keyword":
                    
                    if(args[0]=="add") {
                        if(args[1]) addKeyword(args[1], 3);
                        autoKeywords = false;
                    } else if(args[0]=="remove") {
                        if(args[1]) removeKeyword(args[1]);
                        autoKeywords = false;
                    } else if(args[0]=="clear") {
                        clearKeywords();
                        autoKeywords = false;
                    } else if(args[0]=="auto") {
                        autoKeywords = true;
                    }
                    
                    
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
            if(oldRoomName != null) {
                leaveRoom(socket, oldRoomName);
            }
            
            socket.set("room", newRoomName, function() {
                joinRoom(socket, newRoomName);
            });
        });
    });
    
    socket.on('room.list', function(data) {
        // send this socket an updated room list.
        _updateRooms(socket);
    });
    
    socket.on('shout', function (data) {
        
        if(program.disable) {
            sendAdminMessage(socket, "Shouting is disabled right now, sorry!");
            return;
        }
        
        // {text:(shout_text)}
        
        // create the shout datastructure
        client.incr("global:nextShoutId", function (err, shoutId) {
            
            var shoutKey = "shout:" + shoutId;
            var shoutInfo = {};
            
            client.hset(shoutKey, "id", shoutId);
            client.hset(shoutKey, "text", data["text"]);
            client.hset(shoutKey, "timestamp", Date.now());
            
            client.hset(shoutKey, "votes", 0);

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
                    
                    // also, register this socket as the owner of the shout
                    console.log("Joining socket to " + "shout:" + shoutId + ":owner");
                    socket.join("shout:" + shoutId + ":owner");
                });
            });
        });
    });
    
    socket.on('search', function(data) {
        var keyword = data["keyword"];
        
        client.lrange("messages.less_recent", 0, -1, function (err, res) {
            var messagesInWindow = 0;

            var popularWordsInWindow = {};

            // data contains all the messages in the room queue.
            var messagesWithKeyword = [];
            for(msgKey in res) {
                var msg = JSON.parse(res[msgKey]);
                
                // search the message looking for the keyword that we want.
                // if we find it, add it to the list. if we've found
                // enough examples, end and dump the messages on the client.
                
                if(msg.text.indexOf(keyword)!=-1) {
                    messagesWithKeyword.push(msg);
                }
            }
            
            messagesWithKeyword.reverse();
            
            socket.emit('search-result', {"keyword":keyword, "messages":
                JSON.stringify(messagesWithKeyword)});
        });
    });
    
    socket.on('shout.vote', function (data) {
        // {shout_id:(id)}
        voteForShout(socket, data["shout_id"], null);
    });
    
    socket.on('bots', function(data) {
        socket.get("nickname", function(err, nickname) {
            if(data["mute"]==true) {
                io.sockets.emit('bots', {"mute":true});

                broadcastAdminMessage(null, "Bots have been muted by "
                    + nickname + ".");
                    
                botsMuted = true;
            } else {
                io.sockets.emit('bots', {"mute":false});

                broadcastAdminMessage(null, "Bots have been un-muted by "
                    + nickname + ".");
                botsMuted = false;
            }            
        });
    });
    
    socket.on("keyframe", function(data) {
        
        console.log("KEYFRAME: " + JSON.stringify(data));
        
        autoKeywords = false;
        keywords = data.keywords;
        
        varyBotParticipation = false;
        botChatOddsOffset = (1-(parseFloat(data.level)))* 2 * BASE_CHAT_ODDS
            - BASE_CHAT_ODDS;
    });
    
    socket.on('disconnect', function(data) {
        // if(data) {
            // console.log("disconnect info: ", data);
        // }
        leaveRoom(socket, null);
        releaseNickname(socket);
        
        numConnectedUsers--;
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
    // set the database.
    if(program.database) {
        if(program.database == parseInt(program.database)) {
            client.select(program.database, function() {
                console.log("Selected database " + program.database);
                
            client.hgetall("global:connectedUsers", function(err, res) {
                for(key in res) {
                    client.hdel("global:connectedUsers", key);
                }
            });

            client.hgetall("rooms", function(err, res) {
                for(key in res) {
                    client.hdel("rooms", key);
                }
            });

            client.hgetall("rooms.population", function(err, res) {
                for(key in res) {
                    client.hdel("rooms.population", key);
                }
            });
            // Start the periodic data worker threads.
            // TODO split this into separate settimeouts to stagger them to avoid
            // them all running at the same time and competing?
            startWorkers();
            });
        }
    } else {
        startWorkers();
    }
});

function startWorkers() {
    // Start the periodic data worker threads.
    // TODO split this into separate settimeouts to stagger them to avoid
    // them all running at the same time and competing?
    setTimeout(function() {
        _processPulse();
        _updateRooms(null);
        _checkShoutExpiration();
        _chatBotTick();
        _logPerformanceData();
        _manageKeywords();
    }, 0);
    
}

function getSocketListForRoom(room) {
    var sockets = [];
    var socketHash = io.sockets.in(room).sockets;
    
    for(var socketId in socketHash) {
        sockets.push(socketHash[socketId]);
    }
    
    return sockets;
}

function broadcastAdminMessage(room, message) {
    if(room==null || typeof room == 'undefined') {
        // broadcast to EVERYONE.
        io.sockets.emit("chat", {text:message, admin:"true"});
    } else {
        io.sockets.in(room).emit("chat", {text:message, admin:"true"});
    }
}

function sendAdminMessage(socket, message) {
    socket.emit("chat", {text:message, admin:"true"});
}

function sendChatToRoom(roomName, nickname, messageText) {
    messageDict = {text:messageText, from:nickname,
        timestamp:Date.now(), room:roomName};

    io.sockets.in(roomName).emit("chat", messageDict);

    // By pushing and trimming, we keep it from growing indefinitely 
    // We don't need to trim; pulse will trim for us, to avoid having to
    // push more data around than is strictly necessary.
    client.rpush("messages.recent", JSON.stringify(messageDict));
    
    // these are in a separate list that can hold more stuff, so clicking 
    // on a top term doesn't return few results even though that term
    // WAS huge, just more than 2.5 seconds ago. 
    client.rpush("messages.less_recent", JSON.stringify(messageDict));
    
    // make sure this doesn't get over 2000 elements. 
    client.ltrim("messages.less_recent", -2000, -1);
    
    // increment the counter for room activity.
    client.hincrby("rooms.activity", roomName, 1);
}

function spreadShoutToRoom(room, shoutId) {
    // now spread the shout
    var shoutKey = "shout:" + shoutId;
    console.log("shoutKey: " + shoutKey);
    
    if(typeof shoutKey == 'undefined' || shoutKey=="undefined") return;
    
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
        
        client.hset(shoutKey, "room:" + room + ":votes", 0);
        client.hset(shoutKey, "room:" + room + ":promoted", "false");
        
        // Manage the timeouts. If no expiration is set, set it to now+1 min.
        // If a timeout is set (and we're expanding to a new room), give the
        // shout another minute of life
        console.log("shoutKey: " + shoutKey);
        client.hget(shoutKey, "expiration", function (err, res) {
           if(res==null) {
               client.hset(shoutKey, "expiration", Date.now() + 60000);
           } else {
               
               client.hincrby(shoutKey, "expiration", 60000);
               
               // putting the admin message here because this only happens
               // on non-initial spreads.

               console.log("shoutKey: " + shoutKey);
               
               console.log("Spreading to key " + shoutKey + ":owner");
               var socket = getSocketListForRoom(shoutKey +":owner")[0];
               
               sendAdminMessage(getSocketListForRoom(shoutKey +":owner")[0],
                   "Your shout just spread to " + room + "!");
           }
        });
    });
}

function voteForShout(socket, shoutId, callback) {
    
    if(typeof shoutId == 'undefined' || shoutId=="undefined") return;
    
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
                writeShoutVoteFromRoom(room, shoutId, callback);
                
                // Mark this socket as having voted.
                votesList.push(shoutId +"");
                socket.set("votes", JSON.stringify(votesList));
                
            });
        }
    });
}

function writeShoutVoteFromRoom(room, shoutId, callback) {
    
    var shoutKey = "shout:" + shoutId;
    
    // shout vote data is stored in a series of keys:
    // room:roomname:votes
    // room:roomname:promoted
    // (aside: roomnames need to have have colons in them)
    
    var roomVotesKey = "room:" + room + ":votes";
    var roomPromotedKey = "room:" + room + ":promoted";
    
    client.hincrby(shoutKey, roomVotesKey, 1, function(err, roomVotes) {
        // Check for shout promotion here. The question is, have more 
        // than half the people in the room it was just voted for in
        // vote for it. If they did, spread it. 
        
        client.hget(shoutKey, roomPromotedKey, function(err, isPromoted) {
            
            // console.log("checking promotion on " + shoutKey + ": " + isPromoted);
            if(isPromoted=="true") {
                // console.log("blocking promotion from " + room + " because already promoted");
                return;
            }
            
            // if this room has already promoted the shout, no need to 
            // promote further. call it. otherwise, do the promotion
            // checking.
            client.hget("rooms.population", room,
                function(err, pop) {
                    // console.log("checking shout promotion: " + roomVotes + " > " + (pop/4) + "?");
                    if(roomVotes > (pop/4)) {
                        // console.log("promoting shout!");

                        // flip the bit on room votes that says don't use
                        // this room to cause a promotion anymore.
                        // (DO THIS NEXT)
                        client.hset(shoutKey, roomPromotedKey, "true");

                        client.hkeys("rooms.population",
                            function(err, roomNames) {
                            client.hkeys(shoutKey, function(err, shoutKeys) {
                                var roomNameSet = new sets.Set(roomNames);

                                var roomsAlreadySpreadTo = [];
                                // console.log("shoutKeys=", shoutKeys);
                                for(var shoutKeyIndex in shoutKeys) {
                                    var key = shoutKeys[shoutKeyIndex];
                                    var keyPieces = key.split(":");
                                    if(keyPieces.length != 3) continue;
                                    if(keyPieces[0]=="room" &&
                                        keyPieces[2]=="votes") {
                                        roomsAlreadySpreadTo.push(keyPieces[1]);
                                    }
                                }
                                // console.log("roomsAlreadySpreadTo=", roomsAlreadySpreadTo);
                                
                                // remove all the rooms this shout has already
                                // spread to. 
                                for(var roomsSpreadIndex in roomsAlreadySpreadTo) {
                                    roomNameSet.remove(
                                        roomsAlreadySpreadTo[roomsSpreadIndex]);
                                }
                            
                                // console.log("total rooms: " + roomNames.length + " rooms left to spread to: " + roomNameSet.size());

                                if(roomNameSet.size==0) {
                                    // TODO tell the client who shouted
                                    // that it's maxxed out.
                                    handleMaxShout(shoutId);
                                    return;
                                }

                                // now roomNameSet has all the rooms that
                                // haven't seen this shout yet. roll the
                                // dice and expand to two of them.
                                
                                for(var i=0; i<2; i++) {
                                    if(roomNameSet.size()==0) {
                                        handleMaxShout(shoutId);
                                        return;
                                    }
                                    
                                    var index = Math.floor(Math.random()* 
                                        roomNameSet.size()-.0000001);
                                    var roomToSpreadTo = roomNameSet.array()[index];
                                    spreadShoutToRoom(roomToSpreadTo, shoutId);
                                    roomNameSet.remove(roomToSpreadTo);
                                }
                            });
                        });
                    }
            });
        });
    });
    
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
            if(callback!=null&&typeof callback != 'undefined') callback();
        }, 0);
    });
}

function handleMaxShout(shoutId) {
    
    var socket = getSocketListForRoom("shout:" + shoutId +":owner")[0];
    
    socket.get("shout:" + shoutId + ":max-promotion-notice",
        function(err, hasSeenPromotionNotice) {
        
            if(hasSeenPromotionNotice!=null) return;
        
            console.log("Shout has reached max promotion.");


            sendAdminMessage(socket, "Everyone has seen your shout!");

            // and then remove them from the channel
            socket.leave("shout:" + shoutId + ":owner");
            socket.set("shout:" + shoutId + ":max-promotion-notice", true);
    });
    
    
}

function releaseNickname(socket) {
    socket.get("nickname", function(err, nickname) {
        client.hdel("global:connectedUsers", nickname);
    });
}

function joinRoom(socket, newRoomName) {
    var population;
        
    // TODO validate the room name. Need to not include : or other special
    // characters and notify people of errors when they choose bad names.
    
    
    client.hincrby("rooms.population", newRoomName, 1,
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
                
                client.hget("rooms.population", newRoomName,
                    function(err, population) {
                        room["population"] = population;
                        
                        client.hset("rooms", newRoomName, JSON.stringify(room));
                        if (socket) {
                            // sendAdminMessage(socket,
                            //     "You're now in section '" + newRoomName +
                            //     "' with "+population+" other person.");
                            sendAdminMessage(socket,
                                "You're now in section '" + newRoomName +
                                "'.");
                        }
                });
            });
        } else {
            client.hget("rooms", newRoomName,
                function(err, roomData) {
                    if (roomData != null) {
                        var room = JSON.parse(roomData);

                        // other option is to run a separate query to get the
                        // current population from rooms.population at
                        // this point.
                        client.hget("rooms.population", newRoomName,
                            function(err, population) {
                                room["population"] = population;

                                client.hset("rooms", newRoomName,
                                    JSON.stringify(room),
                                    function(err, res) {
                                        if (socket) {
                                            sendAdminMessage(socket, 
                                            "You're now in section '" + newRoomName +
                                            "' with " + room["population"] +
                                            " other people.");
                                            socket.emit("room-population", {"population":room["population"]});
                                        }
                                });
                            });
                    }
                });
            }

        // turn this off since it makes mass joining a disaster
        // if(socket) socket.get("nickname", function(err, nickname) {
        //     // Kinda wanted to say where they came from here, but
        //     // that turns out to be a little tedious with the callback
        //     // structure. Figure out some way to cache that to make it
        //     // accessible?
        //     broadcastAdminMessage(newRoomName, nickname + " has arrived.");
        // });

        // doing this after the arrival broadcast message means
        // it doens't go to that user, which is nice. We have separate
        // arrival messages for them.
        if(socket) socket.join(newRoomName);
        
    });
}

function leaveRoom(socket, newRoomName) {
    // See if this socket is in a room already.
    socket.get("room", function(err, roomName) {
        // console.log("leaving room: " + roomName);
        if(roomName!=null) {
            // We need to leave that room first.
            // 1. Unsubscribe the socket.
            // 2. Decrement the population count.
            // 3. Potentially delete the channel if there's no one left.
            socket.leave(roomName);
            
            socket.emit("chat", {text:
                "You have left section '"+roomName+"'.", admin:"true"});
            
            socket.get("nickname", function(err, nickname) {
                if(newRoomName == null) {
                    io.sockets.in(roomName).emit("chat",
                    {text:nickname + " has logged off.",
                    admin:"true"});
                } else {
                    io.sockets.in(roomName).emit("chat",
                    {text:nickname + " has moved to " + newRoomName + ".",
                    admin:"true"});
                }
            });

            client.hget("rooms", roomName, function(err, roomData) {
                var room = JSON.parse(roomData);
                
                room["population"] = room["population"] - 1;
                
                // decrement the other counter, too.
                client.hincrby("rooms.population", roomName, -1,
                    function(err, population) {
                        if(population==0) {
                            client.hdel("rooms", roomName);
                        } else {
                            client.hset("rooms", roomName,
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

                    console.log("Expiring shout:" + shoutId);
                    
                    client.hgetall(shoutKey, function(err, shoutData) {
                        client.rpush("shouts",
                            JSON.stringify(shoutData), function (err, res) {
                                client.del(shoutKey);
                                
                                // Keeps max shout history at 100 to avoid
                                // accumulating infinite data.
                                client.ltrim("shouts", -100, -1);
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
                    
                    var socketsList = getSocketListForRoom(shoutKey+":owner");
                    if(socketsList.length==1)
                        socketsList[0].leave(shoutKey + ":owner");
                }
            });
        }
    });
}

// TODO Switch this to an on-demand sort of thing to save on bandwidth. Also,
// think about heavily caching the room list in a dedicated key at some point.
// Send an update with summary information about the current roomlist
// to populate client side room autocomplete information. 
var _updateRoomsCallCount = 1;
function _updateRooms(socket) {
    // For each room we want to include the room name and the number
    // of people in each room. This is all stored in redis, so we can
    // just dump the contents of rooms and format it into one
    // big JSON message to distribute.
    
    // if there's a socket passed in, it's a request to do a one-shot
    // update.
    if(socket==null || typeof socket == 'undefined') setTimeout(_updateRooms, 5000);

    client.hgetall("rooms.population", function(err, populations) {
        client.hgetall("rooms.activity", function(err, activities) {
            client.get("global:total_activity", function(err, total_activity){
                
                var roomCount = 0;
                for(var foo in populations) roomCount++;
                
                var allRoomData = [];
                for(var roomName in populations) {
                    var roomMessages = 0;
                    if(roomName in activities) {
                        roomMessages = activities[roomName];
                    }
                    
                    // Also need to take into account that total_activity
                    // is ALL rooms - divide by the room count to normalize
                    // it properly.
                    var roomMessagesPerSecond = roomMessages /
                        (5*(_updateRoomsCallCount));
                    var relativeRoomActivity = roomMessagesPerSecond/
                        (total_activity/roomCount);
                
                    allRoomData.push({"name":roomName,
                        "population":populations[roomName],
                        "relative":relativeRoomActivity});
                }
        
                // sort the rooms by population
                allRoomData.sort(function(a, b) {
                    return a["population"] - b["population"];
                });
                allRoomData.reverse();
        
                // Now broadcast this message to all clients.
                if(socket==null  || typeof socket == 'undefined') {
                    io.sockets.emit("rooms", allRoomData);
                    
                    // clear out the activity list ever 6 times this gets
                    // called to low-pass a little better.
                    _updateRoomsCallCount++;
                    
                    if(_updateRoomsCallCount%6==0) {
                        _updateRoomsCallCount=1;
                        client.del("rooms.activity");
                    }
                    
                } else socket.emit("rooms", allRoomData);
            });
        });
    });
}

function _manageKeywords() {
    setTimeout(_manageKeywords, 2500);
    console.log("KEY: " + JSON.stringify(keywords));
    if(autoKeywords) updateKeywords();
}

var lastDocumentProcessed = Date.now();
var WINDOW_SIZE = 10;

function _processPulse() {
    
    setTimeout(_processPulse, 2500);
    
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
                
                msg.text = msg.text.replace(/[\(\)!?,.\"\'\*\=;]/g, " ");
                msg.text = msg.text.replace(/\/\//g, " ");
                
                
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
                    word = word.replace(/[\(\)!?,.\"\'\*\;\=\:]/g, "");
                    word = word.replace(/\/\//g, "");
                    
                    if(word == "") continue;
                    if(word == " ") continue;
                    
                    
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
                            
                            if(word=="" || word == " " || word.length<2) {
                                continue;
                            }
                            
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
                        
                        totalActivity = (totalMessages / ((Date.now() - startTime)/1000));
                        windowActivity = messagesInWindow / WINDOW_SIZE;
                        relativeActivity = windowActivity / totalActivity;

                        // cache totalActivity (messages/second) in redis
                        // for other parts of the system to use.
                        client.set("global:total_activity", totalActivity);

                        // so with current settings, relativeActivity goes from about 0 to 
                        // 2.0, so lets scale that way.

                        activityFactor = relativeActivity/2.0;
                        if(activityFactor > 1) {
                            activityFactor = 1;
                        }

                        // Now sort the list by word score, so it's frequency sorted.
                        popularWordsList.sort(function(a, b) {
                            return a["score"] - b["score"];
                        });
                        popularWordsList.reverse();

                        messagesPerMin = messagesInWindow*(60/WINDOW_SIZE);

                        
                        // square the activity factor to make it more nonlinear
                        dict = popularWordsList.slice(0, activityFactor*40.0);
                        
                        // rescore all the words to make the point decline
                        // sharper than it is in reality (with the bot
                        // distribution, anyway)
                        
                        var topWordsLogging = "";
                        
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
                            
                            topWordsLogging  = topWordsLogging + ", " + entry["word"];
                        }
                        dict = rescaledDict;
                        
                        // console.log(dict);
                        
                        // dict = {"total":totalActivity, "inWindow":windowActivity, "relative":relativeActivity, "word":topWord, "word-score":bestScore};
                        // console.log(dict);
                        console.log("WORDS: " + topWordsLogging);
                        
                        
                        io.sockets.emit('pulse', {"words":dict,
                            "activity":{"total":totalActivity, "window":windowActivity,
                            "relative":relativeActivity,
                            "messages-per-min-instant":messagesPerMin}});
                    });
                });
            });
        });
    });
}

var messagesPerMin = 0;
var activityFactor = 0;
var totalActivity = 0;
var windowActivity = 0;

function _logPerformanceData() {
    setTimeout(_logPerformanceData, 2000);
    console.log("@" + Math.floor(Date.now()/1000) + " users: " + numConnectedUsers + " messagesPerMin: " + messagesPerMin + " activityFactor: " + activityFactor.toFixed(2) + " totalActivity: " + totalActivity.toFixed(1) + "; windowActivity: " + windowActivity.toFixed(1) + " botChatOddsOffset: " + botChatOddsOffset.toFixed(4));
}


//**************************************************************************//
// These methods manage bot text generation. Depends on a model file        //
// generated by util/chat_model_generator.js.                               //
//**************************************************************************//

function setupBots(num) {
    // Generate num names and store them.
    for(var i=0; i<num; i++) {
        var bot = generateBot();
        bots[bot["name"]] = bot;
    }
}

function generateBot() {
    var bot = {}
    var names = model.names;
    
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
    if(!botsMuted) processBotChat();
    
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
                // all the per room shout data is now in its own keys, of the
                // form described elsewhere (shout:roomname:votes)

                for(var key in shoutData) {
                    var keyPieces = key.split(":");
                    if(keyPieces.length != 3) continue;
                    if(keyPieces[0]=="room" && keyPieces[2]=="votes") {
                        
                        var roomName = keyPieces[1];

                        var list = [];
                        if(roomName in shoutsByRoom) {
                            list = shoutsByRoom[roomName];
                        }
                        list.push(shoutData)
                        shoutsByRoom[roomName] = list;
                    }
                }
                // console.log("shouts by room", shoutsByRoom);
                currentKey++
                if(currentKey == maxKeys) {

                    // process bot voting now
                    for(var botName in bots) {
                        var bot = bots[botName];
                        // now process shouts. get the list of shouts in this
                        // bot's room and roll the dice on each one to see
                        // if you want to vote for it.
                        var shoutsInMyRoom = shoutsByRoom[bot["room"]];
                        if(shoutsInMyRoom==null || typeof shoutsInMyRoom == 'undefined') continue;
                        // console.log("shoutsInMyRoom", shoutsInMyRoom);
                        
                        for(var shoutIndex in shoutsInMyRoom) {
                            var shout = shoutsInMyRoom[shoutIndex];

                            var shoutVoteOdds = Math.random();
                            if(shoutVoteOdds < 0.005) {

                                // disabling non-double voting beacuse it seems
                                // to break things and max out all the bots at
                                // way lower thant he room count. So, demo around it.
                                // console.log("shoutIndex=", shoutIndex);
                                // console.log("shout=", shout);
                                // console.log("shouts_voted_for=", bot["shouts_voted_for"]);
                                // if(shout["id"] in bot["shouts_voted_for"]) 
                                //     continue;
                                
                                
                                writeShoutVoteFromRoom(bot["room"], shout["id"],
                                    null);
                                bot["shouts_voted_for"][shout["id"]] = true;
                                bots[botName] = bot;
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
                utterance);
        }
    }
}

function updateKeywords() {
    // get a list of unique keywords, minus null
    var uniqueKeywords = _.uniq(keywords);
    uniqueKeywords = _.filter(uniqueKeywords, function(keyword) {return keyword!=null});
    
    // okay now for each of these, run the odds.
    _.each(uniqueKeywords, function(keyword) {
        var num = Math.random();
        
        if(num > 0.9) {
            // expand
            addKeyword(keyword, 1);
        } else if (num > 0.8) {
            // contract
            removeKeyword(keyword, 1);
        } else {
            // do nothing.
            
        }
    });
    
    if(uniqueKeywords.length == 3) {
        var num = Math.random();
        
        if(num > 0.8) {
            // remove a keyword
            var index = Math.floor(Math.random()*3);
            removeKeyword(uniqueKeywords[index]);
        }
    } else {
        var num = Math.random();
        
        if(num > 0.8) {
            // add a keyword
            var volume = Math.floor(Math.random()*5 + 1);
            addKeyword(chooseKeyword(), volume);
        }
    }
    
}

function chooseKeyword() {
    var actualKeywords = _.pluck(model.keywords, 'word');
    
    var keyword = actualKeywords[Math.floor(Math.random()*30)];
    
    return keyword;
}

function clearKeywords() {
    // removes any non-null keywords
    keywords = _.filter(keywords, function(keyword) { return keyword==null;});
}

function removeKeyword(keywordToRemove) {
    keywords = _.filter(keywords, function(keyword)
        {return keyword!=keywordToRemove});
}

function removeSomeKeyword(keywordToRemove, instances) {
    var count = 0;
    keywords = _.filter(keywords, function(keyword) {
        if(keyword==keywordToRemove) {
            if(count < instances) {
                count++;
                return false;
            }
        }
        
        return true;
    });
}

function addKeyword(keyword, instances) {
    for(var i=0; i<instances; i++) {
        keywords.push(keyword);
    }
}


function generateUtteranceForKeyword(keyword) {
    // this is really easy - just look at keyword and grab a random example
    // that includes that keyword.
    
    var messageIndex;
    if(keyword==null) {
        messageIndex = Math.floor(Math.random()*model.messages.length);
    } else {
        var messageIndicesForKeyword = model.index[keyword];
        
        if(_.isUndefined(messageIndicesForKeyword)) {
            console.log("FOUND BAD KEYWORD: " + keyword);
            return "bad keyword";
        }
        var randomIndex = Math.floor(Math.random()*messageIndicesForKeyword.length);
        messageIndex = messageIndicesForKeyword[randomIndex];
    }
    
    var message = model.messages[messageIndex];
    // console.log("chatting: " + message.text);
    return message.text;
}

function generateUtterance() {
    // pick a random keyword
    
    var keywordIndex = Math.floor(Math.random()*keywords.length);
    var keyword = keywords[keywordIndex];
    
    return generateUtteranceForKeyword(keyword);
}

// TODO try getting rid of these - tf-idf should handle all this stuff.
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
"your":1,"yours":1,"yourself":1,"yourselves":1, "keyword":1, "keywords":1};
