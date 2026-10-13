const { FileSync } = require('./file-sync');
const db = require('../db');
const config = require('../config');
module.exports = new FileSync({ db, secret: config.sessionSecret });
