#!/usr/bin/env node
/**
 *  MochiMap   Realtime network analysis for the Mochimo Cryptocurrency Network
 *  Copyright (C) 2021  Chrisdigity
 *
 *  This program is free software: you can redistribute it and/or modify
 *  it under the terms of the GNU Affero General Public License as published
 *  by the Free Software Foundation, either version 3 of the License, or
 *  (at your option) any later version.
 *
 *  This program is distributed in the hope that it will be useful,
 *  but WITHOUT ANY WARRANTY; without even the implied warranty of
 *  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *  GNU Affero General Public License for more details.
 *
 *  You should have received a copy of the GNU Affero General Public License
 *  along with this program.  If not, see <https://www.gnu.org/licenses/>.
 *
 */

/* global BigInt */
/* eslint no-extend-native: ["error", { "exceptions": ["BigInt"] }] */
// reference: https://medium.com/@vitalytomilov/reversible-bigint-serialization-8cba9deefad7
BigInt.prototype.toJSON = () => `${this.toString()}n`;
BigInt.reviver = (_, value) => {
  if (typeof value === 'string') {
    const m = value.match(/(-?\d+)n/);
    if (m && m[0] === value) {
      value = BigInt(m[1]);
    }
  }
  return value;
};

/* environment */
console.log('\nLoad env.<variables>...');
require('dotenv').config();
[
  'CAPTCHA_SECRET',
  // 'IPINFO_TOKEN',
  // 'DISCORD_WEBHOOK',
  'PEXELS_SECRET',
  'UNSPLASH_SECRET',
  'UNSPLASH_ACCESS'
].forEach((data, index) => {
  /* check environment variables exist */
  if (!process.env[data]) {
    console.error(`MochiMap is missing process.env.${data}#${index}`);
    process.exit(1);
  }
});

/* requirements */
console.log('Load required modules...');
// core
const os = require('os');
const fs = require('fs');
const fsp = fs.promises;
const net = require('net');
const path = require('path');
const https = require('https');
// const crypto = require('crypto');
const querystring = require('querystring');
const { promisify } = require('util');
// first-party
// Archive will remain hidden due to security concerns...
const Archive = require('./.maparchive');
// third-party
const Mochimo = require('mochimo');
const SocketIO = require('socket.io')();

/* error types */
console.log('Define error types...');
class ServerError extends Error {
  constructor (message) {
    super(message);
    this.name = 'ServerError';
  }
}

/* (pre)promisification */
console.log('Define promisification...');
https.get[promisify.custom] = function getAsync (options) {
  return new Promise((resolve, reject) => {
    https.get(options, response => {
      let body = '';
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (error) { resolve(body); }
      });
    }).on('error', reject);
  });
};
const promiseGet = promisify(https.get); // returns JSON Object || string

/* functions */
console.log('Define utilities...'); /*
const compareWeight = (weight1, weight2) => {
  // ensure both strings are equal length
  const maxLen = Math.max(weight1.length, weight2.length);
  weight1 = weight1.padStart(maxLen, '0');
  weight2 = weight2.padStart(maxLen, '0');
  // return 1 (a > b), -1 (a < b) or 0 (a == b)
  if (weight1 > weight2) return 1;
  if (weight1 < weight2) return -1;
  return 0;
}; */
const parseNetworkdata = (data, jsonType) => {
  // read *.json type data directly, else assume peerlist
  if (jsonType) {
    Object.entries(data).forEach(([ip, node]) => {
      if (net.isIPv4(ip)) Network.map.set(ip, node);
    });
  } else {
    (data.match(/(^|(?<=\n))[\w.]+/g) || []).forEach(ip => {
      if (net.isIPv4(ip)) {
        Network.map.set(ip, new Mochimo.Node({ ip }).toJSON());
      }
    });
  }
};
const isPrivateIPv4 = (ip) => {
  const b = new ArrayBuffer(4);
  const c = new Uint8Array(b);
  const dv = new DataView(b);
  if (typeof ip === 'number') dv.setUint32(0, ip, true);
  if (typeof ip === 'string') {
    const a = ip.split('.');
    for (let i = 0; i < 4; i++) dv.setUint8(i, a[i]);
  }
  if (c[0] === 0 || c[0] === 127 || c[0] === 10) return 1; // class A
  if (c[0] === 172 && (c[1] & 0xff) >= 16 && (c[1] & 0xff) <= 31) {
    return 2; // class B
  }
  if (c[0] === 192 && (c[1] & 0xff) === 168) return 3; // class C
  if (c[0] === 169 && (c[1] & 0xff) === 254) return 4; // auto
  return 0; // public IP
};
const gracefulShutdown = (code) => {
  console.log('\nSHUTDOWN: Received', code);
  // clear timers
  while (Timers.length) clearInterval(Timers.pop());
  // close server and/or exit
  if (Server.http) {
    // initiate server shutdown
    Server.https.close(() => {
      console.log('Server closed... shutdown completed succesfully!\n');
      process.exit(code);
    });
    // destroy remaining sockets
    Server.sockets.forEach(socket => socket.destroy());
  } else {
    console.log('Nothing to finish... shutdown completed succesfully!\n');
    process.exit(code);
  }
};

/* pre-core */
// const GENESIS_HASH =
//   '00170c6711b9dc3ca746c46cc281bc69e303dfad2f333ba397ba061eccefde03';
const SET_LIMIT = 0xff;
const Timers = [];

/* core */
console.log('Define core...');
const Auxiliary = {
  // auxiliary blockchain data
  // Haiku (expanded), Visualized Haiku URL (picture), ...
  current: null,
  get: async (bnum, bhash) => {
    // if request is NOT specific, return current Auxiliary data
    if (!bnum && !bhash && Auxiliary.current) return Auxiliary.current;
    // build file query and search
    const query = Archive.file.ax(bnum || '*', bhash || '*');
    const results = await Archive.search.ax(query);
    // handle results, if any
    if (results.length) {
      let data;
      do {
        try {
          // read (next) latest data as JSON
          data = JSON.parse(await Archive.read.ax(results.pop()));
        } catch (ignore) {}
      } while (results.length && !data);
      return data || null;
    } else return null;
  },
  getHaiku: async (bnum, bhash) => {
    // return haiku data or null, depending on results
    const results = await Auxiliary.get(bnum, bhash);
    if (results.haiku) return results.haiku;
    return null;
  },
  update: async (block, checkback, file, now = Date.now()) => {
    const shadow = Boolean(checkback);
    // define filepath if undefined
    file = file || Archive.file.ax(block.bnum, block.bhash);
    // derive origin block number
    const ogbnum = BigInt('0x' + file.split('.')[0]).toString();
    // if checkback on normal block, reduce checkback
    if (checkback > 0 && block.type === Mochimo.Block.NORMAL) checkback--;
    // check block type is normal
    if (checkback > 0 || block.type !== Mochimo.Block.NORMAL) {
      // increase checkback and start again with previous block
      checkback++;
      const prev = Archive.file.bc(block.bnum - 1n, block.phash);
      const raw = await Archive.read.bc(prev);
      // check block data and retry...
      if (!raw) console.log(`Could not process ${file} at this time...`);
      else await Auxiliary.update(new Mochimo.Block(raw), checkback, file, now);
    } else {
      // heuristically determine best picture query for haiku
      const haikuStr = Mochimo.Trigg.expand(block.nonce, shadow);
      const search = haikuStr.match(/((?<=[ ]))\w+((?=\n)|(?=\W+\n)|(?=\s$))/g);
      const query = search.join('%20');
      // build Pexels query request and get results
      let pexels;
      try {
        pexels = await promiseGet({
          hostname: 'api.pexels.com',
          path: `/v1/search?query=${query}&per_page=80`,
          headers: { Authorization: process.env.PEXELS_SECRET }
        });
        if (pexels.error) throw new Error(pexels.error);
      } catch (error) {
        console.trace(`Pexels request for ${file} gave`, error);
      }
      // check results exist
      if (!pexels || pexels.error) {
        console.log(`Could not process ${file} at this time...`);
      } else {
        // process results
        let pi, ps, is;
        const ts = haikuStr.match(/\b\w{3,}\b/g);
        for (let i = pi = ps = is = 0; i < pexels.photos.length; i++, is = 0) {
          ts.forEach(t => {
            is += (pexels.photos[i].url.match(new RegExp(t, 'g')) || []).length;
          });
          if (is > ps) { ps = is; pi = i; }
        }
        const photo = pexels.photos[pi];
        const json = {
          haiku: {
            num: ogbnum,
            str: haikuStr,
            img: {
              author: photo.photographer,
              authorurl: photo.photographer_url,
              desc: photo.url.match(/\w+(?=-)/g).join(' '),
              src: photo.src.original,
              srcid: 'Pexels',
              srcurl: photo.url
            }
          }
        };
        // update current data
        Auxiliary.current = json;
        // post data to archive
        fsp.mkdtemp(path.join(os.tmpdir(), 'ax-'))
          .then(async tmp => {
            tmp += path.sep;
            await fsp.writeFile(tmp + file, JSON.stringify(json));
            return tmp;
          }).then(Archive.post.ax).then(num => {
            const time = (Date.now() - now) / 1000;
            console.log(`${ogbnum} Archived ${num} *.ax in ${time} seconds.`);
          }).catch(error => {
            console.error(`${ogbnum}: ax archive failure. ${error}`);
          });
      }
    }
  }
}; // end const Auxiliary...
const Block = {
  cache: new Set(),
  chain: new Map(),
  current: null,
  check: async (peer, bnum, bhash) => {
    // check recent blockchain
    if (!Block.cache.has(bhash)) {
      // add bhash to recent
      Block.cache.add(bhash);
      // manage recent list
      if (Block.cache.size > SET_LIMIT) {
        Block.cache.delete(Block.cache.values().next().value);
      }
      // check database for bnum/bhash
      if (!(await Archive.search.bc(Archive.file.bc(bnum, bhash))).length) {
        Block.download(peer, bnum, bhash)
          .then(Block.update).catch(console.error);
      }
    }
  },
  download: async (peer, bnum, bhash) => {
    // download block from advertising peer
    const block = await Mochimo.getBlock(peer, bnum);
    // check block is as advertised
    if (block.bnum !== bnum) {
      throw Error(`req'd block ${bnum} from ${peer}, got ${bnum}`);
    } else if (block.bhash !== bhash) {
      throw Error(`req'd block ${bnum}/${bhash.slice(0, 8)}~ from ${peer}, ` +
                  `got ${block.bnum}/${block.bhash.slice(0, 8)}~`);
    } else if (block.type === Mochimo.Block.INVALID) {
      throw Error(`req'd block ${bnum}/${bhash.slice(0, 8)}~ from ${peer}, ` +
                  'got invalid');
    }
    // initiate check for any previous blocks
    Block.check(peer, block.bnum - 1n, block.phash);
    // return block data for chaining
    return block;
  },
  get: async (bnum, bhash) => {
    // if request is NOT specific, return current Auxiliary data
    if (!bnum && !bhash && Block.current) return Block.current;
    // build file query and search
    const query = Archive.file.bc(bnum || '*', bhash || '*');
    const results = await Archive.search.bc(query);
    // handle results, if any
    if (results.length) {
      let block;
      do {
        try {
          // read (next) latest data as JSON
          block = new Mochimo.Block(await Archive.read.bc(results.shift()));
        } catch (ignore) {}
      } while (results.length && !block);
      return block || null;
    } else return null;
  },
  update: async (block) => {
    const now = Date.now();
    // initiate asynchronous auxiliary block update
    Auxiliary.update(block).catch(console.error);
    // update current block
    Block.current = block;
    // handle block update
    const filebc = Archive.file.bc(block.bnum, block.bhash);
    fsp.mkdtemp(path.join(os.tmpdir(), 'bc-'))
      .then(async tmp => {
        tmp += path.sep;
        await fsp.writeFile(tmp + filebc, Buffer.from(block.buffer));
        return tmp;
      }).then(Archive.post.bc).then(num => {
        const time = (Date.now() - now) / 1000;
        console.log(`${block.bnum} Archived ${num} *.bc in ${time} seconds.`);
      }).catch(error => {
        console.error(`${block.bnum}: bc archive failure. ${error}`);
      });
    // handle transaction updates
    fsp.mkdtemp(path.join(os.tmpdir(), 'tx-'))
      .then(async tmp => {
        tmp += path.sep;
        await Promise.allSettled(block.transactions.map(async txe => {
          const addr = txe.srctag || txe.srcaddr;
          const buffer = Buffer.from(txe.toReference().buffer);
          const file = Archive.file.tx(addr, txe.txid, block.bnum, block.bhash);
          return await fsp.writeFile(tmp + file, buffer);
        }));
        return tmp;
      }).then(Archive.post.tx).then(num => {
        const time = (Date.now() - now) / 1000;
        console.log(`${block.bnum} Archived ${num} *.tx in ${time} seconds.`);
      });
    // return block data for promise chaining
    return block;
  }
}; // end const Block...
const Network = {
  interval: 1000,
  fallback: [
    'https://mochimo.org/startnodes.lst',
    'https://www.mochimap.net/startnodes.lst',
    './startnodes.lst',
    './networkdata.json'
  ],
  map: new Map(),
  checkPeer: (ip) => {
    // ignore private or existing IPv4
    if (isPrivateIPv4(ip) || Network.map.has(ip)) return;
    // initialize new node
    Network.updateMap(new Mochimo.Node({ ip }));
  },
  updateMap: (node, ip) => {
    const updateInterval = 30000; // 30 seconds between node updates
    const updateOffset = Date.now() - updateInterval;
    // if `ip` exists (ie. from Network.map.forEach), check update interval
    if (typeof ip === 'undefined') {
      // convert node to relevant JSON data
      node = node.toJSON();
      ip = node.ip;
      // update Network map, merging any existing data
      Network.map.set(ip, Object.assign(Network.map.get(ip) || {}, node));
      // check for peer updates
      if (node.peers && node.peers.length) {
        node.peers.forEach(Network.checkPeer);
      }
      // initiate asynchronouse check for block
      if (node.cblockhash) Block.check(ip, node.cblock, node.cblockhash);
      // broadcast node update to the 'network' room
      Server.broadcast('network', 'updateNodeFull', node);
    } else if (node.lastTouch < updateOffset) {
      // update lastPing before next update check
      node.lastTouch = Date.now();
      // request peerlist
      Mochimo.Node.callserver({ ip, opcode: Mochimo.OP_GETIPL })
        .then(Network.updateMap).catch(console.error);
    }
  },
  run: () => Network.map.forEach(Network.updateMap),
  start: async () => {
    console.log('Loading network data...');
    // prioritise network data acquisition:
    //   (database -> fallback(jsondata/peerlist)) ...
    try {
      const fname = Archive.file.nt('', 'last');
      await parseNetworkdata(await Archive.read.nt(fname), 1);
      console.log(' + Successfully loaded last network data from Archive');
    } catch (error) { console.error(` - ${error}`); }
    // utilise fallback methods on absence of database
    while (!Network.map.size) {
      // check for fallback failure
      if (!Network.fallback.length) {
        console.error('\nNetwork initialization failed! Retry in 60sec...');
        setTimeout(Network.start, 60000);
        return;
      }
      const fallback = Network.fallback.pop();
      const jsonType = Boolean(fallback.endsWith('.json'));
      try {
        // obtain and parse fallback data, type dependant
        if (fallback.startsWith('http')) {
          parseNetworkdata(await promiseGet(fallback), jsonType);
        } else parseNetworkdata(await fsp.readFile(fallback), jsonType);
        console.log(' + Success loading from', fallback);
      } catch (error) { console.error(` - ${error}`); }
    }
    // start run/backup loop
    console.log('Begin network scanning...');
    Timers.push(setInterval(Network.run, Network.interval));
  } // end start: async () => ...
}; // end const Network...
const Server = {
  https: null,
  io: null,
  sockets: new Set(),
  start: () => new Promise((resolve, reject) => {
    console.log('Start server');
    // create https server
    Server.https = https.createServer({
      key: fs.readFileSync('/etc/ssl/private/io.mochimap.com.key'),
      cert: fs.readFileSync('/etc/ssl/certs/io.mochimap.com.pem')
    }).on('listening', () => {
      const addr = Server.https.address();
      console.log(` + listening on ${addr.address} : ${addr.port}`);
      resolve();
    }).on('error', reject);
    // create socket connection options
    const socketioOpts = {
      pingInterval: 10000,
      pingTimeout: 5000,
      cookie: false,
      cors: {
        origin: 'https://www.mochimap.com',
        credentials: true
      }
    };
    // setup authentication and connection protocols and attach to server
    SocketIO.use((socket, next) => {
      // token is required
      if (socket.handshake.auth && socket.handshake.auth.token) {
        const token = socket.handshake.auth.token;
        // build POST request
        var postData = querystring.encode({
          secret: process.env.CAPTCHA_SECRET,
          response: token
        });
        // build request options
        const options = {
          hostname: 'recaptcha.net',
          path: '/recaptcha/api/siteverify',
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(postData)
          }
        };
        // check authorization token against Google's reCaptcha
        var req = https.request(options, res => {
          var body = '';
          res.on('data', chunk => {
            body += chunk;
          });
          res.on('end', () => {
            body = JSON.parse(body);
            // Simple verification for now...
            if (!body) next(new Error('Server authentication failure'));
            else if (!body.success) next(new Error('Authentication failure'));
            // successful authentication
            else next();
          });
        });
        req.on('error', error => {
          console.error('[reCAPTCHA Request]', error);
          next(new Error('Server authentication error'));
        });
        req.write(postData);
        req.end();
      } else next(new Error('Missing authentication token.'));
    });
    SocketIO.on('connection', (socket) => {
      // add socket to socket management list
      Server.sockets.add(socket);
      // allocate requested connection room, if any
      switch (socket.handshake.query.room) {
        case 'network': socket.join('network'); break;
        case 'explorer': socket.join('explorer'); break;
        case 'haiku': socket.join('haiku'); break;
      }
      socket.on('close', () => Server.sockets.delete(socket));
      /*
      socket.on('blocks', async (page, perpage) => {
        try {
          socket.emit('blocks', await Block.getSummary(page, perpage));
        } catch (error) {
          socket.emit('error',
            new ServerError(`during blocks.p${page} request`));
        }
      });
      */
      socket.on('block', async (bnum, bhash) => {
        if (typeof bnum !== 'bigint' && typeof bnum !== 'number') {
          return socket.emit('error', new TypeError('invalid bnum type'));
        }
        if (typeof bnum !== 'string') {
          return socket.emit('error', new TypeError('invalid bhash type'));
        }
        try {
          socket.emit('block', await Block.get(bnum));
        } catch (error) {
          socket.emit('error', new ServerError(`during block#${bnum} request`));
        }
      });
      // legacy io
      socket.on('/haiku', async (bnum) => {
        try {
          socket.emit('/haiku', await Auxiliary.getHaiku(bnum));
        } catch (error) {
          socket.emit('error', new ServerError(`during haiku#${bnum} request`));
        }
      });
    });
    SocketIO.attach(Server.https, socketioOpts);
    // start https server
    Server.https.listen(2053, '0.0.0.0');
    // server is ready for data transmission
    Server.io = SocketIO;
  }),
  broadcast: (room, type, data) => {
    // check Server.io is ready for broadcasts before calling
    if (Server.io) Server.io.to(room).emit(type, data);
  }
};

/* cleanup */
console.log('Configure cleanup...');
process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);
process.on('uncaughtException', (err, origin) => {
  console.error(origin, err);
  gracefulShutdown();
});

/**
 * check archive, and start server and network communications */
Archive.check().then(Server.start).then(Network.start).catch(error => {
  console.error(error);
  gracefulShutdown();
});