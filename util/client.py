#!/usr/bin/env python
# encoding: utf-8
"""
client.py

Based heavily on:
 - https://github.com/mtah/python-websocket/blob/master/examples/echo.py
 - http://stackoverflow.com/a/7586302/316044

Created by Drew Harry on 2011-11-28.
Copyright (c) 2011 MIT Media Lab. All rights reserved.
"""

import websocket, httplib, sys, asyncore, json, threading, traceback, time

'''
    connect to the socketio server

    1. perform the HTTP handshake
    2. open a websocket connection '''
    
    
class Client(object):
    
    DISCONNECTED = 0
    CONNECTED = 1
    IDENTIFIED = 2
    JOINED_ROOM = 3
    
    def __init__(self, server, port):
    
        conn  = httplib.HTTPConnection(server + ":" + str(port))
        conn.request('POST','/socket.io/1/')
        resp  = conn.getresponse() 
        hskey = resp.read().split(':')[0]

        print(" got hskey: " + hskey)

        self.ws = websocket.WebSocket(
                        'ws://'+server+':'+str(port)+'/socket.io/1/websocket/'+hskey,
                        onopen   = self._onopen,
                        onmessage = self._onmessage,
                        onclose = self._onclose,
                        onerror = self._onerror)
        self.state = self.DISCONNECTED

    def _onopen(self):
        self.state = self.CONNECTED
        
        print(str(id(self)) + " opened")
    
        # send identify message. we're not going to be a full client here, so just
        # phone it in.
        
        self.ws.send('5:::{"name":"identify", "args":[{"username":"user-'+str(id(self))+'"}]}')
    
    def _onmessage(self, msg):
        # print(str(id(self)) + ": " + msg)
        if(msg[0]=="5"):
            payload = json.loads(msg.lstrip('5:'))
        
            if(self.state == self.CONNECTED):
                if(payload["name"]=="identify"):
                    # server has acknowledged identification. join a room.
                    self.state = self.IDENTIFIED
                    
                    self.ws.send('5:::{"name":"room", "args":[{"name":"General Chat 1"}]}')
                    # this command is not acknowledge from the server, so we just assume
                    # it worked okay.
                    
                    self.state = self.JOINED_ROOM
                    
                    self.heartbeat()
            elif(self.state == self.JOINED_ROOM):
                pass
                # print(str(id(self)) + ": " + payload["name"])
        

    def _onclose(self):
        print(str(id(self)) + " closed")
    
    def _onerror(self, t, e, trace):
        traceback.print_tb(trace)
        print(str(id(self)) + " ERR: " + str(e) + "; " + str(t))
    
    def close(self):
        self.ws.close()
        self.state = self.DISCONNECTED
        
    def heartbeat(self):
        if(self.state!=self.DISCONNECTED):
            threading.Timer(15.0, self.heartbeat).start()
            self.ws.send('2:::')
            # print(str(id(self)) + "-heartbeat")
        


clients = []

if __name__ == '__main__':
    if len(sys.argv) != 4:
        sys.stderr.write('usage: python client.py <server> <port> <num-clients>\n')
        sys.exit(1)
    
    server = sys.argv[1]
    port = int(sys.argv[2])
    num_clients = int(sys.argv[3])
    
    print("connecting to: %s:%d x%d" %(server, port, num_clients))
    
    for index in range(0, num_clients):
        client = Client(server, port)
        clients.append(client)
        # time.sleep(0.01)
    
    try:
        asyncore.loop()
    except KeyboardInterrupt:
        print("Closing all connections...")
        for client in clients:
            client.close()
    
    


