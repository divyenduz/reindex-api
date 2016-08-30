import { chain } from 'lodash';
import {
  GraphQLObjectType,
  GraphQLNonNull,
  GraphQLList,
} from 'graphql';

import TypeSet from './TypeSet';
import ScalarTypes from './builtins/ScalarTypes';
import {
  createConnectionArguments,
  createConnectionFieldResolve,
  createNodeFieldResolve,
 } from './connections';

export default function createTypesFromReindexSchema(
  typeRegistry,
  typesMetadata,
  indexesByType,
  hooksByType,
) {
  return typesMetadata.map((typeMetadata) => {
    const kind = typeMetadata.kind;
    if (kind === 'OBJECT') {
      const type = createObjectType(typeMetadata, typeRegistry);
      return new TypeSet({
        type,
        pluralName: typeMetadata.pluralName,
        orderableFields: chain(typeMetadata.fields)
          .filter((field) => field.orderable)
          .map((field) => field.name)
          .value(),
        filterableFields: getFilterableFields(typesMetadata, typeMetadata),
        indexes: hooksByType[type.name],
        hooks: hooksByType[type.name],
        permissions: typeMetadata.permissions,
      });
    }
  });
}

function createObjectType(type, typeRegistry) {
  const config = {
    name: type.name,
    description: type.description || null,
    fields: () => chain(type.fields)
      .map((field) => createField(field, typeRegistry))
      .indexBy((field) => field.name)
      .value(),
    interfaces: type.interfaces.map((name) => typeRegistry.getInterface(name)),
  };
  if (config.interfaces.includes(typeRegistry.getInterface('Node'))) {
    config.isTypeOf = (value) => value.id && value.id.type === type.name;
  }

  return new GraphQLObjectType(config);
}

function createField(field, typeRegistry) {
  const fieldName = field.name;
  const fieldType = field.type;

  let type;
  let resolve;
  let argDef = {};
  if (fieldType === 'Connection') {
    const ofType = field.ofType;
    const reverseName = field.reverseName;
    const defaultOrdering = field.defaultOrdering || {};
    type = typeRegistry.getTypeSet(ofType).connection;
    argDef = createConnectionArguments(ofType, typeRegistry);
    resolve = createConnectionFieldResolve(
      ofType, reverseName, defaultOrdering, typeRegistry
    );
  } else if (fieldType === 'List') {
    const innerType = (
      ScalarTypes[field.ofType] || typeRegistry.getTypeSet(field.ofType).type
    );
    type = new GraphQLList(innerType);
  } else if (fieldType in ScalarTypes) {
    type = ScalarTypes[fieldType];
  } else {
    type = typeRegistry.getTypeSet(fieldType).type;
    if (type.getInterfaces().includes(typeRegistry.getInterface('Node'))) {
      resolve = createNodeFieldResolve(type.name, fieldName);
    } else {
      resolve = (parent) => {
        if (parent[fieldName]) {
          return {
            ...parent[fieldName],
            __node: parent.__node || parent,
          };
        } else {
          return null;
        }
      };
    }
  }

  if (field.nonNull) {
    type = new GraphQLNonNull(type);
  }

  return {
    name: fieldName,
    type,
    args: argDef,
    resolve,
    deprecationReason: field.deprecationReason || null,
    description: field.description || null,
    metadata: {
      ...field,
    },
  };
}


function getFilterableFields(types, type) {
  return chain(type.fields)
    .map((field) => {
      if (field.name !== 'id' && (
          field.filterable ||
          field.unique ||
          field.type === 'Connection' ||
          field.type !== 'Connection' && field.reverseName
      )) {
        return [
          field,
        ];
      } else if (!ScalarTypes[field.type]) {
        const newType = types.find((otherType) =>
          otherType.name === field.type
        );
        if (newType) {
          return getFilterableFields(types, newType)
            .map((nestedField) => ({
              ...nestedField,
              name: `${field.name}__${nestedField.name}`,
            }));
        } else {
          return [];
        }
      } else {
        return [];
      }
    })
    .flatten()
    .value();
}
