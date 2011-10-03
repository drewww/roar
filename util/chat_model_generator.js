// This script reads a Colloquey IRC chat log and generates a markov chat
// model based on it, which can be easily deployed on the ROAR server-side.

var libxml = require("libxmljs"),
    logger = require('util'),
    fs = require('fs');

logger.log("Starting chat model generator!");

var filename = process.argv[2];
logger.log("Loading file: " + filename);


var chatlogXml = fs.readFileSync(filename, 'utf-8');
var logDoc = libxml.parseXmlString(chatlogXml);

