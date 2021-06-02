/**
 *  apiResponder.js; Handles responses to API requests for MochiMap
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

/* full node ipv4 check */
if (typeof process.env.FULLNODE === 'undefined') {
  console.warn('// WARNING: Mochimo full node ipv4 is undefined');
  console.warn('// Balance requests produce unexpected results...');
}

const { isPrivateIPv4 } = require('./apiUtils');
const Interpreter = require('./apiInterpreter');
const Db = require('./apiDatabase');
const Mochimo = require('mochimo');

const expandResults = async (cursor, options, start) => {
  const dbquery = { duration: null, found: await cursor.count() };
  if (options.limit) { // update number of pages in results
    dbquery.pages = Math.ceil(dbquery.found / options.limit);
  } // apply cursor array to results and update duration stat
  dbquery.results = await cursor.toArray();
  dbquery.duration = Date.now() - start;
  return dbquery;
};

const Responder = {
  _respond: (res, statusCode, json, statusMessage = false) => {
    if (!statusMessage) {
      switch (statusCode) {
        case 200: statusMessage = 'OK'; break;
        case 400: statusMessage = 'Bad Request'; break;
        case 404: statusMessage = 'Not Found'; break;
        case 409: statusMessage = 'Conflict'; break;
        case 500: statusMessage = 'Internal Server Error'; break;
        default: statusMessage = '';
      }
    }
    // assign error and message properties if required
    if (statusCode > 299 && !json.error) {
      json = Object.assign({ error: statusMessage }, json);
    }
    // process response headers
    const body = JSON.stringify(json, null, 2) || '';
    const headers = {
      'X-Robots-Tag': 'none',
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      'Access-Control-Allow-Origin': '*'
    };
    // send response
    res.writeHead(statusCode, statusMessage, headers);
    res.end(body);
  },
  block: async (res, blockNumber) => {
    try {
      // convert blockNumber parameter to Long number type
      const bnum = Db.util.long(blockNumber);
      // perform block query
      const block = await Db.findOne('block', { bnum });
      // send successfull query or 404
      return Responder._respond(res, block ? 200 : 404, block ||
        { message: `${blockNumber} could not be found...` });
    } catch (error) { Responder.unknownInternal(res, error); }
  },
  ledger: async (res, addressType, address) => {
    try {
      // perform balance request
      const isTag = Boolean(addressType === 'tag');
      const le = await Mochimo.getBalance(process.env.FULLNODE, address, isTag);
      // send successfull query or 404
      return Responder._respond(res, le ? 200 : 404, le ||
        { message: `${isTag ? 'tag' : 'wots+'} not found in ledger...` });
    } catch (error) { Responder.unknownInternal(res, error); }
  },
  ledgerHistory: async (res, tag, params) => {
    const start = Date.now();
    let cursor;
    try {
      // set defaults and interpret requested search params
      const search = { query: { tag }, options: {} };
      if (params) Object.assign(search, Interpreter.search(params, true));
      // query database for results
      cursor = await Db.find('ledger', search.query, search.options);
      const dbquery = await expandResults(cursor, search.options, start);
      // send succesfull query or 404
      if (dbquery.results.length) Responder._respond(res, 200, dbquery);
      else Responder._respond(res, 404, dbquery, 'No results');
    } catch (error) { // send 500 on internal error
      Responder.unknownInternal(res, error);
    } finally { // cleanup cursor
      if (cursor && !cursor.isClosed()) await cursor.close();
    }
  },
  network: async (res, ip) => {
    try {
      // check IPv4 for private formats
      if (isPrivateIPv4(ip)) {
        const error = 'Invalid IPv4 address';
        const message = 'private Iv4 addresses are not supported';
        return Responder._respond(res, 400, { error, message });
      }
      // perform network query
      const node = await Db.findOne('network', { host: { ip } });
      // send successfull query or 404
      return Responder._respond(res, node ? 200 : 404, node ||
        { message: `${ip} could not be found...` });
    } catch (error) { Responder.unknownInternal(res, error); }
  },
  search: async (cName, paged, res, ...args) => {
    const start = Date.now();
    let cursor;
    try {
      // set defaults and interpret requested search params as necessary
      const search = { query: {}, options: {} };
      Object.assign(search, Interpreter.search(args[0], paged));
      // query database for results
      cursor = await Db.find(cName, search.query, search.options);
      const dbquery = await expandResults(cursor, search.options, start);
      // send succesfull query or 404
      if (dbquery.results.length) Responder._respond(res, 200, dbquery);
      else Responder._respond(res, 404, dbquery, 'No results');
    } catch (error) { // send 500 on internal error
      Responder.unknownInternal(res, error);
    } finally { // cleanup cursor
      if (cursor && !cursor.isClosed()) await cursor.close();
    }
  },
  searchBlock: (...args) => Responder.search('block', 1, ...args),
  searchNetwork: (...args) => Responder.search('network', 0, ...args),
  searchTransaction: (...args) => Responder.search('transaction', 1, ...args),
  transaction: async (res, txid) => {
    try {
      // perform transaction query
      const transaction = await Db.findOne('transaction', { txid });
      // send successfull query or 404
      return Responder._respond(res, transaction ? 200 : 404, transaction ||
        { message: `${txid} could not be found...` });
    } catch (error) { Responder.unknownInternal(res, error); }
  },
  transactionHistory: async (res, address, params) => {
    const start = Date.now();
    let cursor;
    try {
      // build USVString query from address
      const query = (params ? params + '&' : '') + 'history=' + address;
      // set defaults and interpret requested search params, from USVString
      const search = { query: {}, options: {} };
      Object.assign(search, Interpreter.search(query, true));
      // query database for results
      cursor = await Db.find('history', search.query, search.options);
      const dbquery = await expandResults(cursor, search.options, start);
      // send succesfull query or 404
      if (dbquery.results.length) Responder._respond(res, 200, dbquery);
      else Responder._respond(res, 404, dbquery, 'No results');
    } catch (error) { // send 500 on internal error
      Responder.unknownInternal(res, error);
    } finally { // cleanup cursor
      if (cursor && !cursor.isClosed()) await cursor.close();
    }
  },
  unknown: (res, code = 404, json = {}) => Responder._respond(res, code, json),
  unknownInternal: (res, error) => {
    // log error and send alert response
    console.trace(error);
    const date = new Date();
    Responder.unknown(res, 500, {
      message: 'please consider opening a issue detailing this error @ ' +
        'https://github.com/chrisdigity/mochimap.com/issues',
      timestamp: date.toISOString()
    });
  }
};

module.exports = Responder;
