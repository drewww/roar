// This script reads a Colloquey IRC chat log and generates a markov chat
// model based on it, which can be easily deployed on the ROAR server-side.

var libxml = require("libxmljs"),
    logger = require('util'),
    fs = require('fs'),
    sets = require('simplesets'),
    program = require('commander')
    ;

// Set the window size in seconds to 3 minutes.
var WINDOW_SIZE_MSECONDS = 60*3*1000;

var STOP_WORDS = {"a":1,"about":1,"above":1,"after":1,"again":1,"against":1,"all":1,"am":1,"an":1
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

program.version('0.2')
    .option('-i, --index [messages] [keywords]', 'Builds an index of chat messages using top keywords from the keywords file.')
    .option('-t, --tfidf [messages]', 'Performs TF-IDF on the corpus, generating a ranking of all terms in the corpus.')
    .option('-p, --process [chatxml]', 'Turns chat xml into a javascript object with indicies assigned to messages and a list of unique names.')
    .option('-n, --numutterances [num]', 'Generate a specified number of utterances (default 1)')
    .parse(process.argv);


if(program.process) {
    chatxml = program.process;
    
    console.log("Loading chat logs...");

    var chatlogXml = fs.readFileSync(chatxml, 'utf-8');
    var logDoc = libxml.parseXmlString(chatlogXml);

    var namesSet = new sets.Set([]);
    var nameNodes = logDoc.find("//envelope/sender");
    for(var nameNodeIndex in nameNodes) {
        var nameNode = nameNodes[nameNodeIndex];

        namesSet.add(nameNode.text());
    }

    var messageNodes = logDoc.find("//envelope/message");

    var chatMessages = [];
    
    for(var messageNodeIndex in messageNodes) {
        var messageNode = messageNodes[messageNodeIndex];
        
        var datetime = new Date(messageNode.attr("received").value());
        
        chatMessages.push({"text":messageNode.text(), "time":datetime.getTime()});
    }
    
    // now dump it.
    fs.writeFileSync("messages.json", JSON.stringify(chatMessages));
    fs.writeFileSync("names.json", JSON.stringify(namesSet.array()));
} else if (program.tfidf) {
    console.log("Performing TF-IDF analysis");
    
    var contents = fs.readFileSync(program.tfidf);
    
    var messages = JSON.parse(contents);
    console.log("performing tfidf on " + messages.length + " messages");
    
    // words -> number of documents that word appears in
    var documentFrequency = {};
    
    // term frequency globally
    var termFrequencyGlobal = {};
    var termFrequencyDocument = {};
    
    // tracking window position
    var nextWindowThreshold = false;
    
    for (var messageIndex in messages) {
        var message = messages[messageIndex];
        // console.log(message.time);
        if(nextWindowThreshold==false) {
            nextWindowThreshold = message.time + WINDOW_SIZE_MSECONDS;
            console.log("setting next window threshold: " + nextWindowThreshold);
        } else if (nextWindowThreshold < message.time) {
            // handle the end of the window - push things into document
            // frequency.
            
            // two things:
            // merge termFrequencyDocument into termFrequencyGlobal
            // merge termFrequencyDocument into documentFrequency
            
            console.log("ending document, term freq doc: " + JSON.stringify(termFrequencyDocument));
            termFrequencyDocument = {};
            nextWindowThreshold = message.time + WINDOW_SIZE_MSECONDS;
        }
        
        // otherwise, this is a normal message, so split it up and figure out
        // our terms. push them into term frequency global
        
        wordsInMessage = message.text.split(/[\s]+/);
        
        // For each word in the message 
        for(var wordIndex in wordsInMessage) {
            var word = wordsInMessage[wordIndex];
            
            isStopWord = word in STOP_WORDS;
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
            
            if(word in termFrequencyDocument) {
                termFrequencyDocument[word] = termFrequencyDocument[word] + 1;
            } else {
                termFrequencyDocument[word] = 1;
            }
        }
        
    }
    
    
    // load the messages in
    
    // now iterate through the messages, up until we hit a document
    // boundary (which will be a time-based window, will also try message
    // count-based)
    
    // while iterating through messages, keep a hash that is
    // word -> appearance count. that's global frequency. when we hit
    // the end of a window, take all the keys in that hash and increment
    // the document frequency count by one for each of them, adding keys
    // as necessary.
    
    
    
    
    
} else if (program.index) {
    console.log("Indexing");
} else if (program.numutterances) {
    console.log("Generating utterances.");

    // going to need to update the loading significantly, but will just
    // leave this here for now.
    var model = JSON.parse(fs.readFileSync("chat_model.json", 'utf-8'));
    
    if(program.printmodel) {
        console.log(model);
    }
    
    var numUtterances = 1;
    
    if(program.numutterances) {
        numUtterances = program.numutterances;
    }
    
    for(var i=0; i<numUtterances; i++) {
        console.log(generateUtterance(model));
    }
}

function generateUtterance(model) {
    
    var utterance = {};
    
    var names = model["names"];
    var words = model["words"];
    
    
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
            var nextKey=utterance["text"].split(/[\s]+/).slice(currentWindowStart, currentWindowStart+2);
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

