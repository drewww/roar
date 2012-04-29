import websocket, httplib, sys, asyncore, json, threading, traceback

def _onopen(self):
    self.state = self.CONNECTED
    
    print(" opened")

    # send identify message. we're not going to be a full client here, so just
    # phone it in.
    
    # self.ws.send('5:::{"name":"identify", "args":[{"username":"user-'+str(id(self))+'"}]}')

def _onmessage(self, msg):
    print("msg: " + msg)
    pass
    # if(msg[0]=="5"):
    #     payload = json.loads(msg.lstrip('5:'))
    # 
    #     if(self.state == self.CONNECTED):
    #         if(payload["name"]=="identify"):
    #             # server has acknowledged identification. join a room.
    #             self.state = self.IDENTIFIED
    #             
    #             self.ws.send('5:::{"name":"room", "args":[{"name":"General Chat 1"}]}')
    #             # this command is not acknowledge from the server, so we just assume
    #             # it worked okay.
    #             
    #             self.state = self.JOINED_ROOM
    #             
    #             # self.heartbeat()
    #     elif(self.state == self.JOINED_ROOM):
    #         pass
    #         # print(str(id(self)) + ": " + payload["name"])
    

def _onclose(self):
    print("closed")

def _onerror(self, e):
    print("ERR: " + e)



conn  = httplib.HTTPConnection("localhost:8888")
conn.request('POST','/socket.io/1/')
resp  = conn.getresponse() 
hskey = resp.read().split(':')[0]

print(" got hskey: " + hskey)

ws = websocket.WebSocketApp(
                'ws://localhost:8888/socket.io/1/websocket/'+hskey,
#                        on_open   = self._onopen,
                on_message = _onmessage,
                on_close = _onclose,
                on_error = _onerror)
ws.on_open = _onopen

ws.run_forever()

