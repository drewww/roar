#!/usr/bin/env python
# encoding: utf-8
"""
client.py

Created by Drew Harry on 2011-11-28.
Copyright (c) 2011 MIT Media Lab. All rights reserved.
"""

import websocket, httplib, sys, asyncore



'''
    connect to the socketio server

    1. perform the HTTP handshake
    2. open a websocket connection '''
def connect(server, port):
    
    print("connecting to: %s:%d x%d" %(server, port, num_clients))
    
    conn  = httplib.HTTPConnection(server + ":" + str(port))
    conn.request('POST','/socket.io/1/')
    resp  = conn.getresponse() 
    hskey = resp.read().split(':')[0]

    _ws = websocket.WebSocket(
                    'ws://'+server+':'+str(port)+'/socket.io/1/websocket/'+hskey,
                    onopen   = _onopen,
                    onmessage = _onmessage,
                    onclose = _onclose)
    

def _onopen():
    print("opened!")

def _onmessage(msg):
    print("msg: " + str(msg))

def _onclose():
    print("closed!")


if __name__ == '__main__':
    if len(sys.argv) != 4:
        sys.stderr.write('usage: python client.py <server> <port> <num-clients>\n')
        sys.exit(1)
    
    server = sys.argv[1]
    port = int(sys.argv[2])
    num_clients = int(sys.argv[3])
    
    connect(server, port)
    
    try:
        asyncore.loop()
    except KeyboardInterrupt:
        ws.close()
    
    


