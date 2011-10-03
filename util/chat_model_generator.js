// This script reads a Colloquey IRC chat log and generates a markov chat
// model based on it, which can be easily deployed on the ROAR server-side.

var libxml = require("libxmljs"),
    logger = require('util'),
    fs = require('fs'),
    sets = require('simplesets');

logger.log("Starting chat model generator!");

var filename = process.argv[2];
logger.log("Loading file: " + filename);


var chatlogXml = fs.readFileSync(filename, 'utf-8');
var logDoc = libxml.parseXmlString(chatlogXml);

var namesSet = new sets.Set([]);
var nameNodes = logDoc.find("//envelope/sender");
for(var nameNodeIndex in nameNodes) {
    var nameNode = nameNodes[nameNodeIndex];
    
    namesSet.add(nameNode.text());
}

logger.log("names set: ");
console.log("names set: ", namesSet.array());

var messageNodes = logDoc.find("//envelope/message");
var model = {};
for(var messageNodeIndex in messageNodes) {
    var messageNode = messageNodes[messageNodeIndex];
    
    // if you put punctuation in here, it'll turn out unpunctuated sentences.
    // if you leave it in, it generates more specific results but probably
    // limits its diversity of production. try it both ways.
    var words = messageNode.text().split(/[\s]+/);
    
    // assuming 2-grams for now.
    for(var i=0; i<words.length-1; i++) {
        // loop through all the words with a two word window.
        var curWords = words[i] + " " + words[i+1];
        
        var subsequentWords = {}
        if(curWords in model) {
            var subsequentWords = model[curWords];
        }
        
        var score = 0;
        if(words[i+2] in subsequentWords) {
            score = subsequentWords[words[i+2]];
        }
        score++;
        subsequentWords[words[i+2]] = score;
        model[curWords] = subsequentWords;
    }
}

// now normalize the model.

var normalizedModel = {}
for(var words in model) {
    var followingWords = model[words];
    
    console.log("processing '" + words + "'");
    var totalOptions = 0.0;
    for(var followingWord in followingWords) {
        var followingWordCount = followingWords[followingWord];
        
        totalOptions = totalOptions+followingWordCount;
        console.log("\t" + followingWord + ": " + followingWordCount + "("+totalOptions + ")");
    }
        
    
    var normalizedFollowingWords = [];
    var cumulativeProb = 0.0;
    for(var followingWord in followingWords) {
        cumulativeProb += (followingWords[followingWord]+0.0) / totalOptions;
        normalizedFollowingWords.push({"word":followingWord, "prob":cumulativeProb});
    }
    
    normalizedModel[words] = normalizedFollowingWords;
}




