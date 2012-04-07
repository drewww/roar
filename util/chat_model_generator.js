// This script reads a Colloquey IRC chat log and generates a markov chat
// model based on it, which can be easily deployed on the ROAR server-side.

var libxml = require("libxmljs"),
    logger = require('util'),
    fs = require('fs'),
    sets = require('simplesets'),
    program = require('commander')
    ;


program.version('0.2')
    .option('-i, --index [corpus] [keywords]', 'Builds an index of chat messages using top keywords from the keywords file.')
    .option('-t, --tfidf [corpus]', 'Performs TF-IDF on the corpus, generating a ranking of all terms in the corpus.')
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
