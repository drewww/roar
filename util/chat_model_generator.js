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

    // For each message, grab a special case for initial conditions. We need
    // a separate probability chart for which 2-grams start utterances. So
    // for each message always grab the first two words (or one word if thats
    // all there is) and put it in the empty string value.
    var subsequentWords = {};
    if(words.length==1) {
        model = addWordInstanceToModel("", words[0], model);
    } else {
        model = addWordInstanceToModel("", words[0] + " " + words[1], model);
    }
    
    // assuming 2-grams for now.
    for(var i=0; i<words.length-1; i++) {
        // loop through all the words with a two word window.
        var curWords = words[i] + " " + words[i+1];
        
        model = addWordInstanceToModel(curWords, words[i+2], model);
    }
}

// now normalize the model.

var normalizedModel = {}
for(var words in model) {
    var followingWords = model[words];
    
    // console.log("processing '" + words + "'");
    var totalOptions = 0.0;
    for(var followingWord in followingWords) {
        var followingWordCount = followingWords[followingWord];
        
        totalOptions = totalOptions+followingWordCount;
        // console.log("\t" + followingWord + ": " + followingWordCount + "("+totalOptions + ")");
    }
        
    
    var normalizedFollowingWords = [];
    var cumulativeProb = 0.0;
    for(var followingWord in followingWords) {
        cumulativeProb += (followingWords[followingWord]+0.0) / totalOptions;
        normalizedFollowingWords.push({"word":followingWord, "prob":cumulativeProb});
    }
    
    normalizedModel[words] = normalizedFollowingWords;
}

model=normalizedModel;

// console.log(model["just like"]);
console.log(generateUtterance());









function addWordInstanceToModel(curWords, followingWord, model) {
    var subsequentWords = {}
    if(curWords in model) {
        var subsequentWords = model[curWords];
    }
    
    var score = 0;
    if(followingWord in subsequentWords) {
        score = subsequentWords[followingWord];
    }
    score++;
    subsequentWords[followingWord] = score;

    model[curWords] = subsequentWords;
    
    return model;
}

function generateUtterance() {
    
    var utterance = "";
    
    var currentWindowStart = -1;
    while(true) {
        console.log("currentWindowStart=", currentWindowStart);
        
        var wordList;
        if(currentWindowStart==-1) {
            wordList = model[""];
        } else {
            var nextKey=utterance.split(/[\s]+/).slice(currentWindowStart, currentWindowStart+2);
            nextKey = nextKey.join(" ");
            console.log("nextKey=", nextKey);
            wordList = model[nextKey];
        }
        
        console.log("wordlist=",wordList);
        
        var newWord = pickWordFromList(wordList);
        
        if(newWord=='undefined') {
            return utterance;
        }
        
        if(currentWindowStart==-1) {
            utterance = newWord;
        } else {
            utterance = utterance + " " + newWord;
        }
        
        console.log("utterance=",utterance);
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
            console.log("\tpicking: " + word["word"]);
            return word["word"];
        } else {
            prevScore = word["prob"];
            console.log("prevScore=", prevScore);
        }
    }
}
