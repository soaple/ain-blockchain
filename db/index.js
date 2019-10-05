const escapeStringRegexp = require('escape-string-regexp');
const ainUtil = require('@ainblockchain/ain-util');
const ChainUtil = require('../chain-util');
const Transaction = require('./transaction');
const BuiltInFunctions = require('./built-in-functions');
const {OperationTypes, UpdateTypes, PredefinedDbPaths, DEBUG} = require('../constants');

class DB {
  constructor(blockchain) {
    this.db = {};
    this.func = new BuiltInFunctions(this);
    // TODO (lia): Add account importing functionality
    // TODO (lia): Add "address" property and change publicKey to "full public key" value.
    this.keyPair = ChainUtil.genKeyPair();
    this.publicKey = ainUtil.toChecksumAddress(ainUtil.bufferToHex(
        ainUtil.pubToAddress(
            Buffer.from(this.keyPair.getPublic().encode('hex'), 'hex'),
            true
        )
    ));
    if (this instanceof BackUpDB) return;
    this.nonce = this.getNonce(blockchain);
    console.log(`creating new db with id ${this.publicKey}`);
  }

  getNonce(blockchain) {
    // TODO (Chris): Search through all blocks for any previous nonced transaction with current publicKey 
    let nonce = 0;
    for (let i = blockchain.chain.length - 1; i > -1; i--) {
      for (let j = blockchain.chain[i].data.length -1; j > -1; j--) {
        if (blockchain.chain[i].data[j].address == this.publicKey && blockchain.chain[i].data[j].nonce > -1) {
          // If blockchain is being restarted, retreive nocne from blockchain
          nonce = blockchain.chain[i].data[j].nonce + 1;
          break;
        }
      }
      if (nonce > 0) {
        break;
      }
    }
    console.log(`Setting nonce to ${nonce}`);
    return nonce;
  }

  static getDatabase(blockchain, tp) {
    const db = new DB(blockchain);
    blockchain.setBackDb(new BackUpDB(db.keyPair));
    db.reconstruct(blockchain, tp);
    return db;
  }

  writeDatabase(fullPath, value) {
    if (fullPath.length === 0) {
      this.db = value;
    } else if (fullPath.length === 1) {
      this.db[fullPath[0]] = value;
    } else {
      const pathToKey = fullPath.slice().splice(0, fullPath.length - 1);
      const refKey = fullPath[fullPath.length - 1];
      this.getRefForWriting(pathToKey)[refKey] = value;
    }
  }

  readDatabase(fullPath) {
    if (fullPath.length === 0) {
      return this.db;
    }
    let result = this.db;
    try {
      fullPath.forEach(function(key) {
        result = result[key];
      });
    } catch (error) {
      if (error instanceof TypeError) {
        return null;
      }
      throw error;
    }
    return result ? JSON.parse(JSON.stringify(result)) : null;
  }

  // TODO(seo): Migrate to getValue(), getRule(), or getOwner().
  get(dbPath) {
    const parsedPath = ChainUtil.parsePath(dbPath);
    return this.readDatabase(parsedPath);
  }

  getValue(dbPath) {
    const parsedPath = ChainUtil.parsePath(dbPath);
    const fullPath = this.getFullPath(parsedPath, PredefinedDbPaths.VALUES_ROOT);
    return this.readDatabase(fullPath);
  }

  getRule(dbPath) {
    const parsedPath = ChainUtil.parsePath(dbPath);
    const fullPath = this.getFullPath(parsedPath, PredefinedDbPaths.RULES_ROOT);
    return this.readDatabase(fullPath);
  }

  getOwner(dbPath) {
    const parsedPath = ChainUtil.parsePath(dbPath);
    const fullPath = this.getFullPath(parsedPath, PredefinedDbPaths.OWNERS_ROOT);
    return this.readDatabase(fullPath);
  }

  stake(stakeAmount) {
    return this.setValue([PredefinedDbPaths.STAKEHOLDER, this.publicKey].join('/'), stakeAmount);
  }

  // TODO(seo): Add dbPath validity check (e.g. '$', '.', etc).
  // TODO(seo): Make set operation and function run tightly bound, i.e., revert the former
  //            if the latter fails.
  // TODO(seo): Consider adding array to object transforming (see
  //            https://firebase.googleblog.com/2014/04/best-practices-arrays-in-firebase.html).
  // TODO(seo): Consider explicitly defining error code.
  // TODO(seo): Apply full path with VALUES_ROOT.
  setValue(dbPath, value, address, timestamp) {
    const parsedPath = ChainUtil.parsePath(dbPath);
    if (!this.getPermissionForValue(parsedPath, address, timestamp, '.write', value)) {
      return {code: 2, error_message: 'No write_value permission on: ' + dbPath};
    }
    const valueCopy = ChainUtil.isDict(value) ? JSON.parse(JSON.stringify(value)) : value;
    this.writeDatabase(parsedPath, valueCopy);
    this.func.runFunctions(parsedPath, valueCopy);
    return true;
  }

  incValue(dbPath, delta, address, timestamp) {
    const valueBefore = this.get(dbPath);
    if (DEBUG) {
      console.log(`VALUE BEFORE:  ${JSON.stringify(valueBefore)}`);
    }
    if ((valueBefore && typeof valueBefore !== 'number') || typeof delta !== 'number') {
      return {code: 1, error_message: 'Not a number type: ' + dbPath};
    }
    const valueAfter = (valueBefore === undefined ? 0 : valueBefore) + delta;
    return this.setValue(dbPath, valueAfter, address, timestamp);
  }

  decValue(dbPath, delta, address, timestamp) {
    const valueBefore = this.get(dbPath);
    if (DEBUG) {
      console.log(`VALUE BEFORE:  ${JSON.stringify(valueBefore)}`);
    }
    if ((valueBefore && typeof valueBefore !== 'number') || typeof delta !== 'number') {
      return {code: 1, error_message: 'Not a number type: ' + dbPath};
    }
    const valueAfter = (valueBefore === undefined ? 0 : valueBefore) - delta;
    return this.setValue(dbPath, valueAfter, address, timestamp);
  }

  setRule(rulePath, rule, address, timestamp) {
    const parsedPath = ChainUtil.parsePath(rulePath);
    if (!this.getPermissionForRule(parsedPath, address, timestamp, rule)) {
      return {code: 2, error_message: 'No write_rule permission on: ' + rulePath};
    }
    const ruleCopy = ChainUtil.isDict(rule) ? JSON.parse(JSON.stringify(rule)) : rule;
    const fullPath = this.getFullPath(parsedPath, PredefinedDbPaths.RULES_ROOT);
    this.writeDatabase(fullPath, ruleCopy);
    return true;
  }

  setOwner(ownerPath, owner, address, timestamp) {
    const parsedPath = ChainUtil.parsePath(ownerPath);
    if (!this.getPermissionForOwner(parsedPath, address, timestamp, owner)) {
      return {code: 2, error_message: 'No write_owner permission on: ' + ownerPath};
    }
    const ownerCopy = ChainUtil.isDict(owner) ? JSON.parse(JSON.stringify(owner)) : owner;
    const fullPath = this.getFullPath(parsedPath, PredefinedDbPaths.OWNERS_ROOT);
    this.writeDatabase(fullPath, ownerCopy);
    return true;
  }

  // TODO(seo): Make this operation atomic, i.e., rolled back when it fails.
  updates(updateList, address, timestamp) {
    let ret = true;
    for (let i = 0; i < updateList.length; i++) {
      const update = updateList[i];
      if (update.type === undefined || update.type === UpdateTypes.SET_VALUE) {
        ret = this.setValue(update.ref, update.value, address, timestamp);
        if (ret !== true) {
          break;
        }
      } else if (update.type === UpdateTypes.INC_VALUE) {
        ret = this.incValue(update.ref, update.value, address, timestamp);
        if (ret !== true) {
          break;
        }
      } else if (update.type === UpdateTypes.DEC_VALUE) {
        ret = this.decValue(update.ref, update.value, address, timestamp);
        if (ret !== true) {
          break;
        }
      } else if (update.type === UpdateTypes.SET_RULE) {
        ret = this.setRule(update.ref, update.value, address, timestamp);
        if (ret !== true) {
          break;
        }
      } else if (update.type === UpdateTypes.SET_OWNER) {
        ret = this.setOwner(update.ref, update.value, address, timestamp);
        if (ret !== true) {
          break;
        }
      }
    }
    return ret;
  }

  batch(batchList, address, timestamp) {
    const resultList = [];
    batchList.forEach((item) => {
      if (item.type === OperationTypes.GET) {
        resultList
            .push(this.get(item.ref));
      } else if (item.type === OperationTypes.SET_VALUE) {
        resultList
            .push(this.setValue(item.ref, item.value, address, timestamp));
      } else if (item.type === OperationTypes.INC_VALUE) {
        resultList
            .push(this.incValue(item.ref, item.value, address, timestamp));
      } else if (item.type === OperationTypes.DEC_VALUE) {
        resultList
            .push(this.decValue(item.ref, item.value, address, timestamp));
      } else if (item.type === OperationTypes.SET_RULE) {
        resultList
            .push(this.setRule(item.ref, item.value, address, timestamp));
      } else if (item.type === OperationTypes.SET_OWNER) {
        resultList
            .push(this.setOwner(item.ref, item.value, address, timestamp));
      } else if (item.type === OperationTypes.UPDATES) {
        resultList
            .push(this.updates(item.update_list, address, timestamp));
      }
    });
    return resultList;
  }

  /**
   *  Returns full path with given root node.
   */
  getFullPath(parsedPath, root) {
    const fullPath = parsedPath.slice();
    fullPath.unshift(root);
    return fullPath;
  }

  /**
   * Returns reference to provided path for writing if exists, otherwise creates path.
   */
  getRefForWriting(parsedPath) {
    let subDb = this.db;
    parsedPath.forEach((key) => {
      if ((!ChainUtil.isDict(subDb[key])) || (!(key in subDb))) {
        subDb[key] = {};
      }
      subDb = subDb[key];
    });
    return subDb;
  }

  /**
    * Validates transaction is valid according to AIN database rules and returns a transaction instance
    *
    * @param {dict} operation - Database write operation to be converted to transaction
    * @param {boolean} isNoncedTransaction - Indicates whether transaction should include nonce or not
    * @return {Transaction} Instance of the transaction class
    */
  createTransaction(operation, isNoncedTransaction = true) {
    return Transaction.newTransaction(this, operation, isNoncedTransaction);
  }

  sign(dataHash) {
    return this.keyPair.sign(dataHash);
  }

  reconstruct(blockchain, transactionPool) {
    console.log('Reconstructing database');
    this.setDBToBackUp(blockchain.backUpDB);
    this.createDatabase(blockchain);
    this.addTransactionPool(transactionPool.validTransactions());
  }

  createDatabase(blockchain) {
    blockchain.chain.forEach((block) => {
      this.executeBlockTransactions(block);
    });
  }

  executeBlockTransactions(block) {
    block.data.forEach((tx) =>{
      this.execute(tx.operation, tx.address, tx.timestamp);
    });
  }

  addTransactionPool(transactions) {
    transactions.forEach((tx) => {
      this.execute(tx.operation, tx.address, tx.timestamp);
    });
  }

  setDBToBackUp(backUpDB) {
    if (this.publicKey === backUpDB.publicKey) {
      this.db = JSON.parse(JSON.stringify(backUpDB.db));
    }
  }

  execute(operation, address, timestamp) {
    switch (operation.type) {
      case OperationTypes.SET_VALUE:
        return this.setValue(operation.ref, operation.value, address, timestamp);
      case OperationTypes.INC_VALUE:
        return this.incValue(operation.ref, operation.value, address, timestamp);
      case OperationTypes.DEC_VALUE:
        return this.decValue(operation.ref, operation.value, address, timestamp);
      case OperationTypes.SET_RULE:
        return this.setRule(operation.ref, operation.value, address, timestamp);
      case OperationTypes.UPDATES:
        return this.updates(operation.update_list, address, timestamp);
      case OperationTypes.BATCH:
        return this.batch(operation.batch_list, address, timestamp);
    }
  }

  getPermissionForValue(dbPath, address, timestamp, permissionQuery, newValue) {
    let lastRuleSet;
    address = address || this.publicKey;
    timestamp = timestamp || Date.now();
    let rule = false;
    const wildCards = {};
    let currentRuleSet = this.db['rules'];
    let i = 0;
    do {
      if (permissionQuery in currentRuleSet) {
        rule = currentRuleSet[permissionQuery];
      }
      lastRuleSet = currentRuleSet;
      currentRuleSet = currentRuleSet[dbPath[i]];
      if (!currentRuleSet && dbPath[i]) {
        // If no rule set is available for specific key, check for wildcards
        const keys = Object.keys(lastRuleSet);
        for (let j=0; j<keys.length; j++) {
          if (keys[j].startsWith('$')) {
            wildCards[keys[j]] = dbPath[i];
            currentRuleSet = lastRuleSet[keys[j]];
          }
        }
      }
      i++;
    } while (currentRuleSet && i <= dbPath.length);

    if (typeof rule === 'string') {
      rule = this.verifyAuth(rule, wildCards, dbPath, newValue, address, timestamp);
    }

    return rule;
  }

  getPermissionForRule(dbPath, address, timestamp, permissionQuery, newValue) {
    // TODO(seo): Implement this.
    return true;
  }

  getPermissionForOwner(dbPath, address, timestamp, permissionQuery, newValue) {
    // TODO(seo): Implement this.
    return true;
  }

  static substituteWildCards(ruleString, wildCards) {
    for (const wildCard in wildCards) {
      if (ruleString.includes(wildCard)) {
        // May need to come back here to figure out how to change ALL occurrences of wildCards
        ruleString = ruleString.replace(
            new RegExp(escapeStringRegexp(wildCard), 'g'), `${wildCards[wildCard]}`);
      }
    }
    return ruleString;
  }

  verifyAuth(ruleString, wildCards, dbPath, newValue, address, timestamp) {
    if (ruleString.includes('auth')) {
      ruleString = ruleString.replace(/auth/g, `'${address}'`);
    }
    if (Object.keys(wildCards).length > 0) {
      ruleString = DB.substituteWildCards(ruleString, wildCards);
    }
    if (ruleString.includes('newData')) {
      ruleString = ruleString.replace(/newData/g, JSON.stringify(newValue));
    }
    if (ruleString.includes('currentTime')) {
      ruleString = ruleString.replace(/currentTime/g, timestamp);
    }
    if (ruleString.includes('oldData')) {
      ruleString =
        ruleString.replace(/oldData/g, this.get(dbPath.join('/')));
    }
    if (ruleString.includes('db.get')) {
      ruleString = ruleString.replace(/db.get/g, 'this.get');
    }

    const permission = eval(ruleString);
    if (!permission) {
      console.log(`Failed to get permission with rule "${ruleString}"`);
    }
    return permission;
  }
}

class BackUpDB extends DB {
  constructor(keyPair) {
    super();
    this.keyPair = keyPair;
    this.publicKey = ainUtil.toChecksumAddress(ainUtil.bufferToHex(
        ainUtil.pubToAddress(
            Buffer.from(this.keyPair.getPublic().encode('hex'), 'hex'),
            true
        )
    ));
  }
}

module.exports = DB;
