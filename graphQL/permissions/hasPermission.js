import {
  isArray,
  union,
  isEqual,
  pick,
  chain,
  difference,
  flatten,
} from 'lodash';

// Check if user has a certain permission for type
//
// Returns object with fields 'hasPermission' and 'errors', latter only if
// there are any errors
//
// First check if user has a global type permission and if not, whether
// there is a connection that grants him permission. Also checks
// for permissions of related objects if applicable
export default async function hasPermission(
  typeName,
  permission,
  oldObject = {},
  newObject = {},
  {
    rootValue: {
      db,
      credentials,
      permissions: {
        type: permissionsByType,
        connection: permissionsByConnection,
        related: relatedPermissionsByType,
      },
    },
  },
) {
  const { isAdmin, userID: id } = credentials;
  const userID = id && id.value;

  if (isAdmin) {
    return {
      hasPermission: true,
    };
  }

  const connectionFields = relatedPermissionsByType[typeName] || [];

  // actual permission name
  let permissionName = permission;
  // object to check permissions through
  let object = newObject;
  // fields to check or a full permission
  let fields;
  // list of related permissions that need to be checked
  let otherTypePermissions = [];

  if (permission === 'create') {
    object = newObject;
    fields = Object.keys(
      pick(newObject, (value, key) => value && key !== '_id')
    );
    otherTypePermissions = connectionFields
      .filter((field) => field.name in object)
      .map((field) => fieldToExtraPermissions(
        field,
        object,
        db,
        permissionsByType,
        permissionsByConnection,
        userID,
      ));
  } else if (permission === 'update') {
    object = {
      ...oldObject,
      ...newObject,
    };
    fields = Object.keys(
      pick(newObject, (value, key) => value && key !== '_id')
    );
    otherTypePermissions = chain(connectionFields)
      .map((field) => {
        const oldValue = oldObject[field.name];
        const newValue = newObject[field.name];
        const extras = [];
        if (!isEqual(oldValue, newValue)) {
          if (oldValue && field.name in newObject) {
            extras.push(
              fieldToExtraPermissions(
                field,
                oldObject,
                db,
                permissionsByType,
                permissionsByConnection,
                userID,
              )
            );
          }
          if (newValue) {
            extras.push(
              fieldToExtraPermissions(
                field,
                newObject,
                db,
                permissionsByType,
                permissionsByConnection,
                userID,
              )
            );
          }
        }
        return extras;
      })
      .flatten()
      .value();
  } else if (permission === 'replace') {
    permissionName = 'update';
    fields = Object.keys(
      pick({
        ...oldObject,
        ...newObject,
      }, (value, key) => value && key !== '_id')
    );
    otherTypePermissions = chain(connectionFields)
      .map((field) => {
        const oldValue = oldObject[field.name];
        const newValue = newObject[field.name];
        const extras = [];
        if (!isEqual(oldValue, newValue)) {
          if (oldValue) {
            extras.push(
              fieldToExtraPermissions(
                field,
                oldObject,
                db,
                permissionsByType,
                permissionsByConnection,
                userID,
              )
            );
          }
          if (newValue) {
            extras.push(
              fieldToExtraPermissions(
                field,
                newObject,
                db,
                permissionsByType,
                permissionsByConnection,
                userID,
              )
            );
          }
        }
        return extras;
      })
      .flatten()
      .value();
  } else if (permission === 'delete') {
    object = oldObject;
    otherTypePermissions = connectionFields
      .filter((field) => (
        field.connectionType === 'MANY_TO_ONE' ||
        field.name in object
      ))
      .map((field) => fieldToExtraPermissions(
        field,
        object,
        db,
        permissionsByType,
        permissionsByConnection,
        userID,
      ));
  }

  if (fields) {
    fields = fields.sort();
  }

  otherTypePermissions = flatten(await Promise.all(otherTypePermissions));

  const results = await Promise.all([
    reportError(hasPermissionsForThisType(
      db,
      permissionsByType,
      permissionsByConnection,
      permissionName,
      fields,
      userID,
      typeName,
      Promise.resolve(object),
    ), typeName, permission, fields),
    ...otherTypePermissions,
  ]);

  const result = results.reduce((acc, next) => ({
    hasPermission: acc.hasPermission && next.hasPermission,
    errors: acc.errors.concat(next.errors || []),
  }), {
    hasPermission: true,
    errors: [],
  });

  if (result.hasPermission) {
    return {
      hasPermission: result.hasPermission,
    };
  } else {
    return result;
  }
}

async function hasPermissionsForThisType(
  db,
  permissionsByType,
  permissionsByConnection,
  permission,
  fields,
  userID,
  type,
  objectPromise
) {
  const typePermission = hasTypePermissions(
    permissionsByType,
    permission,
    fields,
    type,
    userID
  );

  if (typePermission) {
    return true;
  } else {
    const object = await objectPromise;
    return await hasConnectionPermissions(
      db,
      permissionsByConnection,
      permission,
      fields,
      object,
      type,
      userID,
    );
  }
}

function hasTypePermissions(permissions, permission, fields, type, userID) {
  const typePermissions = permissions[type] || {};

  return (
    userID && hasPermissionFromPermissionSet(
      typePermissions.AUTHENTICATED,
      permission,
      fields,
    )
  ) || (
    hasPermissionFromPermissionSet(
      typePermissions.EVERYONE,
      permission,
      fields,
    )
  );
}

async function hasConnectionPermissions(
  db,
  permissions,
  permission,
  fields,
  object,
  type,
  userID
) {
  if (!userID) {
    return false;
  }

  const validConnections = (permissions[type] || []).filter((connection) => {
    if (fields) {
      return (
        connection[permission] &&
        (
          !connection.permittedFields ||
          connection.permittedFields.some((field) =>
            fields.includes(field)
          )
        )
      );
    } else {
      return connection[permission];
    }
  });

  let permittedFields = [];
  for (const connection of validConnections) {
    const isConnectedToUser = await hasOneConnectionPermission(
      db,
      connection.path,
      object,
      userID
    );
    if (isConnectedToUser) {
      let hasEnoughPermissions;
      if (connection.permittedFields) {
        permittedFields = union(permittedFields, connection.permittedFields);
        hasEnoughPermissions = hasPermissionFromPermissionSet(
          {
            ...connection,
            permittedFields,
          },
          permission,
          fields
        );
      } else {
        hasEnoughPermissions = hasPermissionFromPermissionSet(
          connection,
          permission,
          fields
        );
      }
      if (hasEnoughPermissions) {
        return true;
      }
    }
  }

  return false;
}

function hasPermissionFromPermissionSet(permissionSet, permission, fields) {
  if (!permissionSet) {
    return false;
  }

  const hasBasePermission = permissionSet[permission];

  if (hasBasePermission && fields) {
    if (permissionSet.permittedFields) {
      return difference(
        union(permissionSet.permittedFields, fields),
        permissionSet.permittedFields,
      ).length === 0;
    }
  }

  return hasBasePermission;
}

async function reportError(hasPermissionPromise, type, permission, fields) {
  const result = await hasPermissionPromise;
  if (!result) {
    let error;
    if (fields) {
      const fieldList = fields.map(
        (fieldName) => `\`${fieldName}\``
      );
      error = (
        `User lacks permissions to ${permission} nodes of type \`${type}\` ` +
        `with fields ${fieldList.join(', ')}.`
      );
    } else {
      error =
`User lacks permissions to ${permission} nodes of type \`${type}\`.`;
    }
    return {
      hasPermission: false,
      errors: [error],
    };
  } else {
    return {
      hasPermission: true,
    };
  }
}

async function fieldToExtraPermissions(
  field,
  object,
  db,
  permissionsByType,
  permissionsByConnection,
  userID,
) {
  if (field.connectionType === 'ONE_TO_MANY') {
    return [reportError(
      hasPermissionsForThisType(
        db,
        permissionsByType,
        permissionsByConnection,
        'update',
        [field.reverseName],
        userID,
        field.type,
        db.getByID(field.type, object[field.name]),
      ),
      field.type,
      'update',
      [field.reverseName]
    )];
  } else if (field.connectionType === 'MANY_TO_ONE') {
    const objects = await db.getAllByFilter(field.type, {
      [field.reverseName]: object.id,
    });
    return objects.map((related) => reportError(
      hasPermissionsForThisType(
        db,
        permissionsByType,
        permissionsByConnection,
        'update',
        [field.reverseName],
        userID,
        field.type,
        Promise.resolve(related),
      ),
      field.type,
      'update',
      [field.reverseName]
    ));
  } else if (field.connectionType === 'MANY_TO_MANY') {
    const ids = object[field.name];
    return ids.map((id) => reportError(
      hasPermissionsForThisType(
        db,
        permissionsByType,
        permissionsByConnection,
        'update',
        [field.reverseName],
        userID,
        field.type,
        db.getByID(field.type, id),
      ),
      field.type,
      'update',
      [field.reverseName]
    ));
  }
}

async function hasOneConnectionPermission(
  db,
  path,
  object,
  userID
) {
  let currentObject = object;
  while (path.length > 1) {
    let segment;
    [segment, ...path] = path;
    const pathValue = currentObject[segment.name];
    if (segment.connectionType !== 'ONE_TO_MANY') {
      const objects = await db.getAllByFilter(segment.type, {
        [segment.reverseName]: object.id,
      });
      for (const relatedObject of objects) {
        const permission = await hasOneConnectionPermission(
          db,
          path,
          relatedObject,
          userID,
        );
        if (permission) {
          return permission;
        }
      }
      return false;
    } else if (pathValue) {
      currentObject = await db.getByID(segment.type, pathValue);
    } else {
      currentObject = null;
    }
  }

  const lastSegment = path[0];
  const value = currentObject && currentObject[lastSegment.name];

  if (lastSegment.connectionType === 'MANY_TO_MANY' && isArray(value)) {
    return value.some((id) => id.value === userID);
  } else if (lastSegment.connectionType === 'MANY_TO_ONE') {
    return await db.hasByFilter('User', {
      id: {
        type: 'User',
        value: userID,
      },
      [lastSegment.reverseName]: object.id,
    });
  } else if (value) {
    return value.value === userID;
  } else {
    return false;
  }
}
