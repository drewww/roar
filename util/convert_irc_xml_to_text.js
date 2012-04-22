// This script reads a Colloquey IRC chat log and generates a markov chat
// model based on it, which can be easily deployed on the ROAR server-side.

var libxml = require("libxmljs"),
    logger = require('util'),
    fs = require('fs'),
    sets = require('simplesets'),
    _ = require('underscore')._,
    program = require('commander')
    ;


program.version('0.1')
    .parse(process.argv);


if(program.args.length==1) {
    
    console.log("Loading chat logs...");

    var chatlogXml = fs.readFileSync(program.args[0], 'utf-8');
    var logDoc = libxml.parseXmlString(chatlogXml);
    
    // var messageNodes = logDoc.find("//envelope/message");
    
    
    var envelopeNodes = logDoc.find("//envelope");
    
    console.log("num envelopes: " + envelopeNodes.length);
    
    var messagesToWrite = [];
    
    for(var i in envelopeNodes) {
        var envelopeNode = envelopeNodes[i];
        
        // console.log("envelopeNode.childNodes(): "+ envelopeNode.childNodes());
        var senderNode = envelopeNode.get("sender");
        var messageNode = envelopeNode.get("message");
        
        var datetime = new Date(messageNode.attr("received").value());
        
        var messageText = messageNode.text();
        messageText = messageText.replace(/\n\r/g, " ");
        
        console.log("text: " + messageText);
        
        messagesToWrite.push(datetime.getHours() + ":" + datetime.getMinutes() + " < " + senderNode.text() + "> " + messageText);
    }
    
    fs.writeFileSync("out.log", messagesToWrite.join("\n"))
    
} else {
    console.log("need a file name to process")
}