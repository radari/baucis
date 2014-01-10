// This is a Controller decorator for adding methods to manage middleware creation.

// __Dependencies__
var express = require('express');
var deco = require('deco');
var middleware = deco.require(__dirname).hash;

// __Private Module Members__

var parseActivateParameters = function (stage, params) {
  var options;
  var argumentsArray = Array.prototype.slice.call(params);

  // First, check for override.
  if (typeof argumentsArray[0] === 'boolean') {
    options = last(1, ['howMany', 'verbs', 'middleware'], argumentsArray);
    options.override = argumentsArray[0];
  }
  // Override wasn't set.
  else {
    options = last(0, ['howMany', 'verbs', 'middleware'], argumentsArray);
    options.override = false;
  }

  options.stage = stage;

  return factor(options);
}

function exists (o) { return o !== undefined && o !== null }

// Handle variable number of arguments
function last (skip, names, values) {
  var r = {};
  var position = names.length;
  var count = values.filter(exists).length - skip;

  if (count < 1) throw new Error('Too few arguments.');

  names.forEach(function (name) {
    var index = skip + count - position;
    position--;
    if (index >= skip) r[name] = values[index];
  });

  return r;
}

function isInvalidVerb (s) {
  return /^head|get|put|post|del$/.exec(s) ? false : true;
}

// Parse middleware into an array of middleware definitions for each howMany and verb
function factor (options) {
  var factored = [];
  var verbString = options.verbs;
  var verbs;

  if (verbString) verbString = verbString.toLowerCase();

  // Prevent explicitly setting query-stage POST middleware.  Implicitly adding
  // this middleware is ignored.
  if (options.override === false && options.stage === 'query'
    && verbString && verbString.indexOf('post') !== -1) throw new Error('Query stage not executed for POST.');

  if (!verbString || verbString === '*') verbString = 'head get post put del';
  verbs = verbString.split(/\s+/);

  if (!options.stage) throw new Error('Must supply stage.');
  if (verbs.some(isInvalidVerb)) throw new Error('Unrecognized verb.');
  if (options.howMany && options.howMany !== 'instance' && options.howMany !== 'collection') {
    throw new Error('Unrecognized howMany: ' + options.howMany);
  }
  // Middleware function or array
  if (!Array.isArray(options.middleware) && typeof options.middleware !== 'function') {
    throw new Error('Middleware must be an array or function.');
  }

  // Check howMany is valid
  if (options.howMany !== undefined && options.howMany !== 'instance' && options.howMany !== 'collection') {
    throw new Error('Unrecognized howMany: "' + options.howMany + '".');
  }

  verbs.forEach(function (verb) {
    // Ignore implicitly added middleware that doesn't make sense.
    if (options.override === false && options.stage === 'query' && verb === 'post') return;
    if (options.override === false && options.stage === 'query' && options.howMany === 'collection' && verb === 'put') return;
    // Add definitions for one or both `howManys`.
    if (options.howMany !== 'collection') factored.push({ stage: options.stage, howMany: 'instance', verb: verb, middleware: options.middleware, override: options.override });
    if (options.howMany !== 'instance') factored.push({ stage: options.stage, howMany: 'collection', verb: verb, middleware: options.middleware, override: options.override });
  });

  return factored;
}

// __Module Definition__
var decorator = module.exports = function () {

  // __Private Instance Members__
  var controller = this;
  var controllerForStage = {
    initial: express(),
    request: express(),
    query: express(),
    documents: express(),
    finalize: express()
  };
  var initial = controllerForStage.initial;
  var finalize = controllerForStage.finalize;

  // A method used to activate middleware for a particular stage.
  function activate (definition) {
    // If override is not set, and the verb has been turned off, ignore the middleware
    if (definition.override === false && controller.get(definition.verb) === false) return;
    var path = definition.howMany === 'instance' ? controller.get('basePathWithId') : controller.get('basePath');
    controllerForStage[definition.stage][definition.verb](path, definition.middleware);
  }

  // __Body Parsers__
  // Middleware for parsing JSON POST/PUTs
  controller.use(express.json());
  // Middleware for parsing form POST/PUTs
  controller.use(express.urlencoded());

  // __Stage Controllers__
  controller.use(controllerForStage.initial);
  controller.use(controllerForStage.request);
  controller.use(controllerForStage.query);
  controller.use(controllerForStage.documents);
  controller.use(controllerForStage.finalize);

  // __Public Instance Methods__

  // Pass the method calls through to the "initial" stage middleware controller,
  // so that it precedes all other stages and middleware that might have been
  // already added.
  controller.use = initial.use.bind(initial);
  controller.head = initial.head.bind(initial);
  var originalGet = controller.get;
  controller.get = function () {
    // When getting options set on the controller, use the original funcitonality.
    if (arguments.length === 1) return originalGet.apply(controller, arguments);
    // Otherwise set get middleware on initial.
    else return initial.get.apply(initial, arguments);
  };
  controller.post = initial.post.bind(initial);
  controller.put = initial.put.bind(initial);
  controller.del = initial.del.bind(initial);
  controller.delete = initial.delete.bind(initial);

  // A method used to activate request-stage middleware.
  controller.request = function (override, howMany, verbs, middleware) {
    var definitions = parseActivateParameters('request', arguments);
    definitions.forEach(activate);
    return controller;
  };

  // A method used to activate query-stage middleware.
  controller.query = function (override, howMany, verbs, middleware) {
    var definitions = parseActivateParameters('query', arguments);
    definitions.forEach(activate);
    return controller;
  };

  // A method used to activate document-stage middleware.
  controller.documents = function (override, howMany, verbs, middleware) {
    var definitions = parseActivateParameters('documents', arguments);
    definitions.forEach(activate);
    return controller;
  };

  Object.keys(controllerForStage).forEach(function (stage) {
    controllerForStage[stage].disable('x-powered-by');
  });

  // Order is important so can't use deco.call
  var decorators = [
    // __Request-Stage Middleware__
    // Initialize baucis state
    middleware.initialize,
    // Activate middleware to check for deprecated features
    middleware.deprecated,
    // Activate middleware that sets the Allow & Accept headers
    middleware.allowHeader,
    middleware.acceptHeader,
    // Activate middleware that checks for correct Mongo _ids when applicable
    middleware.validateId,
    // Activate middleware that checks for disabled HTTP methods
    middleware.checkMethodSupported,
    // Activate middleware to set request.baucis.conditions
    middleware.setConditions,

    // __Query-Stage Middleware__
    // The query will have been created (except for POST, which doesn't use a
    // find or remove query).

    // Activate middleware to build the query (except for POST requests).
    middleware.buildQuery,
    // Activate middleware to handle controller and query options.
    middleware.applyControllerOptions,
    middleware.applyQueryString,

    // __Document-Stage Middleware__

    // Activate middleware to execute the query.
    middleware.execute,
    // Activate some middleware that will set the Link header when that feature
    // is enabled.  (This must come after exec or else the count is
    // returned for all subsequqent executions of the query.)
    middleware.linkHeader,
    // Activate the middleware that sets the `Last-Modified` header when appropriate.
    middleware.lastModified
  ];

  // Activate the middleware that sends the final document(s) or count.
  middleware.send.call(finalize);

  return deco.call(controller, decorators);
};
