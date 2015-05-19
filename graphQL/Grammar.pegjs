{
  var Map = require('immutable').Map;
  var List = require('immutable').List;
  var AST = require('./AST');
}

start
  = ws? call:call_property
    {
      return new AST.GQLRoot({
        name: call.name,
        parameters: call.parameters || Map(),
        children: call.children || List()
      });
    }

call_parameters
  = ws? '(' ws? call_parameters:parameter_list? ')'
    {
      return call_parameters;
    }

parameter_list
  = parameter_list:(
      first:parameter
      rest:(ws? property_separator ws? p:parameter { return p })*
      ws?
      { return first.merge.apply(first, rest); }
    )
    {
      return parameter_list;
    }

parameter
  = name:identifier ws? ':' ws? parameter:[a-zA-Z0-9_=-]+
    {
      return Map().set(name, parameter.join(''));
    }

block
  = ws? '{' ws? children:children? ws? '}' ws?
    {
      return children || [];
    }

children
  = children:(
      first:property
      rest:(property_separator ws? p:property { return p })*
      {
        return [first].concat(rest);
      }
    )
    {
      return children;
    }

property
  = call_property
  / object_property
  / simple_property

simple_property
  = name:identifier ws?
    {
      return new AST.GQLLeaf({
        name: name
      });
    }

object_property
  = name:identifier children:block
    {
      return new AST.GQLNode({
        name: name,
        children: List(children)
      });
    }

call_property
  = name:identifier parameters:call_parameters children:block?
    {
      return new AST.GQLNode({
        name: name,
        parameters: parameters,
        children: List(children)
      });
    }

property_separator
  = ','

identifier
  = prefix:[a-zA-Z\$] suffix:[a-zA-z0-9_]*
    {
      return prefix + suffix.join('');
    }

ws 'whitespace'
  = [ \t\n\r]*