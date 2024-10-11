#!/usr/bin/env node
const messages = {};
const broadcasts = [];
var fs = require('fs');
const http2 = require('http2');
const {
  HTTP2_HEADER_METHOD,
  HTTP2_HEADER_PATH,
  HTTP2_HEADER_STATUS,
  HTTP2_HEADER_CONTENT_TYPE,
} = http2.constants;
var PORT = 29231;

class ChatRoom {
  constructor() {
    this.init();
    this.onlineUser = {};
  }
  init() {
    var app = http2.createSecureServer({
      allowHTTP1: true,
      key: fs.readFileSync('/etc/letsencrypt/live/cjhb.site/privkey.pem'),
      cert: fs.readFileSync('/etc/letsencrypt/live/cjhb.site/fullchain.pem')
      }, this.router);
    this.io = require('socket.io')(app, {
      cors: {
        origin: "https://cjhb.site",
        methods: ["GET", "POST"]
      }
    });
    app.listen(PORT, function () {
      console.log('run at: https://127.0.0.1:' + PORT);
    });
    this.bindEvent();
  }
  router(clientRequest, clientResponse) {
    if (clientRequest.url.slice(0, 8) === '/avatar/') {
      const serverRequest = http2.connect('https://gravatar.com').request({':path': clientRequest.url});
      serverRequest.on('response', (headers) => {
        clientResponse.writeHead(200,{ 'Content-Type': headers['content-type'] });
        serverRequest.on('data', (chunk) => {
          clientResponse.write(chunk);
        });
        serverRequest.on('end', () => {
          clientResponse.end();
        });
      });
    } else {
      clientResponse.writeHead(404);
      clientResponse.end('404 Not Found');
    }
  }
  bindEvent() {
    var self = this;
    var io = this.io;

    // 新用户
    io.on('connection', function (socket) {
      // 用户与服务器第一次握手，服务器传递信息给客户端
      socket.emit('connected', {
        users: Object.values(self.onlineUser).map(a => [a.userId, a.userName]),
        broadcasts: broadcasts
      });
      // 用户与服务器第二次握手，客户端传递信息给服务器
      socket.on('createUser', function (data) {
        // 用户 userId 作为 session 信息保存在用户客户端
        var userId = data.userId;
        var userName = data.userName;
        if (!self.onlineUser[userId]) {
          // 广播新用户
          socket.broadcast.emit('broadcast', {
            userId: userId,
            userName: userName,
            type: "NEW"
          });
        }
        if (messages[userId]) {
          messages[userId].forEach(message => {
            if (message.type == 'PM') { message.type = 'oldPM'; }
            socket.emit('pm', message);
            if (message.type == 'offlinePM') { message.type = 'oldPM'; }
          });
        }
        socket.userId = userId;
        socket.userName = userName;
        self.onlineUser[userId] = socket;
      });

      // 断开连接
      socket.on('disconnect', function (reason) {
        var userId = socket.userId;
        socket.broadcast.emit('broadcast', {
          userId: userId,
          userName: socket.userName,
          type: "LEAVE",
          reason: reason
        });
        delete self.onlineUser[userId];
      });

      // 群聊，广播信息
      socket.on('gm', function (data) {
        var socket = self.onlineUser[data.userId];
        if ((new TextEncoder().encode(data.msg)).length >= 10 << 10) {
          return socket.emit('pm', {
            msg: 'Detected illegal operation!',
            type: "WARN"
          });
        }
        if (socket) {
          var nowTime = Math.floor(new Date().getTime() / 1000);
          if (socket.lastSpeakTime && nowTime - socket.lastSpeakTime < 3) {
            socket.speakTotalTimes++;
            socket.lastSpeakTime = nowTime;
            return socket.emit('pm', {
              msg: 'Message sending failed, please slow down your speech!',
              type: 'WARN'
            });
          }
          socket.speakTotalTimes++;
          socket.lastSpeakTime = nowTime;
          socket.speakTotalTimes = socket.speakTotalTimes || 0;
        }
        let message = {
          timestamp: Date.now(),
          msg: data.msg,
          userId: data.userId,
          userName: data.userName,
          type: 'BROADCAST'
        };
        data.msg && socket.emit('timestamp', { requestTime: data.requestTime, responseTime: message.timestamp }) && socket.broadcast.emit('broadcast', message) && broadcasts.push(message);
      });

      // 私聊
      socket.on('pm', function (data) {
        if (data.userId.length > 12 || !self.onlineUser[data.userId] || (new TextEncoder().encode(data.msg)).length >= 10 << 10) {
          return socket.emit('pm', {
            msg: 'Detected illegal operation!',
            type: "WARN"
          });
        }
        var toUserId = data.targetId;
        var toSocket = self.onlineUser[toUserId];
        if (!data.msg) return;
        const selfmessage = {
          timestamp: Date.now(),
          msg: data.msg,
          userId: toUserId,
          userName: data.targetName,
          type: "SELF"
        };
        socket.emit('timestamp', { requestTime: data.requestTime, responseTime: selfmessage.timestamp });
        if (messages[data.userId]) {
          messages[data.userId].push(selfmessage);
        } else {
          messages[data.userId] = [selfmessage];
        }
        const message = {
          timestamp: selfmessage.timestamp,
          msg: data.msg,
          userId: data.userId,
          userName: data.userName,
          type: "PM"
        };
        if (toSocket) {
          toSocket.emit('pm', message);
        } else {
          socket.emit('pm', {
            userId: data.targetId,
            userName: data.targetName,
            type: "OFFLINE"
          });
          message.type = "offlinePM";
        }
        if (messages[toUserId]) {
          messages[toUserId].push(message);
        } else {
          messages[toUserId] = [message];
        }
      });
    });
  }
}

new ChatRoom();