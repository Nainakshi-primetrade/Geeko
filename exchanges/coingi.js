let Coingi = require('coingi');
let moment = require('moment');
let lodash = require('lodash');

let util = require('../core/util');
let Errors = require('../core/error');
let log = require('../core/log');


let trader = function (config) {
  	lodash.bindAll(this);

  	if (lodash.isObject(config)) {
  
    	this.key = config.key;
    	this.secret = config.secret;
    	
    	this.currency = config.currency;
    	this.currency.toUpperCase();
    
    	this.asset = config.asset.toUpperCase();
    	this.asset.toUpperCase();
  	}

  	this.pair = this.asset + "-" + this.currency;
  	this.name = 'coingi';
  	this.since = null;

  	this.coingi = new Coingi(this.key,this.secret,{timeout: +moment.duration(60, 'seconds')});
}


let retryCritical = {retries: 10,factor: 1.2,minTimeout: 1000,maxTimeout: 30000};

let retryForever = {forever: true,factor: 1.2,minTimeout: 10,maxTimeout: 30};

let recoverableErrors = new RegExp(/(SOCKETTIMEDOUT|TIMEDOUT|CONNRESET|CONNREFUSED|NOTFOUND|API:Invalid nonce|Service:Unavailable|Request timed out|Response code 520|Response code 504|Response code 502)/);


trader.prototype.processError = function (funcName, error) {
  	if (!error)
    	return undefined;

  	if (!error.message.match(recoverableErrors)) {
    	log.error(`[coingi.js] (${funcName}) returned an irrecoverable error: ${error.message}`);
    	return new Errors.AbortError('[coingi.js] ' + error.message);
  	}

  	log.debug(`[coingi.js] (${funcName}) returned an error, retrying: ${error.message}`);
  	return new Errors.RetryError('[coingi.js] ' + error.message);
};

trader.prototype.handleResponse = function(funcName , callback){

	return (error, body) => {
    if (!error) {
      	error = lodash.isEmpty(body) ?  new Error('NO DATA WAS RETURNED') : new Error(body.error);
    }

    return callback(this.processError(funcName, error), body);
  }	
};

trader.prototype.getTicker = function (callback) {
  	let setTicker = function (err, data) {
    	if (err)
      		return callback(err);

    	let ticker = {ask: data.asks[0].price,bid: data.bids[0].price};
    
    	callback(undefined, ticker);
  	};

  	let handler = (cb) => this.coingi.api('order-book', "/" + this.pair + "/1/1/1", this.handleResponse('getTicker', cb));
  	util.retryCustom(retryForever, _.bind(handler, this), _.bind(setTicker, this));
};


trader.prototype.getFee = function (callback) {
  	callback(undefined, 0.002);
};

trader.prototype.getPortfolio = function(callback){

	let setBalance = function(err, data){
	
		if(err)
			return callback(err);
		
		log.debug('[coingi.js] entering "setBalance callback after coingi-api call, data:', data);
		
		let portfolio = [];
		for(let i=0; i<data.length; i++){
			portfolio.push({name: data[i].currency.name.toUpperCase(),amount: data[i].availale});
		}
		return callback(undefined, portfolio);
	};
	
	let handler =  (cb) => this.coingi.api('balance', {currencies: this.asset + ","	 +this.currency}, this.handleResponse('getPortfolio', cb));
	util.retryCustom(retryForever, _.bind(handler, this), _.bind(setBalance, this));
	
};	


trader.prototype.getTrades = function (since, callback, ascending) {
  	let startTs = since ? moment(since).valueOf() : null;

  	let processResults = function (err, trades) {
    	if (err) {
      		return callback(err);
    	}

    let parsedTrades = [];
    lodash.each(trades, function (trade) {
      	if (_.isNull(startTs) || startTs < moment(trade.timestamp).valueOf()) {
        	parsedTrades.push({
          		type: trade.type === 0 ? "sell" : "buy",
          		date: moment(trade.timestamp).unix(),
          		amount: String(trade.amount),
          		price: String(trade.price),
          		tid: trade.timestamp
        	});
      	}
    }, this);
	
	ascending ? callback(undefined, parsedTrades) : callback(undefined, parsedTrades.reverse()) ;
    
  	};

	var optionalSince = "";
  	if (since) {
    	optionalSince = "/" + startTs;
  	}

  	let handler = (cb) => this.coingi.api('transactions', "/" + this.pair + "/512" + optionalSince, this.handleResponse('getTrades', cb));
  	util.retryCustom(retryForever, _.bind(handler, this), _.bind(processResults, this));
};


trader.prototype.addOrder = function (tradeType, amount, price, callback) {
  	log.debug('[coingi.js] (add-order)', tradeType.toUpperCase(), amount, this.asset, '@', price, this.currency);

  	var setOrder = function (err, data) {
    	if (err)
      		return callback(err);

    	var uuid = data.result;
    	log.debug('[coingi.js] (addOrder) added order with uuid:', uuid);

    	callback(undefined, uuid);
  	};

  	let reqData = {currencyPair: this.pair,type: tradeType.toLowerCase() === "sell" ? 0 : 1,price: price,volume: amount.toString()};

  	let handler = (cb) => this.coingi.api('add-order', reqData, this.handleResponse('addOrder', cb));
  	util.retryCustom(retryCritical, _.bind(handler, this), _.bind(setOrder, this));
};


trader.prototype.getOrder = function (orderId, callback) {
  	var getOrder = function (err, order) {
    	if (err)
      		return callback(err);

    	if (order !== null) {
      		const price = parseFloat(order.price);
      		const amount = parseFloat(order.baseAmount);
      		const date = moment.unix(order.timestamp);
      		callback(undefined, {price, amount, date});
    	} 
    	
    	else {
      		log.error("Error! Order ID '" + orderId + "' couldn't be found in the result of get order!");
    	}
  	};

  	let reqData = {ordeId: orderId};
  	let handler = (cb) => this.coingi.api('get-order', reqData, this.handleResponse('getOrder', cb));
  	util.retryCustom(retryCritical, _.bind(handler, this), _.bind(getOrder, this));
};


trader.prototype.buy = function (amount, price, callback) {
  	this.addOrder('buy', amount, price, callback);
};


trader.prototype.sell = function (amount, price, callback) {
  	this.addOrder('sell', amount, price, callback);
};


trader.prototype.checkOrder = function (orderId, callback) {
  	var check = function (err, order) {
    	if (err)
      		return callback(err);

    	if (order === null) {
      		log.error("Error! Order ID '" + orderId + "' couldn't be found in the result of get order!");
    	}
    
    	callback(undefined, order !== null && order.status === 2);
 	};

  	let reqData = {orderId: orderId};
  	let handler = (cb) => this.coingi.api('get-order', reqData, this.handleResponse('checkOrder', cb));
  	util.retryCustom(retryCritical, _.bind(handler, this), _.bind(check, this));
};


trader.prototype.cancelOrder = function (order, callback) {
  	let reqData = {orderId: order};
  	let handler = (cb) => this.coingi.api('cancel-order', reqData, this.handleResponse('cancelOrder', cb));
  	util.retryCustom(retryForever, _.bind(handler, this), callback);
};

trader.getCapabilities = function () {
  	return {
    	name: 'Coingi',
    	slug: 'coingi',
    	currencies: ['EUR', 'USD', 'BTC'],
    	assets: ['BTC', 'DASH', 'DOGE', 'EUR', 'LTC', 'NMC', 'PPC', 'VTC'],
    	markets: [
      		{pair: ['USD', 'BTC'], minimalOrder: {amount: 0.00001, unit: 'asset'}, precision: 8},
      		{pair: ['EUR', 'BTC'], minimalOrder: {amount: 0.00001, unit: 'asset'}, precision: 8},

     
      		{pair: ['BTC', 'DASH'], minimalOrder: {amount: 0.00001, unit: 'asset'}, precision: 8},

      
      		{pair: ['BTC', 'DOGE'], minimalOrder: {amount: 0.00001, unit: 'asset'}, precision: 8},
      		{pair: ['USD', 'DOGE'], minimalOrder: {amount: 0.00001, unit: 'asset'}, precision: 8},

      
      		{pair: ['USD', 'EUR'], minimalOrder: {amount: 0.01, unit: 'asset'}, precision: 2},

      
      		{pair: ['BTC', 'LTC'], minimalOrder: {amount: 0.00001, unit: 'asset'}, precision: 8},
      		{pair: ['EUR', 'LTC'], minimalOrder: {amount: 0.00001, unit: 'asset'}, precision: 8},
      		{pair: ['USD', 'LTC'], minimalOrder: {amount: 0.00001, unit: 'asset'}, precision: 8},

      
      		{pair: ['BTC', 'NMC'], minimalOrder: {amount: 0.00001, unit: 'asset'}, precision: 8},


      		{pair: ['USD', 'PPC'], minimalOrder: {amount: 0.00001, unit: 'asset'}, precision: 8},
      		{pair: ['EUR', 'PPC'], minimalOrder: {amount: 0.00001, unit: 'asset'}, precision: 8},
      		{pair: ['BTC', 'PPC'], minimalOrder: {amount: 0.00001, unit: 'asset'}, precision: 8},


	
      		{pair: ['BTC', 'VTC'], minimalOrder: {amount: 0.00001, unit: 'asset'}, precision: 8}
    	],
    
    	requires: ['key', 'secret'],
    	providesHistory: 'date',
   	 	providesFullHistory: true,
    	exchangeMaxHistoryAge: 30,
    	tid: 'date',
    	tradable: true
  	};
}

module.exports = trader;


